import "server-only";
import { z } from "zod";
import { db } from "../db/client";
import { assertCourse, getDocument } from "../documents/service";
import { NotFoundError } from "../services/academic";
import { getLearningTopicStates } from "../learning/service";
import { normalizeTopicName } from "../learning/normalization";
import { AgentExecutor } from "../agents/executor";
import { collectExecutionSources, validateSourceIndices } from "../agents/executor/sources";
import { executeStructuredNotes } from "../agents/notes/structured";
import type { AgentSource } from "../agents/types";
import type { QuizAgentService } from "../agents/quiz/service";
import type { ContextReadCache } from "../context/cache";
import { workflowIdentity } from "./engine";
import { WorkflowError } from "./errors";
import { lectureState } from "./lecture-study";
import { LECTURE_CONFIG, lectureLearningState, lectureStudySettings, selectLectureTargets, summarizeLecture } from "./lecture-policy";
import type { LectureState } from "./lecture-policy";
import type { StepInput, StepOutput, WorkflowContext, WorkflowStep } from "./types";
const id = z.string().min(1).max(100);
export const lectureInputSchema = z.object({
  workflowId: z.literal("lecture-study"), goal: z.string().trim().min(3).max(1000), courseId: id.optional(),
  documentId: id.optional(), documentIds: z.array(id).min(1).max(LECTURE_CONFIG.maximumDocuments).optional(),
  topicFocus: z.string().trim().min(1).max(120).optional(), difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  mode: z.enum(["quick-review", "standard-study", "deep-study"]).optional(), availableMinutes: z.number().int().min(1).max(480).optional(),
}).strict();

export async function validateLectureScope(context: Readonly<WorkflowContext>, userId: string) {
  const state = lectureState(context);
  try {
    await assertCourse(userId, context.courseId);
    for (const selected of state.documents) {
      const doc = await getDocument(userId, selected.id);
      if (doc.courseId !== context.courseId) throw new WorkflowError("REFERENCE_NOT_FOUND");
      if (doc.processingStatus !== "READY") throw new WorkflowError("DOCUMENT_NOT_READY");
      if (doc.updatedAt.toISOString() !== selected.updatedAt) throw new WorkflowError("DOCUMENT_CHANGED");
    }
  } catch (error) { if (error instanceof NotFoundError) throw new WorkflowError("REFERENCE_NOT_FOUND"); throw error; }
}
export async function initialLectureContext(input: z.infer<typeof lectureInputSchema>, headers: Headers): Promise<WorkflowContext> {
  const { userId } = await workflowIdentity(headers);
  if (input.documentId && input.documentIds) throw new WorkflowError("INVALID_REQUEST");
  const documentIds = [...new Set(input.documentIds ?? (input.documentId ? [input.documentId] : []))].sort();
  if (!documentIds.length) throw new WorkflowError("DOCUMENT_REQUIRED");
  let documents;
  try { documents = await Promise.all(documentIds.map((id) => getDocument(userId, id))); }
  catch (error) { if (error instanceof NotFoundError) throw new WorkflowError("REFERENCE_NOT_FOUND"); throw error; }
  const courseId = input.courseId ?? documents[0].courseId;
  if (!courseId || documents.some((doc) => doc.courseId !== courseId)) throw new WorkflowError("REFERENCE_NOT_FOUND");
  const settings = lectureStudySettings(input);
  const context: WorkflowContext = { goal: input.goal, courseId, documentIds,
    priorities: [], topics: [], studyPlanId: null, planCurrent: false, quizId: null, quizCurrent: false, quizMode: "practice", tutorTopic: null, targetTopics: [], previousStepSummaries: [],
    lecture: { ...settings, documents: documents.map((d) => ({ id: d.id, title: d.title, pageCount: d.pageCount, updatedAt: d.updatedAt.toISOString() })),
      topicFocus: input.topicFocus, requestedDifficulty: input.difficulty, concepts: [], tutorTargets: [], practiceTopics: [], learningBefore: [], sources: [], quiz: null, summary: null } };
  await validateLectureScope(context, userId);
  return context;
}

