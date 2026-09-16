import "server-only";
import { z } from "zod";
import { NotFoundError } from "../services/academic";
import { db } from "../db/client";
import { buildUserContext } from "../context/builder";
import type { ContextReadCache } from "../context/cache";
import { getLearningTopicStates } from "../learning/service";
import { normalizeTopicName } from "../learning/normalization";
import type { createStudentAgentService } from "../agents/student-service";
import type { QuizAgentService } from "../agents/quiz/service";
import { workflowIdentity } from "./engine";
import { WorkflowError } from "./errors";
import { recoveryState } from "./weak-topic-recovery";
import { RECOVERY_CONFIG, evaluateRecovery, recoveryEntry, recoveryQuizSettings, recoverySnapshot, selectRecoveryTopic } from "./recovery-policy";
import type { StepInput, StepOutput, WorkflowContext, WorkflowStep } from "./types";

const id = z.string().min(1).max(100);
export const recoveryInputSchema = z.object({
  workflowId: z.literal("weak-topic-recovery"), goal: z.string().trim().min(3).max(1000),
  courseId: id.optional(), topicId: id.optional(), topicName: z.string().trim().min(1).max(120).optional(), review: z.boolean().optional(),
  documentIds: z.array(id).min(1).max(10).optional(),
}).strict();

