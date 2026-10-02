import { evaluateDeterministic } from "@/server/ai/evaluation/deterministic";
import { workflowObservation } from "@/server/ai/evaluation/observations";
import "dotenv/config";
import { guardedWorkflowFixture } from "./guard-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { WorkflowService, WorkflowRegistry, examPreparation } from "@/server/workflows";
import { WorkflowEngine } from "@/server/workflows/engine";
import { WorkflowError } from "@/server/workflows/errors";
import type { WorkflowContext, WorkflowDefinition, WorkflowInput } from "@/server/workflows/types";
import { ContextReadCache } from "@/server/context/cache";
import { buildUserContext } from "@/server/context/builder";
import * as categories from "@/server/context/categories";
import { createStudentAgentRegistry, createStudentAgentService } from "@/server/agents/student-service";
import { AgentExecutor } from "@/server/agents/executor";
import { QuizAgentService } from "@/server/agents/quiz/service";
import type { PlanningBrief } from "@/server/agents/study-planner/types";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import { AIError } from "@/server/ai/errors";

const DAY = 86400000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
type Actor = { id: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor, other: Actor;
async function actor(): Promise<Actor> {
  const response = await auth().api.signUpEmail({ body: { name: "Workflow Student", email: `workflow-${randomUUID()}@example.test`, password: "Workflow-fixture-passphrase!" }, asResponse: true });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const result = { id: body.user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  actors.push(result);
  await db().profile.create({ data: { userId: result.id, school: "Test University", program: "CS", currentYear: 2, semester: "Fall 2026", academicGoal: "Prepare for exams", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return result;
}
async function fixture(user = owner, mastery: number | null = 30, confidence = 85, names = ["Induction"]) {
  const course = await db().course.create({ data: { userId: user.id, courseCode: `MATH ${randomUUID().slice(0, 6)}`, courseName: "Mathematics", semester: "Fall 2026" } });
  const exam = await db().exam.create({ data: { userId: user.id, courseId: course.id, title: "Midterm", examDate: new Date(day(8) + "T18:00:00Z"), topics: names } });
  let topicId: string | undefined;
  if (mastery !== null) {
    const topic = await db().learningTopic.create({ data: { userId: user.id, courseId: course.id, name: names[0], normalizedName: names[0].toLowerCase(), progress: { create: {
      masteryScore: mastery, confidenceScore: confidence, recentAccuracy: mastery, questionsAttempted: 10, correctAnswers: 3, incorrectAnswers: 7,
      mediumAttempts: 10, scoreTotal: 3, difficultyWeightedScore: 3, difficultyWeightTotal: 10, practiceSessions: 3,
      firstPracticedAt: new Date(Date.now() - 10 * DAY), lastPracticedAt: new Date(Date.now() - DAY), trend: mastery < 70 ? "DECLINING" : "STABLE",
    } } } }); topicId = topic.id;
  }
  const input: WorkflowInput = { workflowId: "exam-preparation", goal: "Help me prepare for my midterm.", courseId: course.id, examId: exam.id };
  return { user, course, exam, topicId, input };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function existingPlan(f: Fixture, options: { missed?: boolean; completed?: boolean } = {}) {
  return db().studyPlan.create({ data: {
    userId: f.user.id, title: "Existing exam plan", summary: "Keep useful work", startDate: new Date(day(-2)), endDate: new Date(day(8)), totalPlannedMinutes: 60,
    tasks: { create: [
      { title: "Review Induction", date: new Date(day(options.missed ? -1 : 1)), activityType: "REVIEW" as const, durationMinutes: 30, priority: 80, reason: "Exam preparation", courseId: f.course.id, examId: f.exam.id, topicId: f.topicId, sourceDueDate: f.exam.examDate, sourceMasteryScore: 30, sourceConfidenceScore: 85 },
      ...(options.completed ? [{ title: "Completed work", date: new Date(day(-2)), activityType: "REVIEW" as const, durationMinutes: 30, priority: 60, reason: "Already done", status: "COMPLETED" as const, courseId: f.course.id, examId: f.exam.id, sourceDueDate: f.exam.examDate }] : []),
    ] },
  }, include: { tasks: true } });
}
function boundary(options: { fail?: string; code?: "PROVIDER_FAILURE" | "RATE_LIMIT" | "AUTHENTICATION"; failures?: number; gate?: () => Promise<void> } = {}) {
  const calls: string[] = [], structured: AIStructuredRequest<unknown>[] = [];
  let failureCount = 0;
  const maybeFail = (name: string) => {
    calls.push(name);
    if (options.fail === name && failureCount++ < (options.failures ?? 1)) throw new AIError(options.code ?? "PROVIDER_FAILURE");
  };
  const transport: AIProvider = {
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      maybeFail(request.schemaName); structured.push(request as AIStructuredRequest<unknown>);
      let data: unknown;
      if (request.schemaName === "academic_manager") {
        if (options.gate) await options.gate();
        data = { summary: "Prioritize the upcoming exam and repair demonstrated weaknesses." };
      } else if (request.schemaName.startsWith("study_plan")) {
        const brief = JSON.parse(request.messages[0].content.split("Execution parameters: ")[1]) as PlanningBrief;
        const slot = brief.availability.find((a) => a.availableMinutes >= 15)!;
        const signal = brief.signals.find((s) => s.linkedExamId)!;
        const duration = Math.min(30, slot.availableMinutes, brief.maximumSessionMinutes);
        data = { title: "Exam plan", summary: "Practice the selected exam topics.", startDate: brief.startDate, endDate: brief.endDate, totalPlannedMinutes: duration,
          days: [{ date: slot.date, totalMinutes: duration, sessions: [{ signalId: signal.id, title: "Prepare for the exam", topic: signal.topic, activityType: signal.suggestedActivity, durationMinutes: duration }] }] };
      } else if (request.schemaName === "quiz_generation") {
        const params = JSON.parse(request.messages[0].content.split("Execution parameters: ")[1]) as { count: number; topic: string; difficulty: string };
        const topics = params.topic.split(", ");
        data = { quizTitle: "Exam practice", topic: params.topic, difficulty: params.difficulty === "adaptive" ? "medium" : params.difficulty,
          questions: Array.from({ length: params.count }, (_, i) => ({ type: i % 2 ? "short-answer" : "true-false", prompt: `Claim ${i + 1} about ${topics[i % topics.length]}: an inductive proof needs a base case.`, choices: i % 2 ? null : ["True", "False"], correctAnswer: "true", explanation: "A base case establishes the start.", topics: [topics[i % topics.length]] })) };
      } else throw new Error(`Unexpected AI routing or generation: ${request.schemaName}`);
      return { id: "workflow-fixture", model: "fixture", text: JSON.stringify(data), data: data as T };
    },
    async generateText() { maybeFail("tutor"); return { id: "tutor", model: "fixture", text: "Induction starts with a base case. Assume the statement for k, then prove it for k+1. Check that the assumption is applied only after establishing the base case." }; },
    streamText() { throw new Error("No separate pipeline."); }, generateEmbedding() { throw new Error("No external embeddings."); },
  };
  const provider = guardedWorkflowFixture(transport);
  const getProvider = () => provider;
  return { provider, getProvider, calls, structured, service: new WorkflowService({ getProvider }) };
}
beforeAll(async () => { owner = await actor(); other = await actor(); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { for (const a of actors) await db().user.deleteMany({ where: { id: a.id } }); await db().$disconnect(); });

describe.sequential("Exam Preparation with existing agents and real owned persistence", () => {
  it("validates and freezes a registered bounded definition", () => {
    const registry = new WorkflowRegistry(createStudentAgentRegistry()); registry.register(examPreparation);
    expect(registry.get("exam-preparation").steps).toHaveLength(5);
    expect(Object.isFrozen(registry.get("exam-preparation").steps)).toBe(true);
    expect(() => registry.register(examPreparation)).toThrow(WorkflowError);
    for (const definition of [{ ...examPreparation, maxSteps: 4 }, { ...examPreparation, maxRetries: 2 }, { ...examPreparation, steps: [...examPreparation.steps, examPreparation.steps[0]] }]) {
      expect(() => new WorkflowRegistry(createStudentAgentRegistry()).register(definition)).toThrow(WorkflowError);
    }
  });
  it("creates a plan, explains a demonstrated weakness and persists a useful practice quiz end-to-end", async () => {
    const f = await fixture(); const ai = boundary();
    const executor = vi.spyOn(AgentExecutor.prototype, "executeStructured");
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    expect(result, JSON.stringify(result)).toMatchObject({ workflowId: "exam-preparation", status: "completed", errorCode: null });
    expect(result.completedSteps).toEqual(["analyze", "plan", "tutor", "practice"]);
    expect(result.steps.find((s) => s.stepId === "diagnostic")).toMatchObject({ status: "skipped", attempts: 0 });
    expect(ai.calls).toEqual(["academic_manager", "study_plan", "tutor", "quiz_generation"]);
    expect(evaluateDeterministic({ profile: "workflow", request: "Evaluate observed workflow", output: workflowObservation(result), expected: { expectedStatus: "completed", maximumCalls: 6, maximumTutorCalls: 2, maximumQuizCalls: 2, requiredTerms: ["studyPlanId", "quizId"] } }).passed).toBe(true);
    expect(ai.structured.every((request) =>
      request.messages.some((message) => message.content.includes("[ADAPTATION]")),
    )).toBe(true);
    expect(executor).toHaveBeenCalledTimes(3);
    expect(await db().studyPlan.findFirst({ where: { id: result.outputs.studyPlanId as string, userId: owner.id } })).not.toBeNull();
    expect(await db().quiz.count({ where: { id: result.outputs.quizId as string, userId: owner.id, courseId: f.course.id } })).toBe(1);
    expect(await db().workflowStepRun.count({ where: { workflowRunId: result.runId, userId: owner.id } })).toBe(5);
    expect(JSON.stringify(result)).not.toMatch(/Execution parameters|correctAnswer|api_key|Reference data only/);
  });
  it("skips Study Planner when an active exam plan is current", async () => {
    const f = await fixture(); const plan = await existingPlan(f); const ai = boundary();
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    expect(result.status).toBe("completed"); expect(result.outputs.studyPlanId).toBe(plan.id);
    expect(result.steps.find((s) => s.stepId === "plan")).toMatchObject({ status: "skipped", attempts: 0 });
    expect(ai.calls).not.toContain("study_plan"); expect(ai.calls).not.toContain("study_plan_update");
  });
  it("uses diagnostics for low confidence and skips unjustified Tutor work", async () => {
    const f = await fixture(owner, 30, 15); const ai = boundary();
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    expect(result.status).toBe("completed"); expect(result.completedSteps).toEqual(["analyze", "plan", "diagnostic"]);
    expect(ai.calls).not.toContain("tutor"); expect(result.outputs.diagnostic).toMatchObject({ mode: "diagnostic", questionCount: 5, targetTopics: ["Induction"] });
    expect(ai.structured.find((r) => r.schemaName === "quiz_generation")!.messages.at(-1)!.content).toContain("without assuming low mastery");
  });
  it("diagnoses unpracticed exam coverage while retaining useful Tutor support for proven weaknesses", async () => {
    const f = await fixture(owner, 30, 85, ["Induction", "Logic"]); const ai = boundary();
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    expect(result.status).toBe("completed"); expect(result.completedSteps).toEqual(["analyze", "plan", "diagnostic", "tutor"]);
    expect(result.outputs.diagnostic).toMatchObject({ targetTopics: ["Logic"] });
    expect(ai.calls.filter((c) => c === "quiz_generation")).toHaveLength(1);
  });
  it("handles missing learning evidence with a diagnostic instead of declaring weakness", async () => {
    const f = await fixture(owner, null); const ai = boundary();
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    expect(result.status).toBe("completed"); expect(result.outputs.diagnostic).toMatchObject({ targetTopics: ["Induction"] });
    expect(ai.calls).not.toContain("tutor");
  });
  it("passes bounded priorities and learning state to Planner and Quiz", async () => {
    const f = await fixture(); const ai = boundary();
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    expect(result.status).toBe("completed");
    const plan = ai.structured.find((r) => r.schemaName === "study_plan")!;
    expect(plan.messages.at(-1)!.content).toContain("Academic priority:"); expect(plan.messages.at(-1)!.content).toContain("Induction");
    const quiz = ai.structured.find((r) => r.schemaName === "quiz_generation")!;
    expect(quiz.messages[1].content).toContain('"confidence":85'); expect(quiz.messages[1].content).toContain('"trend":"declining"');
    const row = await db().workflowRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(JSON.stringify(row.context).length).toBeLessThan(24000);
    expect(JSON.stringify(row.context)).not.toContain("Induction starts with a base case");
  });
  it("reuses unchanged profile and learning reads across short agent calls", async () => {
    const f = await fixture(); const ai = boundary();
    const profile = vi.spyOn(categories, "profileContext"), learning = vi.spyOn(categories, "learningContext");
    expect((await ai.service.runWorkflow(f.input, owner.headers)).status).toBe("completed");
    expect(profile).toHaveBeenCalledTimes(1); expect(learning).toHaveBeenCalledTimes(1);
  });
  it("respects explicit availability in persisted sessions", async () => {
    const f = await fixture(); const ai = boundary();
    const result = await ai.service.runWorkflow({ ...f.input, availability: [{ date: day(0), availableMinutes: 15 }, { date: day(1), availableMinutes: 0 }] }, owner.headers);
    expect(result.status).toBe("completed");
    const tasks = await db().studyTask.findMany({ where: { studyPlanId: result.outputs.studyPlanId as string } });
    expect(tasks.reduce((sum, t) => sum + t.durationMinutes, 0)).toBeLessThanOrEqual(15);
  });
  it("updates missed work while preserving completed tasks", async () => {
    const f = await fixture(); const plan = await existingPlan(f, { missed: true, completed: true }); const ai = boundary();
    const result = await ai.service.runWorkflow({ ...f.input, studyPlanId: plan.id }, owner.headers);
    expect(result.status).toBe("completed"); expect(result.outputs.studyPlanId).toBe(plan.id); expect(ai.calls).toContain("study_plan_update");
    const completed = plan.tasks.find((t) => t.status === "COMPLETED")!;
    expect(await db().studyTask.findUnique({ where: { id: completed.id } })).toMatchObject({ status: "COMPLETED", title: "Completed work" });
    expect(await db().studyPlan.count({ where: { userId: owner.id, tasks: { some: { examId: f.exam.id } } } })).toBe(1);
  });
  it("replans when the exam date or available time changes", async () => {
    const f = await fixture(); const plan = await existingPlan(f); const ai = boundary();
    await db().exam.update({ where: { id: f.exam.id }, data: { examDate: new Date(day(6) + "T18:00:00Z") } });
    const result = await ai.service.runWorkflow({ ...f.input, studyPlanId: plan.id, availability: [{ date: day(0), availableMinutes: 15 }] }, owner.headers);
    expect(result.status).toBe("completed"); expect(ai.calls).toContain("study_plan_update");
  });
  it("preserves other exams' future sessions when updating a shared plan", async () => {
    const f = await fixture(), second = await fixture(); const plan = await existingPlan(f, { missed: true }); const ai = boundary();
    const retained = await db().studyTask.create({ data: { userId: owner.id, studyPlanId: plan.id, courseId: second.course.id, examId: second.exam.id, title: "Other exam", date: new Date(day(15)), activityType: "PRACTICE", durationMinutes: 30, priority: 70, reason: "Keep this session", sourceDueDate: second.exam.examDate } });
    const result = await ai.service.runWorkflow({ ...f.input, studyPlanId: plan.id }, owner.headers);
    expect(result.status).toBe("completed");
    expect(await db().studyTask.findUnique({ where: { id: retained.id } })).toMatchObject({ status: "PLANNED", title: "Other exam" });
    expect((await db().studyPlan.findUniqueOrThrow({ where: { id: plan.id } })).endDate.toISOString().slice(0, 10)).toBe(day(15));
  });
  it("uses fresh grading evidence to reconsider the plan while keeping a partially answered quiz", async () => {
    const f = await fixture(owner, null); const ai = boundary();
    const first = await ai.service.runWorkflow(f.input, owner.headers);
    const quiz = new QuizAgentService(createStudentAgentRegistry(), { executor: { getProvider: ai.getProvider } });
    const saved = await quiz.getQuiz(first.outputs.quizId as string, owner.headers);
    await quiz.evaluateAnswer({ quizId: saved.id, questionId: saved.questions[0].id, userAnswer: "true" }, owner.headers);
    const second = await ai.service.runWorkflow(f.input, owner.headers);
    expect(second.status).toBe("completed"); expect(second.outputs.studyPlanId).toBe(first.outputs.studyPlanId); expect(second.outputs.quizId).toBe(saved.id);
    expect(ai.calls).toContain("study_plan_update"); expect(ai.calls.filter((c) => c === "quiz_generation")).toHaveLength(1);
  });
  it("reuses a relevant unfinished quiz on repeated runs without duplicate generation", async () => {
    const f = await fixture(owner, null); const ai = boundary();
    const first = await ai.service.runWorkflow(f.input, owner.headers);
    expect(first.status).toBe("completed");
    const second = await ai.service.runWorkflow(f.input, owner.headers);
    expect(second.status).toBe("completed"); expect(second.outputs.quizId).toBe(first.outputs.quizId);
    expect(ai.calls.filter((c) => c === "quiz_generation")).toHaveLength(1);
    expect(ai.calls.filter((c) => c.startsWith("study_plan"))).toHaveLength(1);
  });
  it("continues with a warning after an optional Tutor transient failure is exhausted", async () => {
    const f = await fixture(); const ai = boundary({ fail: "tutor", failures: 2 });
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    expect(result.status).toBe("completed"); expect(result.warnings).toEqual(["tutor: PROVIDER_FAILURE"]);
    expect(result.steps.find((s) => s.stepId === "tutor")).toMatchObject({ status: "failed", attempts: 2 }); expect(result.completedSteps).toContain("practice");
  });
  it("retries a transient generation failure once without duplicating persisted plans", async () => {
    const f = await fixture(); const ai = boundary({ fail: "study_plan" });
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    expect(result.status).toBe("completed"); expect(result.steps.find((s) => s.stepId === "plan")!.attempts).toBe(2);
    expect(await db().studyPlan.count({ where: { userId: owner.id, tasks: { some: { examId: f.exam.id } } } })).toBe(1);
  });
  it("does not retry authentication failures or execute later steps", async () => {
    const f = await fixture(); const ai = boundary({ fail: "study_plan", code: "AUTHENTICATION" });
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    expect(result).toMatchObject({ status: "failed", errorCode: "AUTHENTICATION" }); expect(ai.calls).toEqual(["academic_manager", "study_plan"]);
  });
  it("fails on persistence errors without retrying uncertain writes", async () => {
    const f = await fixture(); const ai = boundary();
    vi.spyOn(db().studyPlan, "create").mockRejectedValueOnce(new Error("private storage stack credential"));
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    expect(result).toMatchObject({ status: "failed", errorCode: "STORAGE_FAILURE" }); expect(ai.calls).toEqual(["academic_manager", "study_plan"]);
    expect(JSON.stringify(result)).not.toContain("private storage");
  });
  it("deduplicates simultaneous runs for the same owned exam", async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const ai = boundary({ gate: async () => { entered(); await gate; } });
    const firstPromise = ai.service.runWorkflow(f.input, owner.headers); await waiting;
    let second;
    try { second = await ai.service.runWorkflow(f.input, owner.headers); } finally { release(); }
    const first = await firstPromise;
    expect(second!.runId).toBe(first.runId); expect(second!.status).toBe("running");
    expect(ai.calls.filter((c) => c === "academic_manager")).toHaveLength(1);
  });
  it("cancels cooperatively and keeps completed audit data without starting another step", async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const ai = boundary({ gate: async () => { entered(); await gate; } });
    const pending = ai.service.runWorkflow(f.input, owner.headers); await waiting;
    const run = await db().workflowRun.findFirstOrThrow({ where: { userId: owner.id, activeKey: { not: null } } });
    try { expect((await ai.service.cancelRun(run.id, owner.headers)).status).toBe("cancelled"); } finally { release(); }
    expect((await pending).status).toBe("cancelled"); expect(ai.calls).toEqual(["academic_manager"]);
  });
  it("enforces ownership of workflow runs and every selected academic artifact", async () => {
    const f = await fixture(), foreign = await fixture(other); const foreignPlan = await existingPlan(foreign); const ai = boundary();
    const otherQuiz = await db().quiz.create({ data: { userId: other.id, courseId: foreign.course.id, title: "PRIVATE", difficulty: "MEDIUM" } });
    for (const input of [{ ...f.input, examId: foreign.exam.id }, { ...f.input, courseId: foreign.course.id }, { ...f.input, studyPlanId: foreignPlan.id }, { ...f.input, quizId: otherQuiz.id }]) await expect(ai.service.runWorkflow(input, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
    expect(ai.calls).toEqual([]);
    const result = await ai.service.runWorkflow(f.input, owner.headers);
    await expect(ai.service.getRun(result.runId, other.headers)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await expect(ai.service.cancelRun(result.runId, other.headers)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });
  it("rejects unauthenticated, forged context and unsupported workflow requests", async () => {
    const f = await fixture(); const ai = boundary();
    await expect(ai.service.runWorkflow(f.input, new Headers())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    for (const extra of [{ userId: other.id }, { context: { userId: other.id } }, { workflowId: "career-preparation" }, { availability: [{ date: "2026-99-99", availableMinutes: 30 }] }]) await expect(ai.service.runWorkflow({ ...f.input, ...extra } as WorkflowInput, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(ai.calls).toEqual([]);
  });
  it("checks selected documents and refuses unauthorized scope before any AI call", async () => {
    const f = await fixture(); const ai = boundary();
    const document = await db().document.create({ data: { userId: other.id, title: "PRIVATE", originalFileName: "private.txt", fileType: "TXT", fileSize: 10, storageKey: randomUUID() } });
    try { await expect(ai.service.runWorkflow({ ...f.input, documentIds: [document.id] }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" }); expect(ai.calls).toEqual([]); }
    finally { await db().document.delete({ where: { id: document.id } }); await db().fileDeletion.deleteMany({ where: { userId: other.id, storageKey: document.storageKey } }); }
  });
  it("checks upcoming-exam bounds and no-availability without unnecessary later calls", async () => {
    const f = await fixture(); const ai = boundary();
    await db().exam.update({ where: { id: f.exam.id }, data: { examDate: new Date(day(-1)) } });
    await expect(ai.service.runWorkflow(f.input, owner.headers)).rejects.toMatchObject({ code: "EXAM_UNAVAILABLE" }); expect(ai.calls).toEqual([]);
    await db().exam.update({ where: { id: f.exam.id }, data: { examDate: new Date(day(8)) } });
    const result = await ai.service.runWorkflow({ ...f.input, availability: [{ date: day(0), availableMinutes: 0 }] }, owner.headers);
    expect(result).toMatchObject({ status: "failed", errorCode: "NO_AVAILABILITY" }); expect(ai.calls).toEqual(["academic_manager"]);
  });
  it("requires exam selection when multiple candidates remain and accepts an explicit exam beyond 30 days", async () => {
    const f = await fixture(); const ai = boundary();
    await db().exam.create({ data: { userId: owner.id, courseId: f.course.id, title: "Final", examDate: new Date(day(45)), topics: ["Induction"] } });
    await expect(ai.service.runWorkflow({ workflowId: "exam-preparation", goal: "Help me prepare", courseId: f.course.id }, owner.headers)).rejects.toMatchObject({ code: "EXAM_SELECTION_REQUIRED" });
    const final = await db().exam.findFirstOrThrow({ where: { courseId: f.course.id, title: "Final" } });
    const result = await ai.service.runWorkflow({ ...f.input, examId: final.id }, owner.headers);
    expect(result.status).toBe("completed");
  });
  it("preserves the direct single-agent path", async () => {
    const f = await fixture(); const ai = boundary();
    const result = await createStudentAgentService({ executor: { getProvider: ai.getProvider } }).handleAgentRequest({ request: "Explain induction", courseId: f.course.id }, owner.headers);
    expect(result).toMatchObject({ ok: true, agent: { id: "tutor" } });
    expect(await db().workflowRun.count({ where: { userId: owner.id, activeKey: { contains: f.exam.id } } })).toBe(0);
    expect(ai.calls).toEqual(["tutor"]);
  });
});

async function initial(f: Fixture): Promise<WorkflowContext> {
  const context = await buildUserContext({ request: "Exam", courseId: f.course.id, examId: f.exam.id, options: { exams: true } }, owner.headers);
  return { goal: f.input.goal, courseId: f.course.id, exam: context.exams![0], priorities: [], topics: [], studyPlanId: null, planCurrent: false, quizId: null, quizCurrent: false, quizMode: "diagnostic", tutorTopic: null, targetTopics: ["Induction"], previousStepSummaries: [] };
}
function smallDefinition(policy: WorkflowDefinition["failurePolicy"] = "fail-workflow"): WorkflowDefinition {
  return { ...examPreparation, failurePolicy: policy, steps: [
    { id: "first", agentId: "tutor", purpose: "First step", outputKey: "first", input: () => ({ request: "Explain induction" }) },
    { id: "second", agentId: "notes", purpose: "Second step", outputKey: "second", input: (c) => ({ request: c.previousStepSummaries[0]?.summary ?? "Continue safely" }) },
  ] };
}
describe.sequential("Workflow Engine bounded coordination", () => {
  it.each(["skip-step", "continue-with-warning", "fail-workflow"] as const)("honors %s explicitly", async (policy) => {
    const f = await fixture(); const calls: string[] = [];
    const engine = new WorkflowEngine(async (step) => { calls.push(step.id); if (step.id === "first") throw new WorkflowError("SOURCE_CONTEXT_UNAVAILABLE"); return { summary: "Second step complete" }; }, new ContextReadCache());
    const result = await engine.run(smallDefinition(policy), f.input, await initial(f), owner.headers);
    expect(result.status).toBe(policy === "fail-workflow" ? "failed" : "completed");
    expect(calls).toEqual(policy === "fail-workflow" ? ["first"] : ["first", "second"]);
    expect(result.warnings.length).toBe(policy === "continue-with-warning" ? 1 : 0);
  });
  it("passes only structured state and summaries through code-based input mapping", async () => {
    const f = await fixture(); const requests: string[] = [];
    const engine = new WorkflowEngine(async (step, input, state) => { requests.push(input.request); if (step.id === "second") expect(state.priorities[0].score).toBe(90); return { summary: "Review induction", patch: { priorities: [{ reason: "Weak exam concept", score: 90 }] } }; }, new ContextReadCache());
    expect((await engine.run(smallDefinition(), f.input, await initial(f), owner.headers)).status).toBe("completed");
    expect(requests).toEqual(["Explain induction", "Review induction"]);
  });
  it("enforces execution and repeated-agent limits independently of registration", async () => {
    const f = await fixture(); let calls = 0;
    const engine = new WorkflowEngine(async () => { calls++; return { summary: "Done" }; }, new ContextReadCache());
    const tooMany = { ...smallDefinition(), maxSteps: 1 };
    expect((await engine.run(tooMany, f.input, await initial(f), owner.headers)).errorCode).toBe("LIMIT_EXCEEDED"); expect(calls).toBe(0);
    const repeated = { ...smallDefinition(), maxAgentCalls: 1, steps: smallDefinition().steps.map((step) => ({ ...step, agentId: "tutor" as const })) };
    expect((await engine.run(repeated, f.input, await initial(f), owner.headers)).errorCode).toBe("LIMIT_EXCEEDED"); expect(calls).toBe(1);
  });
  it("enforces a duration deadline before starting subsequent work", async () => {
    const f = await fixture(); const state = await initial(f); let elapsed = 0, calls = 0; const now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now + elapsed);
    const engine = new WorkflowEngine(async () => { calls++; elapsed = 1500; return { summary: "Done" }; }, new ContextReadCache());
    const result = await engine.run({ ...smallDefinition(), maxDurationMs: 1000 }, f.input, state, owner.headers);
    expect(result.errorCode).toBe("LIMIT_EXCEEDED"); expect(calls).toBe(1);
  });
  it("never retries an authorization failure even under optional-step policy", async () => {
    const f = await fixture(); let calls = 0;
    const engine = new WorkflowEngine(async () => { calls++; throw new WorkflowError("REFERENCE_NOT_FOUND"); }, new ContextReadCache());
    const result = await engine.run(smallDefinition("continue-with-warning"), f.input, await initial(f), owner.headers);
    expect(result).toMatchObject({ status: "failed", errorCode: "REFERENCE_NOT_FOUND" }); expect(calls).toBe(1);
  });
  it("invalidates learning after quiz grading before a later context read", async () => {
    const f = await fixture(owner, null); const ai = boundary(); const cache = new ContextReadCache();
    const quiz = new QuizAgentService(createStudentAgentRegistry(), { executor: { getProvider: ai.getProvider, contextCache: cache } });
    const generated = await quiz.generateQuiz({ request: "Create a quiz", courseId: f.course.id, topic: "Induction", count: 5, difficulty: "medium" }, owner.headers);
    // Generation above is outside this test's engine; discard its pre-write read.
    cache.invalidate(["learning"]);
    const read = () => buildUserContext({ request: "Learning", courseId: f.course.id, options: { learning: true } }, owner.headers, cache);
    const before = await read(); expect(before.learning!.recommendedTopics[0].questionsAttempted).toBe(0);
    const definition = { ...smallDefinition(), steps: [
      { ...smallDefinition().steps[0], agentId: "quiz" as const, invalidates: ["learning" as const, "academicOverview" as const] }, smallDefinition().steps[1],
    ] };
    const engine = new WorkflowEngine(async (step) => {
      if (step.id === "first") await quiz.evaluateAnswer({ quizId: generated.id, questionId: generated.questions[0].id, userAnswer: "true" }, owner.headers);
      else { const refreshed = await read(); expect(refreshed.learning!.recommendedTopics[0].questionsAttempted).toBe(1); }
      return { summary: "Processed current learning evidence" };
    }, cache);
    expect((await engine.run(definition, f.input, await initial(f), owner.headers)).status).toBe("completed");
  });
  it("does not reuse cached personal context across users or selected courses", async () => {
    const f = await fixture(), foreign = await fixture(other); const cache = new ContextReadCache();
    await buildUserContext({ request: "Learning", courseId: f.course.id, options: { profile: true, learning: true } }, owner.headers, cache);
    await expect(buildUserContext({ request: "Learning", courseId: f.course.id, options: { learning: true } }, other.headers, cache)).rejects.toThrow();
    const context = await buildUserContext({ request: "Learning", courseId: foreign.course.id, options: { learning: true } }, other.headers, cache);
    expect(context.learning!.weakTopics.every((t) => t.course.id === foreign.course.id)).toBe(true);
  });
});
