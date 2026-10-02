import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { createStudentAgentRegistry, createStudentAgentService } from "@/server/agents/student-service";
import { AgentRouter } from "@/server/agents/router";
import { AgentExecutor } from "@/server/agents/executor";
import { AgentService } from "@/server/agents/core";
import { AgentRegistry } from "@/server/agents/registry";
import { executeAcademicManager, getAcademicManagerAgentDefinition } from "@/server/agents/academic-manager";
import type { AcademicManagerResponse, AcademicSnapshot } from "@/server/agents/academic-manager";
import type { AgentRequestInput, AgentRequestResult } from "@/server/agents/core/types";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import * as contexts from "@/server/context/builder";
import * as retrieval from "@/server/documents/retrieval";
import { formatContextForAI } from "@/server/context/format";

const DAY = 86_400_000;
const base = Date.now();
const date = (offset: number) => new Date(base + offset * DAY);
const day = (offset: number) => new Date(date(offset).toISOString().slice(0, 10) + "T00:00:00Z");
type Actor = { id: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor, foreign: Actor;
let math: string, cs: string, oldCourse: string, foreignCourse: string;
let mathExam: string, foreignExam: string, planId: string;

async function actor(name: string): Promise<Actor> {
  const response = await auth().api.signUpEmail({
    body: { name, email: `manager-${randomUUID()}@example.test`, password: "Manager-test-passphrase-2026!" }, asResponse: true,
  });
  expect(response.status).toBe(200);
  const data = await response.json() as { user: { id: string } };
  const result = { id: data.user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") }) };
  actors.push(result);
  await db().profile.create({ data: { userId: result.id, school: "Manager University", program: "CS", currentYear: 2, semester: "Fall 2026", academicGoal: "Prepare for exams", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return result;
}
async function course(userId: string, name: string, semester = "Fall 2026") {
  return (await db().course.create({ data: { userId, courseCode: name, courseName: name, semester } })).id;
}
async function learning(courseId: string, name: string, mastery: number, confidence: number) {
  await db().learningTopic.create({ data: {
    userId: owner.id, courseId, name, normalizedName: name.toLowerCase(),
    progress: { create: {
      masteryScore: mastery, confidenceScore: confidence, recentAccuracy: mastery,
      questionsAttempted: 10, correctAnswers: 4, incorrectAnswers: 6,
      scoreTotal: 4, difficultyWeightedScore: 4, difficultyWeightTotal: 10,
      practiceSessions: 3, mediumAttempts: 10, firstPracticedAt: date(-10), lastPracticedAt: date(-1),
      trend: mastery < 70 ? "DECLINING" : "STABLE",
    } },
  } });
}
function boundary() {
  let invalid: unknown;
  const calls: AIStructuredRequest<unknown>[] = [];
  const provider: AIProvider = {
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      calls.push(request as AIStructuredRequest<unknown>);
      if (request.schemaName !== "academic_manager") throw new Error("No specialist execution or routing generation expected.");
      const data = invalid ?? { summary: "Address overdue work first, then review the upcoming exam's weak topics." };
      return { id: "manager-response", model: "manager-fixture", text: JSON.stringify(data), data: data as T };
    },
    generateText() { throw new Error("Manager must use structured execution."); },
    streamText() { throw new Error("No streaming."); },
    generateEmbedding() { throw new Error("No RAG by default."); },
  };
  const getProvider = vi.fn(() => provider);
  return {
    calls, getProvider,
    service: createStudentAgentService({ executor: { getProvider }, router: { getProvider } }),
    setInvalid(data: unknown) { invalid = data; },
  };
}
function unwrap(result: AgentRequestResult): AcademicManagerResponse {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, agent: { id: "academic-manager" } });
  if (!result.ok) throw new Error(result.error.message);
  return result.response.structuredData as AcademicManagerResponse;
}
async function overview(): Promise<AcademicSnapshot> {
  const result = await contexts.buildUserContext({ request: "Academic overview", options: getAcademicManagerAgentDefinition().contextRequirements }, owner.headers);
  expect(result.academicOverview).toBeDefined();
  return result.academicOverview!;
}

beforeAll(async () => {
  owner = await actor("Manager Student"); foreign = await actor("Foreign Manager Student");
  math = await course(owner.id, "MATH 1240"); cs = await course(owner.id, "COMP 2140");
  oldCourse = await course(owner.id, "OLD SEMESTER", "Winter 2026"); foreignCourse = await course(foreign.id, "FOREIGN SECRET");
  for (const [title, courseId, userId, offset, status] of [
    ["Proof assignment", math, owner.id, -1, "TODO"],
    ["Old overdue still open", math, owner.id, -60, "TODO"],
    ["Upcoming math", math, owner.id, 2, "TODO"],
    ["Upcoming CS", cs, owner.id, 3, "IN_PROGRESS"],
    ["Completed homework", math, owner.id, -2, "COMPLETED"],
    ["Old semester work", oldCourse, owner.id, -1, "TODO"],
    ["FOREIGN assignment", foreignCourse, foreign.id, -1, "TODO"],
  ] as const) {
    await db().assignment.create({ data: { title, courseId, userId, dueDate: date(offset), status, completedAt: status === "COMPLETED" ? date(-1) : null, priority: "HIGH", estimatedHours: 2 } });
  }
  mathExam = (await db().exam.create({ data: { userId: owner.id, courseId: math, title: "Math midterm", examDate: date(2), topics: ["Induction"] } })).id;
  await db().exam.create({ data: { userId: owner.id, courseId: cs, title: "CS midterm", examDate: date(10), topics: ["Arrays"] } });
  foreignExam = (await db().exam.create({ data: { userId: foreign.id, courseId: foreignCourse, title: "FOREIGN exam", examDate: date(1), topics: ["FOREIGN topic"] } })).id;
  await learning(math, "Induction", 42, 88); await learning(math, "Logic", 95, 95); await learning(cs, "Arrays", 85, 20);
  await learning(oldCourse, "OLD TOPIC", 5, 90);
  planId = (await db().studyPlan.create({ data: {
    userId: owner.id, title: "Existing useful plan", startDate: day(-3), endDate: day(5), summary: "Keep completed work", totalPlannedMinutes: 120,
    tasks: { create: [
      { title: "Completed one", date: day(-2), status: "COMPLETED" as const },
      { title: "Completed two", date: day(-1), status: "COMPLETED" as const },
      { title: "Missed induction", date: day(-1), status: "PLANNED" as const },
      { title: "Today's induction", date: day(0), status: "IN_PROGRESS" as const },
      { title: "Explicitly skipped", date: day(-1), status: "SKIPPED" as const },
    ].map((task) => ({ ...task, courseId: math, examId: mathExam, activityType: "PRACTICE" as const, durationMinutes: 30, priority: 70, reason: "Existing exam practice" })) },
  } })).id;
}, 30000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const actor of actors) await db().user.deleteMany({ where: { id: actor.id } });
  await db().$disconnect();
});