export async function initialRecoveryContext(input: z.infer<typeof recoveryInputSchema>, headers: Headers, cache: ContextReadCache): Promise<WorkflowContext> {
  const { userId } = await workflowIdentity(headers);
  // Scope authorization, including documents, stays in the existing builder.
  try { await buildUserContext({ request: input.goal, courseId: input.courseId, documentIds: input.documentIds, options: {} }, headers, cache); }
  catch (error) { if (error instanceof NotFoundError) throw new WorkflowError("REFERENCE_NOT_FOUND"); throw error; }
  const topics = await getLearningTopicStates({ userId, courseId: input.courseId, topicId: input.topicId });
  let selected;
  if (input.topicId) selected = topics.find((t) => t.id === input.topicId);
  else if (input.topicName) {
    const matches = topics.filter((t) => normalizeTopicName(t.topic) === normalizeTopicName(input.topicName!));
    if (matches.length > 1) throw new WorkflowError("TOPIC_SELECTION_REQUIRED");
    selected = matches[0];
  } else {
    const goal = normalizeTopicName(input.goal);
    const matches = topics.filter((t) => {
      const name = normalizeTopicName(t.topic).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{N}])${name}($|[^\\p{L}\\p{N}])`, "u").test(goal);
    });
    if (matches.length > 1) throw new WorkflowError("TOPIC_SELECTION_REQUIRED");
    selected = matches[0];
    if (!selected) {
      if (!/\b(weakest|weak (topics?|areas?)|weaknesses)\b|취약|약한|약점/i.test(input.goal)) throw new WorkflowError("TOPIC_NOT_FOUND");
      selected = selectRecoveryTopic(topics);
      if (!selected) throw new WorkflowError("NO_LEARNING_DATA");
    }
  }
  if (!selected || (input.topicName && normalizeTopicName(selected.topic) !== normalizeTopicName(input.topicName))) throw new WorkflowError("TOPIC_NOT_FOUND");
  // The selected course also constrains document ownership/cross-course scope.
  try { await buildUserContext({ request: input.goal, courseId: selected.courseId, documentIds: input.documentIds, options: {} }, headers, cache); }
  catch (error) { if (error instanceof NotFoundError) throw new WorkflowError("REFERENCE_NOT_FOUND"); throw error; }
  const snapshot = recoverySnapshot(selected);
  const entry = recoveryEntry(snapshot, input.review || /\breview\b|복습/i.test(input.goal));
  return { goal: input.goal, courseId: selected.courseId, documentIds: input.documentIds,
    priorities: [], topics: [], studyPlanId: null, planCurrent: false, quizId: null, quizCurrent: false,
    quizMode: entry === "diagnostic" ? "diagnostic" : "practice", tutorTopic: selected.topic, targetTopics: [selected.topic], previousStepSummaries: [],
    recovery: { topicId: selected.id, topicName: selected.topic, courseId: selected.courseId,
      startingState: snapshot, currentState: snapshot, entry, tutorAttempts: 0, quizAttempts: 0, quizzes: [], evaluation: null, stop: entry === "skip" } };
}

export async function validateRecoveryAttempt(context: Readonly<WorkflowContext>, userId: string, attemptId: string, requireComplete = true) {
  const state = recoveryState(context);
  const selected = state.quizzes.at(-1);
  if (!selected || context.waitingFor?.referenceId !== selected.id) throw new WorkflowError("INVALID_REQUEST");
  const topic = await db().learningTopic.findFirst({ where: { id: state.topicId, userId, courseId: state.courseId, course: { userId } }, select: { id: true } });
  if (!topic) throw new WorkflowError("TOPIC_NOT_FOUND");
  const attempt = await db().quizAttempt.findFirst({ where: { id: attemptId, userId, quizId: selected.id, quiz: { userId, courseId: state.courseId, course: { userId } } }, select: {
    id: true, completedAt: true, questionAttempts: { select: { questionId: true, userId: true } },
    quiz: { select: { questions: { select: { id: true, userId: true, topicMappings: { where: { topicId: state.topicId, userId }, select: { topicId: true } } } } } },
  } });
  if (!attempt) throw new WorkflowError("REFERENCE_NOT_FOUND");
  const questions = attempt.quiz.questions;
  if (!questions.length || questions.some((q) => q.userId !== userId || !q.topicMappings.length) || attempt.questionAttempts.some((a) => a.userId !== userId)) throw new WorkflowError("REFERENCE_NOT_FOUND");
  if (requireComplete && (!attempt.completedAt || questions.some((q) => !attempt.questionAttempts.some((a) => a.questionId === q.id)))) throw new WorkflowError("QUIZ_INCOMPLETE");
  return attempt;
}

/** Domain adapter for the existing engine; agent execution and grading are reused. */
export class RecoveryWorkflowAdapter {
  constructor(private readonly core: ReturnType<typeof createStudentAgentService>, private readonly quiz: QuizAgentService, private readonly cache: ContextReadCache) {}
  async execute(step: WorkflowStep, input: StepInput, context: Readonly<WorkflowContext>, headers: Headers): Promise<StepOutput> {
    const { userId } = await workflowIdentity(headers);
    const state = structuredClone(recoveryState(context));
    if (step.agentId === "deterministic") {
      const last = state.quizzes.at(-1);
      if (!last?.attemptId) throw new WorkflowError("QUIZ_INCOMPLETE");
      await validateRecoveryAttempt({ ...context, waitingFor: { kind: "quiz", referenceId: last.id } }, userId, last.attemptId);
      this.cache.invalidate(["learning", "academicOverview"]);
      let topic;
      try { topic = (await getLearningTopicStates({ userId, courseId: state.courseId, topicId: state.topicId }))[0]; }
      catch { throw new WorkflowError("LEARNING_REFRESH_FAILURE"); }
      if (!topic || !topic.questionsAttempted) throw new WorkflowError("LEARNING_REFRESH_FAILURE");
      state.currentState = recoverySnapshot(topic);
      state.evaluation = evaluateRecovery(state.startingState, state.currentState, last.difficulty !== "easy");
      // An easy warm-up cannot confirm recovery. Verify it with medium/hard
      // questions before stopping for success or meaningful improvement.
      state.stop = state.quizAttempts >= RECOVERY_CONFIG.maxQuizCalls || state.evaluation.status === "insufficient-evidence"
        || (last.difficulty !== "easy" && ["recovered", "improving"].includes(state.evaluation.status));
      return { summary: `Refreshed graded evidence for ${state.topicName}: mastery ${state.startingState.mastery} → ${topic.mastery}, confidence ${topic.confidence}; ${state.evaluation.status}.`, patch: { recovery: state }, data: { ...state.evaluation, trend: topic.trend, recentAccuracy: topic.recentAccuracy } };
    }
    // Revalidate the target immediately before any agent consumes saved state.
    const owned = await db().learningTopic.findFirst({ where: { id: state.topicId, userId, courseId: state.courseId, course: { userId } }, select: { id: true } });
    if (!owned) throw new WorkflowError("TOPIC_NOT_FOUND");
    if (step.agentId === "tutor") {
      if (state.tutorAttempts >= RECOVERY_CONFIG.maxTutorCalls) throw new WorkflowError("LIMIT_EXCEEDED");
      const result = await this.core.handleAgentRequest({ request: input.request, preferredAgentId: "tutor", courseId: state.courseId, documentIds: context.documentIds }, headers);
      if (!result.ok) throw new WorkflowError(result.error.code as import("./errors").WorkflowErrorCode);
      state.tutorAttempts++;
      return { summary: `Explained ${state.topicName} using ${state.tutorAttempts === 1 ? "targeted instruction" : "an alternative approach"}.`, patch: { recovery: state }, data: { topic: state.topicName, explanation: result.response.content.slice(0, 6000), sources: result.response.sources.slice(0, 5), truncated: result.response.content.length > 6000 } };
    }
    if (step.agentId === "quiz") {
      if (state.quizAttempts >= RECOVERY_CONFIG.maxQuizCalls) throw new WorkflowError("LIMIT_EXCEEDED");
      const settings = recoveryQuizSettings(state);
      const generated = await this.quiz.generateQuiz({ request: input.request, courseId: state.courseId, topic: state.topicName,
        count: settings.count, difficulty: settings.difficulty, questionType: "mixed", documentIds: context.documentIds }, headers);
      if (generated.courseId !== state.courseId || generated.questions.some((q) => !q.topics.some((t) => normalizeTopicName(t) === normalizeTopicName(state.topicName)))) throw new WorkflowError("INVALID_RESPONSE");
      state.quizAttempts++;
      state.quizzes.push({ id: generated.id, mode: settings.mode, difficulty: settings.difficulty, attemptId: null });
      return { summary: `Created ${settings.count} ${settings.difficulty} ${settings.mode} questions for ${state.topicName}; awaiting your answers.`,
        patch: { recovery: state, quizId: generated.id }, waitForInput: { kind: "quiz", referenceId: generated.id },
        data: { quizId: generated.id, questionCount: settings.count, difficulty: settings.difficulty, mode: settings.mode } };
    }
    throw new WorkflowError("INVALID_DEFINITION");
  }
}
