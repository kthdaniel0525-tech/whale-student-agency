import { evaluateDeterministic } from "@/server/ai/evaluation/deterministic";
import { workflowObservation } from "@/server/ai/evaluation/observations";
import "dotenv/config";
import { guardedWorkflowFixture } from "./guard-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { WorkflowService, WorkflowRegistry, lectureStudy } from "@/server/workflows";
import type { WorkflowInput, WorkflowResult, WorkflowContext } from "@/server/workflows/types";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import { z } from "zod";
import { AIError } from "@/server/ai/errors";
import { AgentExecutor } from "@/server/agents/executor";
import { createStudentAgentRegistry } from "@/server/agents/student-service";
import { QuizAgentService } from "@/server/agents/quiz/service";
import { embeddingProvider } from "@/server/documents/embeddings";
import * as retrieval from "@/server/documents/retrieval";
import * as learning from "@/server/learning/service";
import { buildUserContext } from "@/server/context/builder";
import { createConversation, getConversation } from "@/server/conversations";
const DAY = 86400000;
const passage = "Mathematical Induction uses a Base Step P(1) and an Inductive Step. Assume the Inductive Hypothesis P(k), then prove P(k+1). Strong Induction assumes every preceding case. Study this lecture by explaining definitions, practicing proofs and checking the base case.";
type Actor = { id: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor, other: Actor, vector: string;
async function actor() {
  const response = await auth().api.signUpEmail({ body: { name: "Lecture Student", email: `lecture-${randomUUID()}@example.test`, password: "Lecture-fixture-passphrase!" }, asResponse: true });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const user = { id: body.user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  actors.push(user); return user;
}
async function document(userId: string, courseId: string, title: string, marker = "SELECTED_MATERIAL", status: "READY" | "PROCESSING" | "FAILED" = "READY") {
  const doc = await db().document.create({ data: { userId, courseId, title, originalFileName: "lecture.pdf", fileType: "PDF", fileSize: passage.length, storageKey: randomUUID(), processingStatus: status, embeddingModel: embeddingProvider.id, pageCount: 12 } });
  await db().$executeRaw`INSERT INTO "DocumentChunk" (id,"documentId","userId","courseId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata) VALUES (${randomUUID()},${doc.id},${userId},${courseId},0,${passage + " " + marker},5,6,80,${vector}::vector,${embeddingProvider.id},'{}'::jsonb)`;
  return doc;
}
async function fixture(options: { user?: Actor; learning?: boolean; documents?: number; status?: "READY" | "PROCESSING" | "FAILED" } = {}) {
  const user = options.user ?? owner;
  const course = await db().course.create({ data: { userId: user.id, courseCode: `LECTURE-${randomUUID().slice(0, 6)}`, courseName: "Mathematical Induction", semester: "Fall 2026" } });
  const docs = [];
  for (let i = 0; i < (options.documents ?? 1); i++) docs.push(await document(user.id, course.id, `Lecture ${i + 5}: Mathematical Induction`, `SELECTED_${i}`, options.status));
  let topicId: string | undefined;
  if (options.learning) topicId = (await db().learningTopic.create({ data: { userId: user.id, courseId: course.id, name: "Mathematical Induction", normalizedName: "mathematical induction", progress: { create: { masteryScore: 45, confidenceScore: 88, recentAccuracy: 30, questionsAttempted: 20, correctAnswers: 6, incorrectAnswers: 14, mediumAttempts: 20, scoreTotal: 6, difficultyWeightedScore: 6, difficultyWeightTotal: 20, practiceSessions: 4, firstPracticedAt: new Date(Date.now() - 21 * DAY), lastPracticedAt: new Date(Date.now() - DAY), trend: "DECLINING" } } } })).id;
  const input: WorkflowInput = { workflowId: "lecture-study", goal: "Help me study this lecture on Mathematical Induction", courseId: course.id, documentIds: docs.map((d) => d.id) };
  return { user, course, docs, topicId, input };
}
function boundary(options: { fail?: string; invalidCitation?: boolean; noFocus?: boolean; objectiveOnly?: boolean; unrelatedTopic?: boolean; gate?: (name: string) => Promise<void> } = {}) {
  const calls: string[] = [], requests: AIStructuredRequest<unknown>[] = [];
  const transport: AIProvider = {
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      calls.push(request.schemaName); requests.push(request as AIStructuredRequest<unknown>);
      if (options.gate) await options.gate(request.schemaName);
      if (options.fail === request.schemaName) throw new AIError("PROVIDER_FAILURE");
      const parameters = request.messages[0].content.split("Execution parameters: ")[1];
      const params = parameters ? JSON.parse(parameters) : {};
      let data: unknown;
      if (request.schemaName === "study_notes") {
        const sources = params.sourceCatalog as { documentId: string }[];
        data = { title: "Induction study notes", focusCovered: !options.noFocus, topics: ["Mathematical Induction", "Strong Induction"], concepts: ["Mathematical Induction", "Strong Induction"].map((topic, i) => ({ topic, complexity: i ? "advanced" : "intermediate", keyIdea: i ? "Assume all previous cases." : "Establish a base case, then prove the successor step.", definitions: ["P(k) is the inductive hypothesis."], formulasOrProcedures: ["P(1), P(k) implies P(k+1)."], notes: "Check both proof obligations before concluding the result for all natural numbers.", sourceIndices: [options.invalidCitation ? 99 : Math.min(i, sources.length - 1)] })) };
      } else if (request.schemaName === "lecture_explanation") {
        data = { explanations: (params.targets as string[]).map((topic) => ({ topic, explanation: "Use the base step and inductive hypothesis to justify the next case.", workedExample: "Establish the first case of the sum formula, then add the next term.", understandingCheck: "Where is the inductive hypothesis used?", sourceIndices: [0] })) };
      } else if (request.schemaName === "quiz_generation") {
        const extra = request.messages.find((m) => m.content.startsWith("Additional reference data"))!;
        const reference = JSON.parse(extra.content.split("\n").slice(1).join("\n"));
        const topics = reference.practiceTopics as string[];
        data = { quizTitle: "Lecture practice", topic: "Induction", difficulty: params.difficulty, questions: Array.from({ length: params.count }, (_, i) => {
          const written = !options.objectiveOnly && i % 2;
          return { type: written ? "short-answer" : i % 2 ? "multiple-choice" : "true-false", prompt: `Question ${i + 1}: Explain the base step for ${topics[i % topics.length]}.`, choices: written ? null : i % 2 ? ["true", "false", "neither", "both"] : ["True", "False"], correctAnswer: "true", explanation: "The base case and successor step are separate proof obligations.", topics: [options.unrelatedTopic ? "Unrelated concept" : topics[i % topics.length]] };
        }) };
      } else if (request.schemaName === "quiz_answer_evaluation") {
        const answer = JSON.parse(request.messages[1].content).userAnswer;
        data = { correct: answer === "true", score: answer === "true" ? 1 : answer === "partial" ? .5 : 0, feedback: "Check the base case and explain the successor step.", explanation: "The inductive hypothesis applies to the preceding case." };
      } else throw new Error(`Unnecessary agent generation ${request.schemaName}`);
      return { id: "lecture-fixture", model: "fixture", text: JSON.stringify(data), data: data as T };
    }, generateText() { throw new Error("The study workflow uses structured existing-agent execution."); }, streamText() { throw new Error("No streaming framework."); }, generateEmbedding() { throw new Error("Reuse real local RAG."); },
  };
  const provider = guardedWorkflowFixture(transport);
  const getProvider = () => provider;
  return { calls, requests, provider, service: new WorkflowService({ getProvider, conversationEmbeddingProvider: null }), quiz: new QuizAgentService(createStudentAgentRegistry(), { getProvider }) };
}
async function answerAll(ai: ReturnType<typeof boundary>, run: WorkflowResult, correct = 99, user = owner) {
  expect(run.status, JSON.stringify(run)).toBe("waiting-for-input");
  const quiz = await ai.quiz.getQuiz(run.waitingFor!.referenceId, user.headers);
  let quizAttemptId: string | undefined;
  for (const [index, q] of quiz.questions.entries()) quizAttemptId = (await ai.service.submitWorkflowAnswer({ runId: run.runId, questionId: q.id, userAnswer: index < correct ? "true" : "false", quizAttemptId }, user.headers)).quizAttemptId;
  return quizAttemptId!;
}
async function saved(id: string) { return (await db().workflowRun.findUniqueOrThrow({ where: { id } })).context as unknown as WorkflowContext; }
beforeAll(async () => { owner = await actor(); other = await actor(); vector = JSON.stringify(await embeddingProvider.generateEmbedding(passage)); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { for (const user of actors) { await db().user.deleteMany({ where: { id: user.id } }); await db().fileDeletion.deleteMany({ where: { userId: user.id } }); } await db().$disconnect(); });

describe.sequential("Lecture Study with actual auth, selected RAG, agents, grading and learning", () => {
  it("registers exactly four bounded stages", () => {
    const registry = new WorkflowRegistry(createStudentAgentRegistry()); registry.register(lectureStudy);
    expect(registry.get("lecture-study").steps.map((s) => s.agentId)).toEqual(["notes", "tutor", "quiz", "deterministic"]);
    expect(lectureStudy.maxRetries).toBe(0); expect(lectureStudy.maxAgentCalls).toBe(1);
  });
  it.each([["quick-review", ["notes", "quiz"], 4], ["standard-study", ["notes", "tutor", "quiz"], 6], ["deep-study", ["notes", "tutor", "quiz"], 10]] as const)("runs %s with the right agents and workload", async (mode, steps, count) => {
    const f = await fixture(); const ai = boundary(); const executor = vi.spyOn(AgentExecutor.prototype, "executeStructured");
    const run = await ai.service.runWorkflow({ ...f.input, mode }, owner.headers);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "waiting-for-input", completedSteps: [...steps], lectureStudy: { mode, summary: null } });
    expect(run.outputs.quiz).toMatchObject({ questionCount: count, difficulty: "medium" });
    expect(executor.mock.calls.map(([input]) => input.agentId)).toEqual([...steps]);
    expect(ai.calls).toEqual(mode === "quick-review" ? ["study_notes", "quiz_generation"] : ["study_notes", "lecture_explanation", "quiz_generation"]);
    expect((await ai.quiz.getQuiz(run.waitingFor!.referenceId, owner.headers)).questions.some((q) => q.type === "short-answer")).toBe(true);
  });
  it("scopes every retrieval/generation to selected documents and preserves real page metadata", async () => {
    const f = await fixture({ documents: 2 }); await document(owner.id, f.course.id, "Unselected lecture", "UNSELECTED_PRIVATE_PASSAGE");
    const ai = boundary(); const search = vi.spyOn(retrieval, "retrieveAcademicContext");
    const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run.status).toBe("waiting-for-input");
    const allowed = f.docs.map((d) => d.id);
    expect(search.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const [userId, raw] of search.mock.calls) {
      const scope = raw as { courseId: string; documentIds: string[] };
      expect(userId).toBe(owner.id); expect(scope.courseId).toBe(f.course.id); expect(scope.documentIds.length).toBeGreaterThan(0); expect(scope.documentIds.every((id) => allowed.includes(id))).toBe(true);
    }
    expect(JSON.stringify(ai.requests)).not.toContain("UNSELECTED_PRIVATE_PASSAGE");
    expect(JSON.stringify(ai.requests)).toContain("SELECTED_0"); expect(JSON.stringify(ai.requests)).toContain("SELECTED_1");
    const context = await saved(run.runId);
    expect(new Set(context.lecture!.sources.map((s) => s.documentId))).toEqual(new Set(allowed));
    for (const source of context.lecture!.sources) expect(source).toMatchObject({ pageNumber: 5, pageEnd: 6, documentTitle: f.docs.find((d) => d.id === source.documentId)!.title });
    const notes = run.outputs.notes as { concepts: { sourceRefs: string[] }[] };
    expect(notes.concepts.every((c) => c.sourceRefs.every((ref) => context.lecture!.sources.some((s) => s.id === ref)))).toBe(true);
    expect(JSON.stringify(context)).not.toContain("SELECTED_MATERIAL"); expect(JSON.stringify(context)).not.toContain("proof obligations"); expect(JSON.stringify(context).length).toBeLessThan(24000);
    expect(JSON.stringify(run)).not.toContain("correctAnswer");
  });
  it("uses one Notes generation and passes compact key ideas plus exact learning evidence to Tutor", async () => {
    const f = await fixture({ learning: true }); const ai = boundary();
    const before = await db().learningProgress.findFirstOrThrow({ where: { topicId: f.topicId } });
    const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run.status).toBe("waiting-for-input"); expect(ai.calls.filter((c) => c === "study_notes")).toHaveLength(1);
    const tutor = ai.requests.find((r) => r.schemaName === "lecture_explanation")!;
    const reference = tutor.messages.find((m) => m.content.startsWith("Additional reference data"))!;
    expect(reference.role).toBe("user"); expect(reference.content).toContain('"mastery":45'); expect(reference.content).toContain('"confidence":88'); expect(reference.content).toContain("Establish a base case");
    expect((await saved(run.runId)).lecture!.tutorTargets[0]).toBe("Mathematical Induction");
    expect(await db().learningProgress.findFirst({ where: { topicId: f.topicId } })).toEqual(before);
    expect(await db().questionAttempt.count({ where: { userId: owner.id, quizId: run.waitingFor!.referenceId } })).toBe(0);
  });
  it("finishes only after real grading and returns an accurate score and supported learning changes", async () => {
    const f = await fixture({ learning: true }); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run);
    const done = await new WorkflowService({ getProvider: () => ai.provider }).resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done, JSON.stringify(done)).toMatchObject({ status: "completed", completedSteps: ["notes", "tutor", "quiz", "learning"], lectureStudy: { summary: { quizScore: { percentage: 100, correctAnswers: 6, totalQuestions: 6 }, recommendedWorkflowId: "weak-topic-recovery" } } });
    const summary = done.lectureStudy!.summary!;
    expect(evaluateDeterministic({ profile: "workflow", request: "Evaluate observed workflow", output: workflowObservation(done), expected: { expectedStatus: "completed", maximumCalls: 12, maximumTutorCalls: 2, maximumQuizCalls: 2, requiredTerms: ["notes"] } }).passed).toBe(true);
    expect(summary.conceptsStudied).toEqual(["Mathematical Induction", "Strong Induction"]);
    expect(summary.insufficientEvidenceTopics).toContain("Strong Induction");
    expect(summary.improvedTopics).toContainEqual(expect.objectContaining({ topic: "Mathematical Induction", previousMastery: 45 }));
    const current = (await learning.getLearningTopicStates({ userId: owner.id, topicId: f.topicId }))[0];
    expect(summary.improvedTopics[0].currentMastery).toBe(current.mastery);
    const context = await buildUserContext({ request: "Plan study after the lecture", courseId: f.course.id, options: { learning: true } }, owner.headers);
    expect(context.learning?.weakTopics.find((t) => t.topicId === f.topicId)?.mastery).toBe(current.mastery);
    expect(await db().workflowRun.count({ where: { userId: owner.id, workflowId: "weak-topic-recovery", context: { path: ["courseId"], equals: f.course.id } } })).toBe(0);
    expect(ai.calls).not.toContain("study_plan"); expect(ai.calls).not.toContain("academic_manager");
  });
  it("keeps conversation support across quiz waiting and resume while WorkflowRun remains authoritative", async () => {
    const f = await fixture({ learning: true });
    const conversation = await createConversation({ courseId: f.course.id }, owner.headers);
    const ai = boundary();
    const waiting = await ai.service.runWorkflow({
      ...f.input,
      mode: "quick-review",
      conversationId: conversation.id,
    }, owner.headers);
    expect(waiting).toMatchObject({ status: "waiting-for-input", waitingFor: { kind: "quiz" } });
    const waitingContext = await saved(waiting.runId);
    expect(waitingContext).toMatchObject({
      conversationId: conversation.id,
      waitingFor: waiting.waitingFor,
      quizId: waiting.waitingFor?.referenceId,
    });
    const quizAttemptId = await answerAll(ai, waiting);
    const resumed = await new WorkflowService({
      getProvider: () => ai.provider,
      conversationEmbeddingProvider: null,
    }).resumeWorkflow({ runId: waiting.runId, quizAttemptId }, owner.headers);
    expect(resumed.status).toBe("completed");
    const messages = (await getConversation(conversation.id, owner.headers, 100)).messages;
    expect(messages.some((message) => message.agentId === "notes")).toBe(true);
    expect(messages.some((message) => message.agentId === "quiz")).toBe(true);
    expect(messages.filter((message) => message.role === "user").length).toBeGreaterThan(2);
  });
  it("never claims improvement from an unpracticed default mastery score", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, mode: "quick-review" }, owner.headers);
    const quizAttemptId = await answerAll(ai, run);
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done.lectureStudy?.summary).toMatchObject({ improvedTopics: [], identifiedWeakTopics: [] });
    expect(done.lectureStudy?.summary?.insufficientEvidenceTopics).toHaveLength(2);
  });
  it("uses partial-credit scores rather than only binary correctness", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, mode: "quick-review" }, owner.headers);
    const quiz = await ai.quiz.getQuiz(run.waitingFor!.referenceId, owner.headers);
    let quizAttemptId: string | undefined;
    for (const [index, q] of quiz.questions.entries()) quizAttemptId = (await ai.service.submitWorkflowAnswer({ runId: run.runId, questionId: q.id, userAnswer: index === 0 ? "true" : index === 1 ? "partial" : "false", quizAttemptId }, owner.headers)).quizAttemptId;
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: quizAttemptId! }, owner.headers);
    expect(done.lectureStudy?.summary?.quizScore).toEqual({ percentage: 38, correctAnswers: 1, totalQuestions: 4 });
  });
  it("pauses on incomplete attempts and resumes idempotently without repeating agents", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quiz = await ai.quiz.getQuiz(run.waitingFor!.referenceId, owner.headers);
    const first = await ai.service.submitWorkflowAnswer({ runId: run.runId, questionId: quiz.questions[0].id, userAnswer: "true" }, owner.headers);
    await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: first.quizAttemptId }, owner.headers)).rejects.toMatchObject({ code: "QUIZ_INCOMPLETE" });
    expect((await ai.service.getRun(run.runId, owner.headers)).status).toBe("waiting-for-input");
    for (const q of quiz.questions.slice(1)) await ai.service.submitWorkflowAnswer({ runId: run.runId, questionId: q.id, userAnswer: "true", quizAttemptId: first.quizAttemptId }, owner.headers);
    const calls = ai.calls.length;
    await Promise.all([ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: first.quizAttemptId }, owner.headers), ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: first.quizAttemptId }, owner.headers)]);
    const again = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: first.quizAttemptId }, owner.headers);
    expect(again.status).toBe("completed"); expect(ai.calls).toHaveLength(calls);
  });
  it("deduplicates starts for the same document set regardless of ordering", async () => {
    const f = await fixture({ documents: 2 }); const ai = boundary();
    const run = await ai.service.runWorkflow(f.input, owner.headers);
    const duplicate = await ai.service.runWorkflow({ ...f.input, documentIds: [...f.input.documentIds!].reverse() }, owner.headers);
    expect(duplicate.runId).toBe(run.runId); expect(ai.calls.filter((c) => c === "study_notes")).toHaveLength(1);
  });
  it.each([[20, "quick-review"], [60, "standard-study"], [120, "deep-study"]] as const)("adapts workload to %s available minutes", async (availableMinutes, mode) => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, availableMinutes }, owner.headers);
    expect(run.status).toBe("waiting-for-input"); expect(run.lectureStudy?.mode).toBe(mode); expect(run.lectureStudy!.estimatedEffort.totalMinutes).toBeLessThanOrEqual(availableMinutes);
  });
  it("honors explicit mode/difficulty and rejects an impossible time budget before generation", async () => {
    const f = await fixture(); const ai = boundary();
    await expect(ai.service.runWorkflow({ ...f.input, mode: "deep-study", availableMinutes: 20 }, owner.headers)).rejects.toMatchObject({ code: "INSUFFICIENT_STUDY_TIME" }); expect(ai.calls).toHaveLength(0);
    const run = await ai.service.runWorkflow({ ...f.input, mode: "quick-review", difficulty: "hard", availableMinutes: 120 }, owner.headers);
    expect(run.lectureStudy?.mode).toBe("quick-review"); expect(run.outputs.quiz).toMatchObject({ difficulty: "hard", questionCount: 4 });
  });
  it("supports the single-document alias and infers its owned course", async () => {
    const f = await fixture(); const run = await boundary().service.runWorkflow({ workflowId: "lecture-study", goal: "Study this PDF on Mathematical Induction", documentId: f.docs[0].id, mode: "quick-review", topicFocus: "Mathematical Induction" }, owner.headers);
    expect(run.status).toBe("waiting-for-input"); expect((await saved(run.runId)).courseId).toBe(f.course.id);
  });
  it("requires documents and rejects missing, foreign or cross-course selections", async () => {
    const f = await fixture(), foreign = await fixture({ user: other }), different = await fixture(); const ai = boundary();
    await expect(ai.service.runWorkflow({ workflowId: "lecture-study", goal: "Study this lecture", courseId: f.course.id }, owner.headers)).rejects.toMatchObject({ code: "DOCUMENT_REQUIRED" });
    for (const documentIds of [["missing"], [foreign.docs[0].id], [different.docs[0].id]]) await expect(ai.service.runWorkflow({ ...f.input, documentIds }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
    await expect(ai.service.runWorkflow({ ...f.input, courseId: foreign.course.id }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" }); expect(ai.calls).toHaveLength(0);
  });
  it.each(["PROCESSING", "FAILED"] as const)("rejects a %s document before calling Notes", async (status) => {
    const f = await fixture({ status }); const ai = boundary(); await expect(ai.service.runWorkflow(f.input, owner.headers)).rejects.toMatchObject({ code: "DOCUMENT_NOT_READY" }); expect(ai.calls).toHaveLength(0);
  });
  it("fails before generation when READY material has no usable retrieved passage", async () => {
    const f = await fixture(); await db().documentChunk.deleteMany({ where: { documentId: f.docs[0].id } }); const ai = boundary();
    const run = await ai.service.runWorkflow(f.input, owner.headers); expect(run).toMatchObject({ status: "failed", errorCode: "SOURCE_CONTEXT_UNAVAILABLE" }); expect(ai.calls).toHaveLength(0);
  });
  it("does not silently omit one selected document when only another has usable passages", async () => {
    const f = await fixture({ documents: 2 }); await db().documentChunk.deleteMany({ where: { documentId: f.docs[1].id } }); const ai = boundary();
    const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run).toMatchObject({ status: "failed", errorCode: "SOURCE_CONTEXT_UNAVAILABLE" }); expect(ai.calls).toHaveLength(0);
  });
  it("requires enough retrieval slots for all selected documents", async () => {
    const f = await fixture({ documents: 2 });
    await expect(buildUserContext({ request: "Study Mathematical Induction", courseId: f.course.id, documentIds: f.input.documentIds,
      options: { documents: true, selectedDocumentCoverage: true, limits: { documents: 1 } } }, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("rejects invented citation indices and unavailable topic focus", async () => {
    for (const options of [{ invalidCitation: true }, { noFocus: true }]) {
      const f = await fixture(); const ai = boundary(options); const run = await ai.service.runWorkflow({ ...f.input, topicFocus: "Mathematical Induction" }, owner.headers);
      expect(run.status).toBe("failed"); expect(run.errorCode).toBe(options.invalidCitation ? "INVALID_RESPONSE" : "SOURCE_CONTEXT_UNAVAILABLE"); expect(ai.calls).toEqual(["study_notes"]);
    }
  });
  it("preserves Notes and continues with a warning when optional Tutor fails", async () => {
    const f = await fixture(); const ai = boundary({ fail: "lecture_explanation" }); const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run).toMatchObject({ status: "waiting-for-input", completedSteps: ["notes", "quiz"], warnings: ["tutor: PROVIDER_FAILURE"] }); expect(run.outputs.notes).toHaveProperty("concepts");
    const quizAttemptId = await answerAll(ai, run); expect((await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers)).status).toBe("completed");
  });
  it.each(["study_notes", "quiz_generation"])("handles required %s failure without repeating completed work", async (fail) => {
    const f = await fixture(); const ai = boundary({ fail }); const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run).toMatchObject({ status: "failed", errorCode: "PROVIDER_FAILURE" }); expect(ai.calls.filter((c) => c === fail)).toHaveLength(1);
    if (fail === "quiz_generation") expect(run.outputs.notes).toHaveProperty("concepts");
  });
  it("refuses objective-only quizzes and topics outside the selected Notes concepts", async () => {
    for (const options of [{ objectiveOnly: true }, { unrelatedTopic: true }]) {
      const f = await fixture(); const run = await boundary(options).service.runWorkflow(f.input, owner.headers);
      expect(run).toMatchObject({ status: "failed", errorCode: "INVALID_RESPONSE" }); expect(run.outputs.notes).toHaveProperty("concepts");
    }
  });
  it("keeps failed grading paused and retryable", async () => {
    const f = await fixture(); const ai = boundary({ fail: "quiz_answer_evaluation" }); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quiz = await ai.quiz.getQuiz(run.waitingFor!.referenceId, owner.headers); const question = quiz.questions.find((q) => q.type === "short-answer")!;
    await expect(ai.service.submitWorkflowAnswer({ runId: run.runId, questionId: question.id, userAnswer: "true" }, owner.headers)).rejects.toMatchObject({ code: "GRADING_FAILURE" });
    expect(await ai.service.getRun(run.runId, owner.headers)).toMatchObject({ status: "waiting-for-input", warnings: ["GRADING_FAILURE"], lectureStudy: { summary: null } });
    expect(await boundary().service.submitWorkflowAnswer({ runId: run.runId, questionId: question.id, userAnswer: "true" }, owner.headers)).toHaveProperty("quizAttemptId");
  });
  it("does not publish a final summary if the learning refresh fails", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers); const quizAttemptId = await answerAll(ai, run);
    vi.spyOn(learning, "getLearningTopicStates").mockRejectedValueOnce(new Error("storage unavailable"));
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done).toMatchObject({ status: "failed", errorCode: "LEARNING_REFRESH_FAILURE", lectureStudy: { summary: null } }); expect(done.outputs.notes).toHaveProperty("concepts");
  });
  it("enforces run, question and attempt ownership and rejects frontend identity", async () => {
    const f = await fixture(), foreign = await fixture({ user: other }), sameOwner = await fixture(); const ai = boundary();
    await expect(ai.service.runWorkflow({ ...f.input, userId: other.id } as WorkflowInput, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(ai.service.runWorkflow(f.input, new Headers())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const run = await ai.service.runWorkflow(f.input, owner.headers), foreignRun = await ai.service.runWorkflow(foreign.input, other.headers), unrelated = await ai.service.runWorkflow(sameOwner.input, owner.headers);
    for (const operation of [() => ai.service.getRun(run.runId, other.headers), () => ai.service.cancelRun(run.runId, other.headers), () => ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: "x" }, other.headers)]) await expect(operation()).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    const foreignAttempt = await answerAll(ai, foreignRun, 6, other), unrelatedAttempt = await answerAll(ai, unrelated);
    for (const quizAttemptId of [foreignAttempt, unrelatedAttempt]) await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
    const foreignQuiz = await ai.quiz.getQuiz(foreignRun.waitingFor!.referenceId, other.headers);
    await expect(ai.service.submitWorkflowAnswer({ runId: run.runId, questionId: foreignQuiz.questions[0].id, userAnswer: "true" }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
  });
  it.each(["quiz", "document", "changed-document"] as const)("handles a deleted or changed %s during the pause", async (removed) => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers); const quizAttemptId = await answerAll(ai, run);
    if (removed === "quiz") await db().quiz.delete({ where: { id: run.waitingFor!.referenceId } });
    else if (removed === "document") await db().document.delete({ where: { id: f.docs[0].id } });
    else await db().document.update({ where: { id: f.docs[0].id }, data: { title: "Replaced material" } });
    await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers)).rejects.toMatchObject({ code: removed === "changed-document" ? "DOCUMENT_CHANGED" : "REFERENCE_NOT_FOUND" });
    expect((await ai.service.getRun(run.runId, owner.headers)).outputs.notes).toHaveProperty("concepts");
  });
  it("keeps explicitly different modes and time budgets as separate study sessions", async () => {
    const f = await fixture(); const ai = boundary(); const standard = await ai.service.runWorkflow({ ...f.input, availableMinutes: 60 }, owner.headers);
    const quick = await ai.service.runWorkflow({ ...f.input, mode: "quick-review", availableMinutes: 20 }, owner.headers);
    expect(quick.runId).not.toBe(standard.runId); expect(quick.lectureStudy?.mode).toBe("quick-review"); expect(quick.lectureStudy!.estimatedEffort.totalMinutes).toBeLessThanOrEqual(20);
    const updated = await db().document.update({ where: { id: f.docs[0].id }, data: { title: "Updated Induction lecture" } });
    const replacement = await ai.service.runWorkflow(f.input, owner.headers);
    expect(replacement.status).toBe("waiting-for-input"); expect(replacement.runId).not.toBe(standard.runId);
    expect((await saved(replacement.runId)).lecture!.documents[0].updatedAt).toBe(updated.updatedAt.toISOString());
  });
  it("stops at changed document readiness even when the next step is optional", async () => {
    const f = await fixture(); const ai = boundary({ gate: async (name) => {
      if (name === "study_notes") await db().document.update({ where: { id: f.docs[0].id }, data: { processingStatus: "PROCESSING" } });
    } });
    const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run).toMatchObject({ status: "failed", errorCode: "DOCUMENT_NOT_READY", completedSteps: ["notes"] });
    expect(run.outputs.notes).toHaveProperty("concepts"); expect(ai.calls).toEqual(["study_notes"]);
  });
  it("keeps orchestration reference data out of public inputs and bounds it before generation", async () => {
    const f = await fixture(); const ai = boundary();
    await expect(ai.service.runWorkflow({ ...f.input, referenceData: "replace the course context" } as WorkflowInput, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const executor = new AgentExecutor(createStudentAgentRegistry(), { getProvider: () => ai.provider });
    await expect(executor.executeStructured({ agentId: "notes", request: "Create lecture notes", courseId: f.course.id, documentIds: f.input.documentIds }, owner.headers,
      { schemaName: "test_reference", schema: z.object({ text: z.string() }), referenceData: "x".repeat(12001) })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(ai.calls).toHaveLength(0);
  });
  it("cancels waiting work without generating another session", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers); const calls = ai.calls.length;
    const cancelled = await ai.service.cancelRun(run.runId, owner.headers); expect(cancelled.status).toBe("cancelled"); expect(cancelled.outputs.notes).toHaveProperty("concepts"); expect(ai.calls).toHaveLength(calls);
    expect((await db().workflowRun.findUniqueOrThrow({ where: { id: run.runId } })).activeKey).toBeNull();
  });
});