/** Verify one complete owned attempt, never pooled answers from different sessions. */
export async function validateLectureAttempt(context: Readonly<WorkflowContext>, userId: string, attemptId: string, requireComplete = true) {
  await validateLectureScope(context, userId);
  const state = lectureState(context);
  if (!state.quiz || context.waitingFor?.referenceId !== state.quiz.id) throw new WorkflowError("INVALID_REQUEST");
  const attempt = await db().quizAttempt.findFirst({ where: { id: attemptId, userId, quizId: state.quiz.id, quiz: { userId, courseId: context.courseId, course: { userId } } },
    select: { id: true, completedAt: true, questionAttempts: { select: { questionId: true, userId: true, score: true, isCorrect: true } },
      quiz: { select: { questions: { select: { id: true, userId: true, topicMappings: { select: { userId: true, topicId: true, topic: { select: { name: true, userId: true, courseId: true } } } } } } } } } });
  if (!attempt) throw new WorkflowError("REFERENCE_NOT_FOUND");
  const allowed = new Set(state.practiceTopics.map(normalizeTopicName));
  if (attempt.quiz.questions.length !== state.quiz.questionCount || attempt.quiz.questions.some((q) => q.userId !== userId || !q.topicMappings.length || q.topicMappings.some((m) => m.userId !== userId || m.topic.userId !== userId || m.topic.courseId !== context.courseId || !allowed.has(normalizeTopicName(m.topic.name))))) throw new WorkflowError("REFERENCE_NOT_FOUND");
  if (attempt.questionAttempts.some((a) => a.userId !== userId)) throw new WorkflowError("REFERENCE_NOT_FOUND");
  if (requireComplete && (!attempt.completedAt || attempt.quiz.questions.some((q) => !attempt.questionAttempts.some((a) => a.questionId === q.id)))) throw new WorkflowError("QUIZ_INCOMPLETE");
  return attempt;
}
function addSources(state: LectureState, sources: readonly AgentSource[], documentIds: readonly string[]) {
  if (!sources.length || sources.some((s) => !documentIds.includes(s.documentId))) throw new WorkflowError("SOURCE_CONTEXT_UNAVAILABLE");
  return sources.map((source) => {
    const id = `${source.documentId}:${source.chunkIndex}:${source.pageNumber ?? "n"}:${source.pageEnd ?? "n"}`;
    if (!state.sources.some((s) => s.id === id)) state.sources.push({ ...source, id });
    return id;
  });
}
const tutorSchema = z.object({ explanations: z.array(z.object({ topic: z.string().trim().min(1).max(120), explanation: z.string().trim().min(1).max(3500), workedExample: z.string().trim().min(1).max(3000), understandingCheck: z.string().trim().min(1).max(600), sourceIndices: z.array(z.number().int().min(0)).min(1).max(5) }).strict()).min(1).max(3) }).strict();
export class LectureWorkflowAdapter {
  constructor(private readonly executor: AgentExecutor, private readonly quiz: QuizAgentService, private readonly cache: ContextReadCache) {}
  async execute(step: WorkflowStep, input: StepInput, context: Readonly<WorkflowContext>, headers: Headers): Promise<StepOutput> {
    const { userId } = await workflowIdentity(headers);
    await validateLectureScope(context, userId);
    const state = structuredClone(lectureState(context));
    const documentIds = context.documentIds!;
    if (step.agentId === "notes") {
      const notes = await executeStructuredNotes(this.executor, { agentId: "notes", courseId: context.courseId, documentIds, request: input.request }, headers,
        { detail: LECTURE_CONFIG.modes[state.mode].detail, maximumConcepts: LECTURE_CONFIG.maximumConcepts, reviewMinutes: state.effort.notesMinutes, focus: state.topicFocus });
      if (!notes.data.focusCovered) throw new WorkflowError("SOURCE_CONTEXT_UNAVAILABLE");
      const sourceRefs = addSources(state, notes.sources, documentIds);
      state.concepts = notes.data.concepts.map((c) => ({ topic: c.topic, keyIdea: c.keyIdea, complexity: c.complexity, sourceRefs: c.sourceIndices.map((i) => sourceRefs[i]) }));
      const relevant = new Set(notes.data.topics.map(normalizeTopicName));
      state.learningBefore = (await getLearningTopicStates({ userId, courseId: context.courseId })).filter((t) => relevant.has(normalizeTopicName(t.topic))).map(lectureLearningState);
      const targets = selectLectureTargets(state); state.tutorTargets = targets.tutorTargets; state.practiceTopics = targets.practiceTopics;
      if (!state.tutorTargets.length) { state.effort.totalMinutes -= state.effort.tutorMinutes; state.effort.tutorMinutes = 0; }
      return { summary: `Created ${state.mode} notes for ${state.concepts.length} lecture concepts.`, patch: { lecture: state },
        data: { title: notes.data.title, topics: notes.data.topics, concepts: notes.data.concepts.map(({ sourceIndices, ...c }) => ({ ...c, sourceRefs: sourceIndices.map((i) => sourceRefs[i]) })), estimatedMinutes: state.effort.notesMinutes } };
    }
    if (step.agentId === "tutor") {
      const execution = await this.executor.executeStructured({ agentId: "tutor", request: input.request, courseId: context.courseId, documentIds }, headers, {
        schemaName: "lecture_explanation", schema: tutorSchema, maxOutputTokens: state.mode === "deep-study" ? 6000 : 3500, requireDocumentSources: true,
        contextOverrides: { limits: { documents: 10, maxCharacters: 40000 } },
        referenceData: JSON.stringify({ concepts: state.concepts.filter((c) => state.tutorTargets.includes(c.topic)).map(({ topic, keyIdea }) => ({ topic, keyIdea })), learning: state.learningBefore.filter((t) => state.tutorTargets.includes(t.topic)), mode: state.mode, estimatedMinutes: state.effort.tutorMinutes }),
        buildDirective: (c) => JSON.stringify({ targets: state.tutorTargets, guidance: "Explain the targeted concepts, not the entire lecture. Use course definitions and actual retrieved passages for examples. Reference Notes key ideas as a starting point; verify details against sources. Write citations only as zero-based sourceIndices, never invented titles/pages in prose.", sourceCatalog: collectExecutionSources(c) }),
      });
      const explanations = execution.structuredData?.explanations;
      if (!explanations || explanations.length !== state.tutorTargets.length || new Set(explanations.map((e) => normalizeTopicName(e.topic))).size !== explanations.length || explanations.some((e) => !state.tutorTargets.some((t) => normalizeTopicName(t) === normalizeTopicName(e.topic)))) throw new WorkflowError("INVALID_RESPONSE");
      const sources = execution.sources ?? [];
      for (const e of explanations) validateSourceIndices(e.sourceIndices, sources);
      const sourceRefs = addSources(state, sources, documentIds);
      return { summary: `Explained ${state.tutorTargets.join(", ")}.`, patch: { lecture: state }, data: { explanations: explanations.map(({ sourceIndices, ...e }) => ({ ...e, sourceRefs: sourceIndices.map((i) => sourceRefs[i]) })), estimatedMinutes: state.effort.tutorMinutes } };
    }
    if (step.agentId === "quiz") {
      const difficulty = selectLectureTargets(state).difficulty;
      const generated = await this.quiz.generateQuiz({ request: input.request, courseId: context.courseId, documentIds, count: state.effort.questionCount, questionType: "mixed", difficulty }, headers, {
        contextOverrides: { selectedDocumentCoverage: true, limits: { documents: 10, maxCharacters: 40000 } },
        maxOutputTokens: state.mode === "deep-study" ? 7500 : state.mode === "standard-study" ? 5000 : 2500,
        referenceData: JSON.stringify({ composition: "Cover every practice target using its exact topic name. Include concept recall, meaningful application and written reasoning. Scaffold weak concepts before application, diagnose uncertain topics, and include a harder transfer question when appropriate. Do not make every question hard just because the mode is deep-study.", practiceTopics: state.practiceTopics, keyIdeas: state.concepts.filter((c) => state.practiceTopics.includes(c.topic)).map(({ topic, keyIdea }) => ({ topic, keyIdea })), learning: state.learningBefore, studyMode: state.mode, difficulty, feedback: state.mode === "deep-study" ? "Explain the reasoning and typical misconceptions in the answer explanations." : "Provide concise useful answer explanations." }),
      });
      const allowed = new Set(state.practiceTopics.map(normalizeTopicName)), covered = new Set(generated.questions.flatMap((q) => q.topics).map(normalizeTopicName));
      if (generated.courseId !== context.courseId || generated.questions.length !== state.effort.questionCount || generated.questions.some((q) => q.topics.some((t) => !allowed.has(normalizeTopicName(t)))) || [...allowed].some((t) => !covered.has(t)) || !generated.questions.some((q) => q.type === "short-answer" || q.type === "long-answer")) throw new WorkflowError("INVALID_RESPONSE");
      addSources(state, generated.sources, documentIds);
      state.quiz = { id: generated.id, attemptId: null, questionCount: generated.questions.length, difficulty };
      return { summary: `Generated ${generated.questions.length} lecture questions. Learning is evaluated after you submit your answers.`, patch: { lecture: state, quizId: generated.id }, waitForInput: { kind: "quiz", referenceId: generated.id }, data: { quizId: generated.id, questionCount: generated.questions.length, difficulty, estimatedMinutes: state.effort.quizMinutes } };
    }
    if (step.agentId === "deterministic") {
      if (!state.quiz?.attemptId) throw new WorkflowError("QUIZ_INCOMPLETE");
      const attempt = await validateLectureAttempt({ ...context, waitingFor: { kind: "quiz", referenceId: state.quiz.id } }, userId, state.quiz.attemptId);
      this.cache.invalidate(["learning", "academicOverview"]);
      const topicIds = [...new Set(attempt.quiz.questions.flatMap((q) => q.topicMappings.map((m) => m.topicId)))];
      let states;
      try { states = await Promise.all(topicIds.map(async (topicId) => (await getLearningTopicStates({ userId, courseId: context.courseId, topicId }))[0])); }
      catch { throw new WorkflowError("LEARNING_REFRESH_FAILURE"); }
      if (states.some((t) => !t || !t.questionsAttempted)) throw new WorkflowError("LEARNING_REFRESH_FAILURE");
      state.summary = summarizeLecture(state, states, { percentage: Math.round(attempt.questionAttempts.reduce((s, a) => s + a.score, 0) / attempt.quiz.questions.length * 100), correctAnswers: attempt.questionAttempts.filter((a) => a.isCorrect).length, totalQuestions: attempt.quiz.questions.length });
      return { summary: `Completed graded lecture practice: ${state.summary.quizScore.percentage}%. ${state.summary.recommendedNextAction}`, patch: { lecture: state }, data: state.summary };
    }
    throw new WorkflowError("INVALID_DEFINITION");
  }
}