describe.sequential("Academic Manager using real auth, context, learning and plans", () => {
  it("registers metadata and broader structured context without default documents", () => {
    const agent = createStudentAgentRegistry().get("academic-manager");
    expect(agent).toEqual(getAcademicManagerAgentDefinition());
    expect(agent.capabilities).toContain("academic-readiness-analysis");
    expect(agent.contextRequirements).toMatchObject({ academicOverview: true, profile: true, learning: true, assignments: true, exams: true });
    expect(agent.contextRequirements.documents).not.toBe(true);
  });
  it.each([
    "What should I focus on this week?", "What do I need to do today?", "How am I doing this semester?",
    "What should I prioritize?", "I feel behind. Help me figure out what to do.", "What should I study next?",
    "Which course needs the most attention?", "Am I ready for my exams?", "Help me manage everything.",
    "Give me an academic overview.", "How am I doing overall?", "What should I do right now?",
  ])("routes %s deterministically", async (request) => {
    const ai = boundary();
    const result = await new AgentRouter(createStudentAgentRegistry(), { getProvider: ai.getProvider }).routeAgent({ request });
    expect(result).toMatchObject({ agentId: "academic-manager", method: "rule" });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });
  it("returns exact active-semester counts and excludes completed/historical work", async () => {
    const snapshot = await overview();
    expect(snapshot).toMatchObject({ totalActiveCourses: 2, overdueAssignments: 2, overdueHighPriorityAssignments: 2, assignmentsDueNext7Days: 2, examsNext14Days: 2, missedStudyTasks: 1 });
    expect(snapshot.courses.map((item) => item.id)).toEqual(expect.arrayContaining([math, cs]));
    expect(JSON.stringify(snapshot)).not.toMatch(/OLD TOPIC|OLD SEMESTER|Old semester work|Completed homework/);
  });
  it("supports snapshot-only context through its centralized dependencies", async () => {
    const context = await contexts.buildUserContext({ request: "My academic snapshot", options: { academicOverview: true } }, owner.headers);
    expect(context.metadata.requestedCategories).toEqual(["academicOverview"]);
    expect(context.profile).toBeUndefined(); expect(context.assignments).toBeUndefined();
    expect(context.academicOverview).toMatchObject({ totalActiveCourses: 2, overdueAssignments: 2 });
    expect(context.academicOverview!.examReadiness).toHaveLength(2);
  });
  it("includes truthful risks, confidence-aware exam readiness and ranked courses", async () => {
    const snapshot = await overview();
    expect(snapshot.overallStatus).toBe("high");
    expect(snapshot.risks).toContainEqual(expect.objectContaining({ id: "overdue-work", level: "high" }));
    expect(snapshot.examReadiness.find((item) => item.examId === mathExam)).toMatchObject({ readinessLevel: "low", confidence: 88, weakTopics: ["Induction"] });
    expect(snapshot.examReadiness.find((item) => item.courseId === cs)?.readinessLevel).toBe("insufficient-data");
    expect(snapshot.courses[0].id).toBe(math);
  });
  it("includes persisted plan progress and upcoming sessions without writing", async () => {
    const before = await db().studyTask.findMany({ where: { studyPlanId: planId } });
    const snapshot = await overview();
    expect(snapshot.activeStudyPlanProgress).toBe(50);
    expect(snapshot.activeStudyPlans[0]).toMatchObject({ id: planId, completedTasks: 2, remainingTasks: 2, missedTasks: 1, skippedTasks: 1 });
    expect(snapshot.upcomingSessions).toContainEqual(expect.objectContaining({ title: "Today's induction", durationMinutes: 30 }));
    expect(await db().studyTask.findMany({ where: { studyPlanId: planId } })).toEqual(before);
  });
  it("executes a semester overview once through the shared core and Executor", async () => {
    const ai = boundary();
    const execute = vi.spyOn(AgentExecutor.prototype, "executeStructured");
    const build = vi.spyOn(contexts, "buildUserContext");
    const retrieve = vi.spyOn(retrieval, "retrieveAcademicContext");
    const response = unwrap(await ai.service.handleAgentRequest({ request: "How am I doing this semester?" }, owner.headers));
    expect(response).toMatchObject({ mode: "overview", overallStatus: "high" });
    expect(response.academicSnapshot?.weakestTopics[0].topic).toBe("Induction");
    expect(response.academicSnapshot?.strongestTopics[0].topic).toBe("Logic");
    expect(response.nextBestAction.action).toMatch(/assignment|overdue/i);
    expect(ai.calls).toHaveLength(1); expect(execute).toHaveBeenCalledTimes(1); expect(build).toHaveBeenCalledTimes(1);
    expect(retrieve).not.toHaveBeenCalled();
    expect(ai.calls[0].messages[1].content).toContain("ACADEMIC OVERVIEW");
    expect(ai.calls[0].messages[0].content).not.toContain("Proof assignment");
  });
  it("returns one or two useful actions for now without a semester report", async () => {
    const ai = boundary();
    const result = unwrap(await ai.service.handleAgentRequest({ request: "What should I do right now?" }, owner.headers));
    expect(result.mode).toBe("now");
    expect(result.academicSnapshot).toBeUndefined(); expect(result.examReadiness).toBeUndefined();
    expect(result.recommendedActions.length).toBeLessThanOrEqual(2);
    expect(result.nextBestAction).toEqual(result.recommendedActions[0]);
    expect(result.nextBestAction.reason).toContain("overdue");
  });
  it("returns only registered relevant specialist recommendations without execution", async () => {
    const ai = boundary();
    const response = unwrap(await ai.service.handleAgentRequest({ request: "Am I ready for my exams?", courseId: cs }, owner.headers));
    for (const action of response.recommendedActions) {
      if (action.agentId) expect(createStudentAgentRegistry().has(action.agentId)).toBe(true);
    }
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls.every((call) => call.schemaName === "academic_manager")).toBe(true);
  });
  it.each([
    { summary: "Overview", recommendedActions: [{ candidateId: "made-up", agentId: "invented-agent" }] },
    { summary: "Overview", readinessScore: 100 },
    { summary: "" },
    { summary: "x".repeat(1801) },
  ])("rejects invalid structured output %#", async (invalid) => {
    const ai = boundary(); ai.setInvalid(invalid);
    const result = await ai.service.handleAgentRequest({ request: "Give me an academic overview" }, owner.headers);
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });
  it("uses deterministic ranked actions when the provider returns interpretation text only", async () => {
    const ai = boundary(); ai.setInvalid({ summary: "Check the most urgent work." });
    const result = unwrap(await ai.service.handleAgentRequest({ request: "What should I do today?" }, owner.headers));
    expect(result.recommendedActions.length).toBeGreaterThan(0);
    expect(result.recommendedActions.length).toBeLessThanOrEqual(2);
    expect(result.nextBestAction).toEqual(result.recommendedActions[0]);
  });
  it("does not expose unregistered specialists from a smaller registry", async () => {
    const registry = new AgentRegistry(); registry.register(getAcademicManagerAgentDefinition());
    const ai = boundary();
    const service = new AgentService(registry, { executor: { getProvider: ai.getProvider }, handlers: { "academic-manager": executeAcademicManager } });
    const result = unwrap(await service.handleAgentRequest({ request: "Academic overview", courseId: cs }, owner.headers));
    expect(result.recommendedActions.every((action) => action.agentId === null)).toBe(true);
    expect(result.academicSnapshot!.actionCandidates.every((action) => action.agentId === null)).toBe(true);
    expect(result.academicSnapshot!.priorities.every((item) => item.suggestedAgent === null)).toBe(true);
  });
  it("rejects unauthenticated, forged identity and foreign course scope", async () => {
    const ai = boundary();
    expect(await ai.service.handleAgentRequest({ request: "Academic overview" }, new Headers())).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(await ai.service.handleAgentRequest({ request: "Academic overview", userId: foreign.id } as AgentRequestInput, owner.headers)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(await ai.service.handleAgentRequest({ request: "Academic overview", courseId: foreignCourse }, owner.headers)).toMatchObject({ ok: false, error: { code: "CONTEXT_FAILURE" } });
    expect(ai.calls).toHaveLength(0);
  });
  it("excludes foreign state even when a legacy study task has a foreign link", async () => {
    const badTask = await db().studyTask.create({ data: {
      userId: owner.id, studyPlanId: planId, courseId: math, examId: foreignExam,
      date: day(-2), title: "FOREIGN-linked task", activityType: "REVIEW", durationMinutes: 30, priority: 100, reason: "FOREIGN hidden content",
    } });
    try {
      const snapshot = await overview();
      expect(snapshot.missedStudyTasks).toBe(1);
      expect(snapshot.activeStudyPlanProgress).toBe(50);
      expect(JSON.stringify(snapshot)).not.toContain("FOREIGN");
      const ai = boundary();
      unwrap(await ai.service.handleAgentRequest({ request: "Academic overview" }, owner.headers));
      expect(JSON.stringify(ai.calls)).not.toContain("FOREIGN");
    } finally { await db().studyTask.delete({ where: { id: badTask.id } }); }
  });
  it("bounds course and assignment detail without understating exact counts", async () => {
    const ids: string[] = [];
    try {
      for (let i = 0; i < 22; i++) {
        const id = await course(owner.id, `EXTRA ${i}`); ids.push(id);
        await db().assignment.create({ data: { userId: owner.id, courseId: id, title: `Extra due ${i}`, dueDate: date(4) } });
      }
      const context = await contexts.buildUserContext({ request: "Academic overview", options: getAcademicManagerAgentDefinition().contextRequirements }, owner.headers);
      expect(context.academicOverview!.totalActiveCourses).toBe(24);
      expect(context.academicOverview!.assignmentsDueNext7Days).toBe(24);
      expect(context.academicOverview!.courses).toHaveLength(20);
      expect(context.assignments!.length).toBeLessThanOrEqual(20);
      expect(context.academicOverview!.limitations.join(" ")).toContain("Showing 20 of 24");
      expect(context.metadata.estimatedContextSize).toBeLessThanOrEqual(40000);
      expect(formatContextForAI(context)).not.toContain("QuestionAttempt");
    } finally { await db().course.deleteMany({ where: { id: { in: ids }, userId: owner.id } }); }
  });
  it("covers exam topics even when they are outside the short weak/strong lists", async () => {
    const extra = await db().learningTopic.create({ data: { userId: owner.id, courseId: math, name: "Boundary concept", normalizedName: "boundary concept",
      progress: { create: { masteryScore: 75, confidenceScore: 80, recentAccuracy: 75, questionsAttempted: 4, correctAnswers: 3, incorrectAnswers: 1,
        mediumAttempts: 4, scoreTotal: 3, difficultyWeightedScore: 3, difficultyWeightTotal: 4, practiceSessions: 2,
        firstPracticedAt: date(-5), lastPracticedAt: date(-1) } },
    } });
    const newExam = await db().exam.create({ data: { userId: owner.id, courseId: math, title: "Boundary exam", examDate: date(5), topics: ["Boundary concept"] } });
    try {
      const context = await contexts.buildUserContext({ request: "Academic overview", options: { ...getAcademicManagerAgentDefinition().contextRequirements, limits: { learning: 1, maxCharacters: 40000 } } }, owner.headers);
      expect(context.academicOverview!.examReadiness.find((item) => item.examId === newExam.id)).toMatchObject({ confidence: 80, coverage: 100, readinessLevel: "moderate" });
      expect(context.learning?.examTopics).toBeUndefined();
    } finally {
      await db().exam.delete({ where: { id: newExam.id } }); await db().learningTopic.delete({ where: { id: extra.id } });
    }
  });
});
