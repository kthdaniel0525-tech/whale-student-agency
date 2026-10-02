import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { dashboard, updateAssignment } from "@/server/services/academic";
import {
  completeRecommendation,
  dismissRecommendation,
  evaluateRecommendations,
  getNextBestAction,
  getTopRecommendations,
  startRecommendedAction,
} from "@/server/recommendations";
import { createStudentAgentService } from "@/server/agents/student-service";
import type { AcademicManagerResponse } from "@/server/agents/academic-manager";
import type { AIProvider } from "@/server/ai/types";
import * as ai from "@/server/ai";

const DAY = 86_400_000;
const fixedNow = new Date("2026-09-15T12:00:00.000Z");
const at = (days: number, base = fixedNow) => new Date(base.getTime() + days * DAY);

type Actor = { id: string; headers: Headers };
let owner: Actor;
let foreign: Actor;

async function actor(label: string): Promise<Actor> {
  const response = await auth().api.signUpEmail({
    body: {
      name: label,
      email: `recommendations-${randomUUID()}@example.test`,
      password: "Recommendation-test-passphrase-2026!",
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const data = await response.json() as { user: { id: string } };
  const result = {
    id: data.user.id,
    headers: new Headers({ cookie: response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ") }),
  };
  await db().profile.create({ data: {
    userId: result.id, school: "Recommendation University", program: "CS",
    currentYear: 2, semester: "Fall 2026", academicGoal: "Stay on track",
    studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC",
  } });
  return result;
}

async function reset(userId: string) {
  await db().recommendation.deleteMany({ where: { userId } });
  await db().workflowRun.deleteMany({ where: { userId } });
  await db().adaptiveOutcome.deleteMany({ where: { userId } });
  await db().studyPlan.deleteMany({ where: { userId } });
  await db().careerPlan.deleteMany({ where: { userId } });
  await db().document.deleteMany({ where: { userId } });
  await db().quiz.deleteMany({ where: { userId } });
  await db().learningTopic.deleteMany({ where: { userId } });
  await db().assignment.deleteMany({ where: { userId } });
  await db().exam.deleteMany({ where: { userId } });
  await db().course.deleteMany({ where: { userId } });
}

async function course(userId = owner.id, code = "MATH 1240") {
  return db().course.create({ data: { userId, courseCode: code, courseName: code, semester: "Fall 2026" } });
}

async function topic(input: {
  courseId: string;
  name?: string;
  mastery: number;
  confidence: number;
  trend?: "IMPROVING" | "STABLE" | "DECLINING" | "INSUFFICIENT_DATA";
  questions?: number;
}) {
  const name = input.name ?? "Induction";
  const questions = input.questions ?? 8;
  const correct = Math.min(3, questions);
  return db().learningTopic.create({ data: {
    userId: owner.id, courseId: input.courseId, name,
    normalizedName: name.normalize("NFKC").trim().toLocaleLowerCase(),
    progress: { create: {
      masteryScore: input.mastery, confidenceScore: input.confidence,
      recentAccuracy: input.mastery, trend: input.trend ?? "STABLE",
      questionsAttempted: questions,
      correctAnswers: correct, incorrectAnswers: questions - correct, scoreTotal: correct,
      difficultyWeightedScore: correct, difficultyWeightTotal: questions,
      practiceSessions: 3, mediumAttempts: questions,
      firstPracticedAt: at(-10), lastPracticedAt: at(-1),
    } },
  }, include: { progress: true } });
}

async function exam(courseId: string, days = 4, topics = ["Induction"]) {
  return db().exam.create({ data: {
    userId: owner.id, courseId, title: "Midterm", examDate: at(days), topics,
  } });
}

async function assignment(courseId: string, input: {
  days?: number;
  status?: "TODO" | "IN_PROGRESS" | "COMPLETED";
  priority?: "LOW" | "MEDIUM" | "HIGH";
  title?: string;
} = {}) {
  const status = input.status ?? "TODO";
  return db().assignment.create({ data: {
    userId: owner.id, courseId, title: input.title ?? "Proof assignment",
    dueDate: at(input.days ?? 2), status, priority: input.priority ?? "HIGH",
    estimatedHours: 3, completedAt: status === "COMPLETED" ? fixedNow : null,
  } });
}

beforeAll(async () => {
  owner = await actor("Recommendation Owner");
  foreign = await actor("Recommendation Foreign");
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset(owner.id);
  await reset(foreign.id);
});

afterAll(async () => {
  await db().user.deleteMany({ where: { id: { in: [owner.id, foreign.id] } } });
  await db().$disconnect();
});

describe.sequential("Proactive Recommendation Engine", () => {
  it("creates an upcoming exam recommendation", async () => {
    const math = await course();
    const midterm = await exam(math.id);
    const result = await evaluateRecommendations(owner.id, { now: fixedNow });
    expect(result.recommendations[0]).toMatchObject({
      type: "exam-preparation", sourceId: midterm.id,
      recommendedWorkflowId: "exam-preparation",
    });
  });

  it("uses Weak Topic Recovery for a high-confidence weakness", async () => {
    const math = await course();
    const induction = await topic({ courseId: math.id, mastery: 35, confidence: 90 });
    const result = await evaluateRecommendations(owner.id, { now: fixedNow });
    expect(result.recommendations).toContainEqual(expect.objectContaining({
      type: "weak-topic", sourceId: induction.id,
      recommendedWorkflowId: "weak-topic-recovery",
      reasonCode: "WEAK_TOPIC_HIGH_CONFIDENCE",
    }));
  });

  it("uses a diagnostic quiz for low-confidence weakness", async () => {
    const math = await course();
    const induction = await topic({ courseId: math.id, mastery: 40, confidence: 20 });
    const result = await evaluateRecommendations(owner.id, { now: fixedNow });
    expect(result.recommendations).toContainEqual(expect.objectContaining({
      type: "diagnostic-practice", sourceId: induction.id,
      recommendedAgentId: "quiz", reasonCode: "LOW_CONFIDENCE_DIAGNOSTIC",
    }));
  });

  it("recommends Assignment Support for work due soon", async () => {
    const math = await course();
    const work = await assignment(math.id, { days: 1 });
    const result = await evaluateRecommendations(owner.id, { now: fixedNow });
    expect(result.recommendations).toContainEqual(expect.objectContaining({
      type: "assignment-deadline", sourceId: work.id,
      recommendedWorkflowId: "assignment-support",
    }));
  });

  it("does not duplicate an assignment action while its Workflow is active", async () => {
    const math = await course();
    const work = await assignment(math.id, { days: 1 });
    await db().workflowRun.create({ data: {
      userId: owner.id, workflowId: "assignment-support", status: "WAITING_FOR_INPUT",
      currentStep: "student-work", input: { assignmentId: work.id }, context: {},
    } });
    expect((await evaluateRecommendations(owner.id, { now: fixedNow })).recommendations)
      .not.toContainEqual(expect.objectContaining({ sourceId: work.id }));
  });

  it("ignores completed assignments", async () => {
    const math = await course();
    await assignment(math.id, { days: 1, status: "COMPLETED" });
    expect((await evaluateRecommendations(owner.id, { now: fixedNow })).recommendations)
      .not.toContainEqual(expect.objectContaining({ type: "assignment-deadline" }));
  });

  it("recommends replanning after missed study tasks", async () => {
    const math = await course();
    const plan = await db().studyPlan.create({ data: {
      userId: owner.id, title: "Exam plan", startDate: at(-3), endDate: at(5), summary: "Plan",
      tasks: { create: [
        { courseId: math.id, title: "Missed", date: at(-2), activityType: "REVIEW", durationMinutes: 45, priority: 70, reason: "Exam", status: "PLANNED" },
        { courseId: math.id, title: "Next", date: at(1), activityType: "PRACTICE", durationMinutes: 45, priority: 70, reason: "Exam", status: "PLANNED" },
      ] },
    } });
    expect((await evaluateRecommendations(owner.id, { now: fixedNow })).recommendations)
      .toContainEqual(expect.objectContaining({ type: "missed-study-task", sourceId: plan.id, recommendedAgentId: "study-planner" }));
  });

  it("reacts to a sufficiently evidenced declining trend", async () => {
    const math = await course();
    const logic = await topic({ courseId: math.id, name: "Logic", mastery: 72, confidence: 82, trend: "DECLINING", questions: 10 });
    expect((await evaluateRecommendations(owner.id, { now: fixedNow })).recommendations)
      .toContainEqual(expect.objectContaining({ sourceId: logic.id, reasonCode: "DECLINING_MASTERY", recommendedAgentId: "tutor" }));
  });

  it("does not nag about an exam when strong evidence and its active plan are on track", async () => {
    const math = await course();
    const induction = await topic({ courseId: math.id, mastery: 92, confidence: 90 });
    const midterm = await exam(math.id, 7, [induction.name]);
    await db().studyPlan.create({ data: {
      userId: owner.id, title: "Prepared plan", startDate: at(-5), endDate: at(7), summary: "Plan",
      tasks: { create: Array.from({ length: 5 }, (_, index) => ({
        courseId: math.id, examId: midterm.id, title: `Session ${index + 1}`, date: at(index - 4),
        activityType: "EXAM_REVIEW" as const, durationMinutes: 30, priority: 70, reason: "Exam",
        status: index < 4 ? "COMPLETED" as const : "PLANNED" as const,
      })) },
    } });
    expect((await evaluateRecommendations(owner.id, { now: fixedNow })).recommendations)
      .not.toContainEqual(expect.objectContaining({ sourceId: midterm.id }));
  });

  it("recommends Lecture Study for a new unstudied READY document", async () => {
    const math = await course();
    const document = await db().document.create({ data: {
      userId: owner.id, courseId: math.id, title: "Lecture 4", originalFileName: "lecture.txt",
      fileType: "TEXT", fileSize: 10, storageKey: randomUUID(), processingStatus: "READY",
      uploadedAt: fixedNow, createdAt: at(-1),
    } });
    expect((await evaluateRecommendations(owner.id, { now: fixedNow })).recommendations)
      .toContainEqual(expect.objectContaining({ type: "lecture-study", sourceId: document.id, recommendedWorkflowId: "lecture-study" }));
  });

  it("recommends the next high-value career milestone below academic emergencies", async () => {
    await db().careerPlan.create({ data: {
      userId: owner.id, targetRole: "Backend Engineer", startDate: at(-7), targetDate: at(30),
      weeklyAvailableMinutes: 180, summary: "Career plan",
      tasks: { create: { actionId: "resume", weekNumber: 1, category: "RESUME", title: "Finish resume", description: "Add evidence", priority: 80, durationMinutes: 60, targetDate: at(10) } },
    } });
    expect((await evaluateRecommendations(owner.id, { now: fixedNow })).recommendations)
      .toContainEqual(expect.objectContaining({ type: "career-preparation", recommendedAgentId: "career" }));
  });

  it("ranks urgent academic work above optional lecture and career work", async () => {
    const math = await course();
    const overdue = await assignment(math.id, { days: -2, priority: "HIGH" });
    await db().document.create({ data: { userId: owner.id, courseId: math.id, title: "Optional lecture", originalFileName: "l.txt", fileType: "TEXT", fileSize: 2, storageKey: randomUUID(), processingStatus: "READY", createdAt: at(-1) } });
    const top = await getTopRecommendations({ userId: owner.id, now: fixedNow });
    expect(top[0]).toMatchObject({ sourceId: overdue.id, priority: "critical" });
  });

  it("returns one deterministic next best action", async () => {
    const math = await course();
    await assignment(math.id, { days: 1 });
    const next = await getNextBestAction(owner.id, fixedNow);
    expect(next).toMatchObject({ type: "assignment-deadline" });
  });

  it("deduplicates repeated evaluations", async () => {
    const math = await course();
    await assignment(math.id, { days: 1 });
    await evaluateRecommendations(owner.id, { now: fixedNow });
    await evaluateRecommendations(owner.id, { now: fixedNow });
    expect(await db().recommendation.count({ where: { userId: owner.id, status: "ACTIVE" } })).toBe(1);
  });

  it("supersedes a diagnostic recommendation when evidence confirms weakness", async () => {
    const math = await course();
    const induction = await topic({ courseId: math.id, mastery: 40, confidence: 20 });
    await evaluateRecommendations(owner.id, { now: fixedNow });
    await db().learningProgress.update({ where: { userId_courseId_topicId: { userId: owner.id, courseId: math.id, topicId: induction.id } }, data: { masteryScore: 35, confidenceScore: 90 } });
    const result = await evaluateRecommendations(owner.id, { now: fixedNow });
    expect(result.recommendations).toContainEqual(expect.objectContaining({ type: "weak-topic", sourceId: induction.id }));
    expect(await db().recommendation.count({ where: { userId: owner.id, sourceId: induction.id, status: "ACTIVE" } })).toBe(1);
    expect(await db().recommendation.count({ where: { userId: owner.id, sourceId: induction.id, status: "EXPIRED" } })).toBe(1);
  });

  it("expires recommendations whose source is no longer relevant", async () => {
    const math = await course();
    await exam(math.id, 2);
    const first = await evaluateRecommendations(owner.id, { now: fixedNow });
    await evaluateRecommendations(owner.id, { now: at(4) });
    expect(await db().recommendation.findUnique({ where: { id: first.recommendations[0].id } }))
      .toMatchObject({ status: "EXPIRED", activeKey: null });
  });

  it("suppresses a dismissed recommendation while state is unchanged", async () => {
    const math = await course();
    await assignment(math.id, { days: 3 });
    const first = await getNextBestAction(owner.id, fixedNow);
    await dismissRecommendation(owner.id, first!.id, fixedNow);
    expect(await getTopRecommendations({ userId: owner.id, now: fixedNow })).toHaveLength(0);
  });

  it("reactivates a dismissed recommendation after a meaningful urgency change", async () => {
    const math = await course();
    await exam(math.id, 4);
    const first = await getNextBestAction(owner.id, fixedNow);
    await dismissRecommendation(owner.id, first!.id, fixedNow);
    const changed = await getTopRecommendations({ userId: owner.id, now: at(3) });
    expect(changed).toHaveLength(1);
    expect(changed[0].id).not.toBe(first!.id);
  });

  it("returns only a registered Agent launch target", async () => {
    const math = await course();
    await topic({ courseId: math.id, mastery: 45, confidence: 20 });
    const recommendation = await getNextBestAction(owner.id, fixedNow);
    expect(await startRecommendedAction(owner.id, recommendation!.id)).toMatchObject({ target: { type: "agent", id: "quiz" } });
  });

  it("returns only a registered Workflow launch target", async () => {
    const math = await course();
    await exam(math.id, 4);
    const recommendation = await getNextBestAction(owner.id, fixedNow);
    expect(await startRecommendedAction(owner.id, recommendation!.id)).toMatchObject({ target: { type: "workflow", id: "exam-preparation" } });
  });

  it("returns an ownership-checked structured action payload", async () => {
    const math = await course();
    const midterm = await exam(math.id, 4);
    const recommendation = await getNextBestAction(owner.id, fixedNow);
    expect(await startRecommendedAction(owner.id, recommendation!.id)).toMatchObject({ payload: { courseId: math.id, examId: midterm.id } });
  });

  it("feeds ranked proactive recommendations to Academic Manager", async () => {
    const math = await course();
    await assignment(math.id, { days: -1 });
    const provider: AIProvider = {
      async generateStructuredOutput<T>() {
        const data = { summary: "Address the overdue assignment first.", recommendedActions: null };
        return { id: "manager", model: "fixture", text: JSON.stringify(data), data: data as T };
      },
      generateText() { throw new Error("No text boundary expected."); },
      streamText() { throw new Error("No stream expected."); },
      generateEmbedding() { throw new Error("No embedding expected."); },
    };
    const service = createStudentAgentService({ executor: { getProvider: () => provider }, router: { getProvider: () => provider } });
    const result = await service.handleAgentRequest({ request: "What should I do right now?" }, owner.headers);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const response = result.response.structuredData as AcademicManagerResponse;
    expect(response.proactiveRecommendations[0]).toMatchObject({ type: "assignment-deadline" });
    expect(response.nextBestRecommendation).toEqual(response.proactiveRecommendations[0]);
    expect(response.nextBestAction.id).toBe(response.proactiveRecommendations[0].id);
  });

  it("returns dashboard-ready recommendation cards", async () => {
    const math = await course();
    await assignment(math.id, { days: 1 });
    const result = await dashboard(owner.id);
    expect(result.recommendations[0]).toMatchObject({
      title: expect.any(String), message: expect.any(String), priority: expect.any(String),
      recommendedWorkflowId: "assignment-support",
    });
  });

  it("protects recommendations and source data across users", async () => {
    const secretCourse = await course(foreign.id, "FOREIGN 9999");
    await db().assignment.create({ data: { userId: foreign.id, courseId: secretCourse.id, title: "FOREIGN SECRET", dueDate: at(1), priority: "HIGH", estimatedHours: 4 } });
    const foreignRecommendation = await getNextBestAction(foreign.id, fixedNow);
    const ownerResult = await evaluateRecommendations(owner.id, { now: fixedNow });
    expect(JSON.stringify(ownerResult)).not.toContain("FOREIGN");
    await expect(startRecommendedAction(owner.id, foreignRecommendation!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses no AI call for deterministic detection and event refresh", async () => {
    const getProvider = vi.spyOn(ai, "getAIProvider");
    const math = await course();
    const work = await assignment(math.id, { days: 2 });
    await evaluateRecommendations(owner.id, { now: fixedNow });
    await updateAssignment(owner.id, work.id, { status: "IN_PROGRESS" });
    expect(getProvider).not.toHaveBeenCalled();
  });

  it("supports explicit completion without recreating unchanged work", async () => {
    const math = await course();
    await assignment(math.id, { days: 2 });
    const recommendation = await getNextBestAction(owner.id, fixedNow);
    await completeRecommendation(owner.id, recommendation!.id, fixedNow);
    expect(await getTopRecommendations({ userId: owner.id, now: fixedNow })).toHaveLength(0);
  });
});
