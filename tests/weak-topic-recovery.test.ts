import { evaluateDeterministic } from "@/server/ai/evaluation/deterministic";
import { workflowObservation } from "@/server/ai/evaluation/observations";
import "dotenv/config";
import { guardedWorkflowFixture } from "./guard-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { WorkflowService, WorkflowRegistry, weakTopicRecovery, RECOVERY_CONFIG } from "@/server/workflows";
import { WorkflowEngine } from "@/server/workflows/engine";
import type { WorkflowContext, WorkflowInput, WorkflowResult } from "@/server/workflows/types";
import { createStudentAgentRegistry } from "@/server/agents/student-service";
import { QuizAgentService } from "@/server/agents/quiz/service";
import { buildUserContext } from "@/server/context/builder";
import * as categories from "@/server/context/categories";
import { ContextReadCache } from "@/server/context/cache";
import * as learning from "@/server/learning/service";
import type { AIProvider, AIStructuredRequest, AITextRequest } from "@/server/ai/types";
import { AIError } from "@/server/ai/errors";
const DAY = 86400000;
type Actor = { id: string; headers: Headers };
let owner: Actor, other: Actor;
const actors: Actor[] = [];
async function actor() {
  const response = await auth().api.signUpEmail({ body: { name: "Recovery Student", email: `recovery-${randomUUID()}@example.test`, password: "Recovery-fixture-password!" }, asResponse: true });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const result = { id: body.user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  actors.push(result);
  await db().profile.create({ data: { userId: result.id, school: "Fixture University", program: "CS", currentYear: 2, semester: "Fall 2026", academicGoal: "Understand mathematics", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return result;
}
async function fixture(options: { user?: Actor; mastery?: number; confidence?: number; attempted?: number; name?: string; courseId?: string; recentAccuracy?: number; trend?: "DECLINING" | "STABLE" } = {}) {
  const user = options.user ?? owner;
  const course = options.courseId ? await db().course.findUniqueOrThrow({ where: { id: options.courseId } }) : await db().course.create({ data: { userId: user.id, courseCode: `MATH-${randomUUID().slice(0, 6)}`, courseName: "Mathematics", semester: "Fall 2026" } });
  const attempted = options.attempted ?? 20;
  const correct = Math.floor(attempted * .3);
  const name = options.name ?? "Mathematical Induction";
  const topic = await db().learningTopic.create({ data: { userId: user.id, courseId: course.id, name, normalizedName: name.toLowerCase(),
    ...(attempted ? { progress: { create: { masteryScore: options.mastery ?? 40, confidenceScore: options.confidence ?? 85, recentAccuracy: options.recentAccuracy ?? 30,
      questionsAttempted: attempted, correctAnswers: correct, incorrectAnswers: attempted - correct, mediumAttempts: attempted, scoreTotal: correct,
      difficultyWeightedScore: correct, difficultyWeightTotal: attempted, practiceSessions: Math.min(4, attempted),
      firstPracticedAt: new Date(Date.now() - 21 * DAY), lastPracticedAt: new Date(Date.now() - DAY), trend: options.trend ?? "DECLINING" } } } : {}) } });
  const input: WorkflowInput = { workflowId: "weak-topic-recovery", goal: `Help me improve ${name}.`, courseId: course.id, topicId: topic.id };
  return { course, topic, input, user };
}
function boundary(options: { fail?: string; wrongTopic?: boolean; gateTutor?: () => Promise<void> } = {}) {
  const calls: string[] = [], texts: AITextRequest[] = [], structured: AIStructuredRequest<unknown>[] = [];
  const check = (name: string) => { calls.push(name); if (options.fail === name) throw new AIError("PROVIDER_FAILURE"); };
  const transport: AIProvider = {
    async generateText(request) { check("tutor"); texts.push(request); if (options.gateTutor) await options.gateTutor(); return { id: "tutor", model: "fixture", text: "Start induction with a base case. State the inductive hypothesis, then connect k to k+1 using a worked example." }; },
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      check(request.schemaName); structured.push(request as AIStructuredRequest<unknown>);
      let data: unknown;
      if (request.schemaName === "quiz_generation") {
        const p = JSON.parse(request.messages[0].content.split("Execution parameters: ")[1]) as { count: number; difficulty: string; topic: string };
        data = { quizTitle: "Targeted recovery quiz", topic: p.topic, difficulty: p.difficulty,
          questions: Array.from({ length: p.count }, (_, i) => ({ type: i % 2 ? "short-answer" : "true-false", prompt: `Recovery question ${i + 1}: Does ${p.topic} require a base case?`, choices: i % 2 ? null : ["True", "False"], correctAnswer: "true", explanation: "Establish the base case before the inductive step.", topics: [options.wrongTopic ? "Unrelated concept" : p.topic] })) };
      } else if (request.schemaName === "quiz_answer_evaluation") {
        const answer = JSON.parse(request.messages[1].content).userAnswer;
        data = { correct: answer === "true", score: answer === "true" ? 1 : 0, feedback: "Compare your argument to the base case and inductive step.", explanation: "A base case establishes the starting point." };
      } else throw new Error(`Unexpected generation ${request.schemaName}`);
      return { id: "fixture", model: "fixture", text: JSON.stringify(data), data: data as T };
    }, streamText() { throw new Error("No new AI pipeline"); }, generateEmbedding() { throw new Error("No documents selected"); },
  };
  const provider = guardedWorkflowFixture(transport);
  const getProvider = () => provider;
  return { calls, texts, structured, provider, service: new WorkflowService({ getProvider }), quiz: new QuizAgentService(createStudentAgentRegistry(), { getProvider, executor: { getProvider }, router: { allowedAgentIds: ["quiz"] } }) };
}
async function answerAll(ai: ReturnType<typeof boundary>, run: WorkflowResult, correct: number, user = owner) {
  const quiz = await ai.quiz.getQuiz(run.waitingFor!.referenceId, user.headers);
  let quizAttemptId: string | undefined;
  for (const [index, q] of quiz.questions.entries()) {
    const evaluated = await ai.service.submitRecoveryAnswer({ runId: run.runId, questionId: q.id, userAnswer: index < correct ? "true" : "false", quizAttemptId }, user.headers);
    quizAttemptId = evaluated.quizAttemptId;
  }
  return quizAttemptId!;
}
async function saved(runId: string) { return (await db().workflowRun.findUniqueOrThrow({ where: { id: runId } })).context as unknown as WorkflowContext; }
beforeAll(async () => { owner = await actor(); other = await actor(); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { for (const a of actors) await db().user.deleteMany({ where: { id: a.id } }); await db().$disconnect(); });

describe.sequential("Weak Topic Recovery through real agents, grading and Learning", () => {
  it("registers a bounded definition with code-only evaluation", () => {
    const r = new WorkflowRegistry(createStudentAgentRegistry()); r.register(weakTopicRecovery);
    expect(r.get("weak-topic-recovery").steps).toHaveLength(6);
    expect(r.get("weak-topic-recovery").steps.filter((s) => s.agentId === "deterministic")).toHaveLength(2);
    expect(Object.isFrozen(r.get("weak-topic-recovery").agentCallLimits)).toBe(true);
  });
  it("selects an explicit topic, tutors first and persists a quiz without claiming improvement", async () => {
    const f = await fixture(); const ai = boundary();
    const before = await db().learningProgress.findFirstOrThrow({ where: { topicId: f.topic.id } });
    const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run).toMatchObject({ status: "waiting-for-input", completedSteps: ["tutor-1", "quiz-1"], recovery: { status: "awaiting-answers", evaluation: null, topic: { id: f.topic.id } } });
    expect(ai.calls).toEqual(["tutor", "quiz_generation"]);
    expect(await db().learningProgress.findFirst({ where: { topicId: f.topic.id } })).toEqual(before);
    const context = await saved(run.runId);
    expect(context.recovery).toMatchObject({ tutorAttempts: 1, quizAttempts: 1, startingState: { mastery: 40, confidence: 85 }, currentState: { mastery: 40, confidence: 85 } });
    expect(JSON.stringify(context)).not.toContain("Start induction with a base case");
    expect(JSON.stringify(context).length).toBeLessThan(6000);
    expect(run.outputs["explanation-1"]).toHaveProperty("explanation");
    expect(ai.texts[0].messages.some((m) => m.content.includes("Current learning evidence: mastery 40, confidence 85"))).toBe(true);
    expect(JSON.stringify(run)).not.toContain("correctAnswer");
  });
  it("resolves exact names in a request and normalized explicit names", async () => {
    const f = await fixture(); const ai = boundary();
    const named = await ai.service.runWorkflow({ workflowId: "weak-topic-recovery", goal: "Help me understand Mathematical Induction better.", courseId: f.course.id }, owner.headers);
    expect(named.recovery?.topic.id).toBe(f.topic.id);
    const exact = await ai.service.runWorkflow({ workflowId: "weak-topic-recovery", goal: "Improve this topic", topicName: "  MATHEMATICAL   INDUCTION  ", courseId: f.course.id }, owner.headers);
    expect(exact.runId).toBe(named.runId);
  });
  it("selects the highest-value demonstrated weak topic rather than a very low-confidence score", async () => {
    const f = await fixture({ name: "Logic", mastery: 60, confidence: 80, recentAccuracy: 80, trend: "STABLE" });
    const weak = await fixture({ courseId: f.course.id, name: "Induction", mastery: 42, confidence: 88 });
    await fixture({ courseId: f.course.id, name: "Unknown", mastery: 5, confidence: 10 });
    const run = await boundary().service.runWorkflow({ workflowId: "weak-topic-recovery", goal: "Help me improve my weakest topic", courseId: f.course.id }, owner.headers);
    expect(run.recovery?.topic.id).toBe(weak.topic.id);
  });
  it("starts low-confidence and unpracticed topics with diagnostics only", async () => {
    for (const attempted of [1, 0]) {
      const f = await fixture({ mastery: 41, confidence: 22, attempted }); const ai = boundary();
      const run = await ai.service.runWorkflow(f.input, owner.headers);
      expect(ai.calls).toEqual(["quiz_generation"]);
      expect(run.outputs["quiz-1"]).toMatchObject({ mode: "diagnostic", questionCount: 5, difficulty: "medium" });
      expect(run.completedSteps).toEqual(["quiz-1"]);
    }
  });
  it("uses diagnostic fallback for automatic selection without asserting weakness", async () => {
    const f = await fixture({ attempted: 0 }); const ai = boundary();
    const run = await ai.service.runWorkflow({ workflowId: "weak-topic-recovery", goal: "Fix my weak areas", courseId: f.course.id }, owner.headers);
    expect(run.outputs["quiz-1"]).toMatchObject({ mode: "diagnostic" }); expect(ai.calls).not.toContain("tutor");
  });
  it("refreshes actual graded evidence and reaches recovery without another Tutor", async () => {
    const f = await fixture(); const ai = boundary();
    const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 6);
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done).toMatchObject({ status: "completed", recovery: { status: "recovered" }, completedSteps: ["tutor-1", "quiz-1", "evaluate-1"] });
    expect(done.recovery!.endingState.mastery).toBeGreaterThanOrEqual(70);
    expect(evaluateDeterministic({ profile: "workflow", request: "Evaluate observed workflow", output: workflowObservation(done), expected: { expectedStatus: "completed", maximumCalls: 12, maximumTutorCalls: 2, maximumQuizCalls: 2, requiredTerms: [] } }).passed).toBe(true);
    expect(done.recovery!.evaluation!.improvement).toBe(done.recovery!.endingState.mastery - 40);
    const current = (await learning.getLearningTopicStates({ userId: owner.id, topicId: f.topic.id }))[0];
    expect(done.recovery!.endingState.mastery).toBe(current.mastery);
    const context = await buildUserContext({ request: "Create my next study plan", courseId: f.course.id, options: { learning: true } }, owner.headers);
    expect(context.learning?.recommendedTopics.find((t) => t.topicId === f.topic.id)?.mastery).toBe(current.mastery);
    expect(await db().studyPlan.count({ where: { userId: owner.id, tasks: { some: { courseId: f.course.id } } } })).toBe(0);
  });
  it("stops for independent practice after meaningful but incomplete improvement", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 4);
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done).toMatchObject({ status: "completed", recovery: { status: "improving", recommendedAgent: "quiz" } });
    expect(done.recovery!.endingState.mastery).toBeLessThan(70);
    expect(ai.calls.filter((c) => c === "quiz_generation")).toHaveLength(1);
  });
  it("refreshes a diagnostic before deciding on tutoring", async () => {
    const f = await fixture({ confidence: 20 }); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(ai.calls).toEqual(["quiz_generation"]);
    const quizAttemptId = await answerAll(ai, run, 0);
    const next = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(next).toMatchObject({ status: "waiting-for-input", completedSteps: ["quiz-1", "evaluate-1", "tutor-2", "quiz-2"] });
    expect(ai.texts[0].messages.at(-1)?.content).toContain(`mastery ${next.recovery!.endingState.mastery}`);
    expect(next.recovery!.endingState.confidence).toBeGreaterThanOrEqual(60);
    expect(next.outputs["quiz-2"]).toMatchObject({ mode: "verification", difficulty: "medium", questionCount: 5 });
  });
  it("stops rather than tutoring when a completed diagnostic still has insufficient evidence", async () => {
    const f = await fixture({ attempted: 0 }); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 5);
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done).toMatchObject({ status: "completed", recovery: { status: "insufficient-evidence" } }); expect(ai.calls).not.toContain("tutor");
  });
  it("bounds failed remediation to two Tutors, two quizzes and six steps across service restarts", async () => {
    const f = await fixture(); const ai = boundary(); let run = await ai.service.runWorkflow(f.input, owner.headers);
    for (let cycle = 0; cycle < 2; cycle++) {
      const quizAttemptId = await answerAll(ai, run, 0);
      run = await new WorkflowService({ getProvider: () => ai.provider }).resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    }
    expect(run).toMatchObject({ status: "completed", recovery: { status: "needs-more-practice" } });
    expect(run.completedSteps).toHaveLength(6);
    expect(ai.calls.filter((c) => c === "tutor")).toHaveLength(2); expect(ai.calls.filter((c) => c === "quiz_generation")).toHaveLength(2);
    const context = await saved(run.runId); expect(context.recovery).toMatchObject({ tutorAttempts: 2, quizAttempts: 2, stop: true });
    expect(ai.texts[1].messages.at(-1)?.content).toContain("different representation");
    const calls = ai.calls.length;
    await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: context.recovery!.quizzes[1].attemptId! }, owner.headers);
    expect(ai.calls).toHaveLength(calls);
  });
  it("does not confirm recovery from an easy warm-up and follows with medium verification", async () => {
    const f = await fixture({ mastery: 30 }); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run.outputs["quiz-1"]).toMatchObject({ difficulty: "easy" });
    const quizAttemptId = await answerAll(ai, run, 6);
    const next = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(next.status).toBe("waiting-for-input"); expect(next.outputs["evaluation-1"]).not.toMatchObject({ status: "recovered" });
    expect(next.outputs["quiz-2"]).toMatchObject({ difficulty: "medium", mode: "verification" });
    const verified = await answerAll(ai, next, 5);
    expect((await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: verified }, owner.headers)).recovery?.status).toBe("recovered");
  });
  it("skips unnecessary high-mastery recovery but honors explicit review", async () => {
    const f = await fixture({ mastery: 95, confidence: 95 }); const ai = boundary();
    const skipped = await ai.service.runWorkflow(f.input, owner.headers);
    expect(skipped).toMatchObject({ status: "completed", recovery: { status: "not-needed" }, completedSteps: [] }); expect(ai.calls).toHaveLength(0);
    const review = await ai.service.runWorkflow({ ...f.input, review: true }, owner.headers);
    expect(review.outputs["quiz-1"]).toMatchObject({ mode: "verification", difficulty: "hard" }); expect(ai.calls).not.toContain("tutor");
  });
  it("keeps an incomplete quiz paused and uses one complete attempt rather than pooled answers", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quiz = await ai.quiz.getQuiz(run.waitingFor!.referenceId, owner.headers);
    const first = await ai.service.submitRecoveryAnswer({ runId: run.runId, questionId: quiz.questions[0].id, userAnswer: "true" }, owner.headers);
    const separate = await ai.quiz.evaluateAnswer({ quizId: quiz.id, questionId: quiz.questions[1].id, userAnswer: "true", startNewAttempt: true }, owner.headers);
    await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: first.quizAttemptId }, owner.headers)).rejects.toMatchObject({ code: "QUIZ_INCOMPLETE" });
    await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: separate.quizAttemptId }, owner.headers)).rejects.toMatchObject({ code: "QUIZ_INCOMPLETE" });
    expect((await ai.service.getRun(run.runId, owner.headers)).status).toBe("waiting-for-input");
  });
  it("deduplicates starts while waiting and concurrent continuation", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const duplicate = await ai.service.runWorkflow(f.input, owner.headers); expect(duplicate.runId).toBe(run.runId);
    const quizAttemptId = await answerAll(ai, run, 0);
    await Promise.all([ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers), ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers)]);
    expect(ai.calls.filter((c) => c === "quiz_generation")).toHaveLength(2);
    expect(ai.calls.filter((c) => c === "tutor")).toHaveLength(2);
    const repeated = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(repeated.status).toBe("waiting-for-input"); expect(ai.calls.filter((c) => c === "quiz_generation")).toHaveLength(2);
  });
  it("cancels a paused run and releases its topic lock without further agents", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const cancelled = await ai.service.cancelRun(run.runId, owner.headers);
    expect(cancelled).toMatchObject({ status: "cancelled", recovery: { status: "cancelled" } });
    expect(await db().workflowRun.findUnique({ where: { id: run.runId }, select: { activeKey: true } })).toEqual({ activeKey: null });
    expect((await ai.service.runWorkflow(f.input, owner.headers)).runId).not.toBe(run.runId);
  });
  it("enforces the persisted active-time budget on continuation", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 0);
    await db().workflowRun.update({ where: { id: run.runId }, data: { activeDurationMs: RECOVERY_CONFIG.maxDurationMs } });
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done).toMatchObject({ status: "failed", errorCode: "LIMIT_EXCEEDED", recovery: { status: "failed" } });
    expect(ai.calls.filter((c) => c === "tutor")).toHaveLength(1);
  });
  it("enforces per-agent call counts from persisted audits", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 0);
    await db().workflowStepRun.updateMany({ where: { workflowRunId: run.runId, stepId: "tutor-1" }, data: { attempts: 2 } });
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done).toMatchObject({ status: "failed", errorCode: "LIMIT_EXCEEDED" });
    expect(ai.calls.filter((c) => c === "tutor")).toHaveLength(1);
  });
  it.each(["tutor", "quiz_generation"])("fails safely on %s failure without automatic retry or false recovery", async (fail) => {
    const f = await fixture(); const ai = boundary({ fail }); const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run).toMatchObject({ status: "failed", errorCode: "PROVIDER_FAILURE", recovery: { status: "failed", evaluation: null } });
    expect(ai.calls.filter((c) => c === fail)).toHaveLength(1);
  });
  it("retains a grading failure as a warning and permits answer retry", async () => {
    const f = await fixture(); const ai = boundary({ fail: "quiz_answer_evaluation" }); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quiz = await ai.quiz.getQuiz(run.waitingFor!.referenceId, owner.headers);
    const question = quiz.questions.find((q) => q.type === "short-answer")!;
    await expect(ai.service.submitRecoveryAnswer({ runId: run.runId, questionId: question.id, userAnswer: "true" }, owner.headers)).rejects.toMatchObject({ code: "GRADING_FAILURE" });
    expect(await ai.service.getRun(run.runId, owner.headers)).toMatchObject({ status: "waiting-for-input", warnings: ["GRADING_FAILURE"], recovery: { evaluation: null } });
    expect(await db().questionAttempt.count({ where: { questionId: question.id } })).toBe(0);
    const retry = boundary(); expect(await retry.service.submitRecoveryAnswer({ runId: run.runId, questionId: question.id, userAnswer: "true" }, owner.headers)).toHaveProperty("quizAttemptId");
  });
  it("fails rather than claiming recovery when the learning refresh fails", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 6);
    vi.spyOn(learning, "getLearningTopicStates").mockRejectedValueOnce(new Error("storage unavailable"));
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done).toMatchObject({ status: "failed", errorCode: "LEARNING_REFRESH_FAILURE", recovery: { status: "failed", evaluation: null } });
  });
  it("rejects unrelated generated topics", async () => {
    const f = await fixture(); const run = await boundary({ wrongTopic: true }).service.runWorkflow(f.input, owner.headers);
    expect(run).toMatchObject({ status: "failed", errorCode: "INVALID_RESPONSE" });
  });
  it("rejects ambiguous names, missing topics and an empty automatic selection", async () => {
    const f = await fixture({ name: `Ambiguous ${randomUUID()}` }); await fixture({ name: f.topic.name });
    const ai = boundary();
    await expect(ai.service.runWorkflow({ workflowId: "weak-topic-recovery", goal: "Improve this topic", topicName: f.topic.name }, owner.headers)).rejects.toMatchObject({ code: "TOPIC_SELECTION_REQUIRED" });
    await expect(ai.service.runWorkflow({ ...f.input, topicId: "missing" }, owner.headers)).rejects.toMatchObject({ code: "TOPIC_NOT_FOUND" });
    await expect(ai.service.runWorkflow({ workflowId: "weak-topic-recovery", goal: "Help me understand some unknown topic", courseId: f.course.id }, owner.headers)).rejects.toMatchObject({ code: "TOPIC_NOT_FOUND" });
    const strong = await fixture({ mastery: 95, confidence: 95 });
    await expect(ai.service.runWorkflow({ workflowId: "weak-topic-recovery", goal: "Fix my weak areas", courseId: strong.course.id }, owner.headers)).rejects.toMatchObject({ code: "NO_LEARNING_DATA" });
  });
  it("enforces topic, course, run, quiz, question and attempt ownership", async () => {
    const f = await fixture(); const foreign = await fixture({ user: other }); const ai = boundary();
    await expect(ai.service.runWorkflow({ ...f.input, topicId: foreign.topic.id }, owner.headers)).rejects.toMatchObject({ code: "TOPIC_NOT_FOUND" });
    await expect(ai.service.runWorkflow({ ...foreign.input, topicId: f.topic.id }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
    const run = await ai.service.runWorkflow(f.input, owner.headers); const foreignRun = await ai.service.runWorkflow(foreign.input, other.headers);
    for (const operation of [() => ai.service.getRun(run.runId, other.headers), () => ai.service.cancelRun(run.runId, other.headers), () => ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: "foreign" }, other.headers)]) await expect(operation()).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    const foreignAttempt = await answerAll(ai, foreignRun, 5, other);
    await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: foreignAttempt }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
    const foreignQuiz = await ai.quiz.getQuiz(foreignRun.waitingFor!.referenceId, other.headers);
    await expect(ai.service.submitRecoveryAnswer({ runId: run.runId, questionId: foreignQuiz.questions[0].id, userAnswer: "true" }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
    const sameOwner = await fixture(); const another = await ai.service.runWorkflow(sameOwner.input, owner.headers); const unrelatedAttempt = await answerAll(ai, another, 6);
    await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: unrelatedAttempt }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
  });
  it("rejects frontend identity/state injection and unauthenticated requests", async () => {
    const f = await fixture(); const ai = boundary();
    await expect(ai.service.runWorkflow({ ...f.input, userId: other.id } as WorkflowInput, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(ai.service.runWorkflow({ ...f.input, context: {} } as WorkflowInput, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(ai.service.runWorkflow(f.input, new Headers())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("handles deleted attempts/topics without evaluating stale evidence", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 6);
    await learning.deleteQuizAttempt({ userId: owner.id, attemptId: quizAttemptId });
    await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
    await db().learningTopic.delete({ where: { id: f.topic.id } });
    await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers)).rejects.toMatchObject({ code: "TOPIC_NOT_FOUND" });
    expect((await ai.service.getRun(run.runId, owner.headers)).recovery?.evaluation).toBeNull();
  });
  it("uses the engine's generic pause with cancellation while a Tutor is in flight", async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
    const ai = boundary({ gateTutor: async () => { entered(); await gate; } });
    const running = ai.service.runWorkflow(f.input, owner.headers); await started;
    const row = await db().workflowRun.findFirstOrThrow({ where: { userId: owner.id, activeKey: `${owner.id}:weak-topic-recovery:${f.topic.id}` } });
    await ai.service.cancelRun(row.id, owner.headers); release();
    const cancelled = await running; expect(cancelled.status).toBe("cancelled"); expect(ai.calls).toEqual(["tutor"]);
  });
  it("uses canonical quiz history and updates only the selected topic's existing aggregate", async () => {
    const f = await fixture({ attempted: 0 }); const ai = boundary();
    const history = await ai.quiz.generateQuiz({ request: "Create a quiz on Mathematical Induction", courseId: f.course.id, topic: f.topic.name, count: 5, difficulty: "medium", questionType: "mixed" }, owner.headers);
    for (let session = 0; session < 4; session++) {
      let quizAttemptId: string | undefined;
      for (const [index, q] of history.questions.entries()) {
        const result = await learning.recordQuestionEvaluation({ userId: owner.id, quizId: history.id, questionId: q.id, quizAttemptId,
          ...(index === 0 ? { startNewAttempt: true } : {}), userAnswer: index < 2 ? "true" : "false", correct: index < 2, score: index < 2 ? 1 : 0, method: "deterministic",
          attemptedAt: new Date(Date.now() - (21 - 6 * session) * DAY + index * 1000) });
        quizAttemptId = result.quizAttemptId;
      }
    }
    const unrelated = await fixture({ courseId: f.course.id, name: "Other concept" });
    const untouched = await db().learningProgress.findFirstOrThrow({ where: { topicId: unrelated.topic.id } });
    const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run.completedSteps).toEqual(["tutor-1", "quiz-1"]);
    const quizAttemptId = await answerAll(ai, run, 6);
    const reads = vi.spyOn(learning, "getLearningTopicStates");
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done.status).toBe("waiting-for-input"); expect(done.recovery?.evaluation?.status).toBe("improving");
    expect(reads).toHaveBeenCalledWith({ userId: owner.id, courseId: f.course.id, topicId: f.topic.id });
    expect(done.recovery!.endingState.questionsAttempted).toBe(26);
    expect(await db().questionAttempt.count({ where: { userId: owner.id, question: { topicMappings: { some: { topicId: f.topic.id } } } } })).toBe(26);
    expect(await db().learningProgress.findFirst({ where: { topicId: unrelated.topic.id } })).toEqual(untouched);
    const verification = await answerAll(ai, done, 5);
    const final = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: verification }, owner.headers);
    expect(final).toMatchObject({ status: "completed", recovery: { status: "recovered", endingState: { questionsAttempted: 31 } } });
  });
  it("keeps normal Tutor and Quiz document retrieval enabled", async () => {
    const f = await fixture(); const ai = boundary(); const documents = vi.spyOn(categories, "documentContext");
    await ai.service.runWorkflow(f.input, owner.headers);
    expect(documents.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(documents.mock.calls.every(([args]) => args.userId === owner.id && args.input.courseId === f.course.id)).toBe(true);
  });
  it("ignores a late resume for a previous wait checkpoint without claiming the next one", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 0);
    const next = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    const prepare = vi.fn(async () => ({})); const execute = vi.fn(async () => ({ summary: "Must not execute" }));
    const result = await new WorkflowEngine(execute, new ContextReadCache()).resume(weakTopicRecovery, run.runId, owner.headers, prepare, run.waitingFor!);
    expect(result.waitingFor).toEqual(next.waitingFor); expect(result.status).toBe("waiting-for-input");
    expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it("excludes the student's time away from the execution budget", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 6);
    await db().workflowRun.update({ where: { id: run.runId }, data: { startedAt: new Date(Date.now() - 7 * DAY) } });
    expect((await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers)).status).toBe("completed");
  });
  it("enforces the quiz generation limit as well as the Tutor limit after pause", async () => {
    const f = await fixture({ mastery: 30 }); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 6);
    await db().workflowStepRun.updateMany({ where: { workflowRunId: run.runId, stepId: "quiz-1" }, data: { attempts: 2 } });
    const done = await ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers);
    expect(done).toMatchObject({ status: "failed", errorCode: "LIMIT_EXCEEDED" });
    expect(ai.calls.filter((c) => c === "quiz_generation")).toHaveLength(1);
  });
  it.each(["quiz", "course"] as const)("handles deletion of a pending %s", async (removed) => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const quizAttemptId = await answerAll(ai, run, 6);
    if (removed === "quiz") await db().quiz.delete({ where: { id: run.waitingFor!.referenceId } });
    else await db().course.delete({ where: { id: f.course.id } });
    await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId }, owner.headers)).rejects.toMatchObject({ code: removed === "quiz" ? "REFERENCE_NOT_FOUND" : "TOPIC_NOT_FOUND" });
    expect((await ai.service.getRun(run.runId, owner.headers)).recovery?.evaluation).toBeNull();
  });
  it("does not reset call/time budgets or replay steps across a generic engine pause", async () => {
    const f = await fixture(); const ai = boundary(); const run = await ai.service.runWorkflow(f.input, owner.headers);
    const row = await db().workflowRun.findUniqueOrThrow({ where: { id: run.runId } }); expect(row.activeDurationMs).toBeGreaterThan(0);
    const execute = vi.fn(async () => ({ summary: "Unexpected replay" }));
    const engine = new WorkflowEngine(execute, new ContextReadCache());
    const wrongDefinition = { ...weakTopicRecovery, id: "exam-preparation" as const };
    await expect(engine.resume(wrongDefinition, run.runId, owner.headers, async () => ({}))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(execute).not.toHaveBeenCalled();
  });
});
