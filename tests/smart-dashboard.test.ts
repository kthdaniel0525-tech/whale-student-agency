import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { getStudentDashboard } from "@/server/dashboard";
import { dismissRecommendation } from "@/server/recommendations";
import { createStudyPlannerAgentService } from "@/server/agents/study-planner";
import * as ai from "@/server/ai";

const DAY = 86_400_000;
type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor;
let foreign: Actor;

async function actor(name: string): Promise<Actor> {
  const email = `smart-dashboard-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: { name, email, password: "Smart-dashboard-passphrase-2026!" },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const value = {
    id: body.user.id,
    email,
    headers: new Headers({ cookie: response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ") }),
  };
  actors.push(value);
  await db().profile.create({ data: {
    userId: value.id,
    school: "Dashboard University",
    program: "Mathematics",
    currentYear: 2,
    semester: "Fall 2026",
    academicGoal: "Stay ahead",
    studySessionMinutes: 45,
    explanationDifficulty: "INTERMEDIATE",
    timezone: "UTC",
  } });
  return value;
}

async function reset(userId: string) {
  await db().recommendation.deleteMany({ where: { userId } });
  await db().workflowRun.deleteMany({ where: { userId } });
  await db().adaptiveOutcome.deleteMany({ where: { userId } });
  await db().studyPlan.deleteMany({ where: { userId } });
  await db().quiz.deleteMany({ where: { userId } });
  await db().learningTopic.deleteMany({ where: { userId } });
  await db().assignment.deleteMany({ where: { userId } });
  await db().exam.deleteMany({ where: { userId } });
  await db().course.deleteMany({ where: { userId } });
}

function today(now = new Date()) {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function at(days: number, now = new Date()) {
  return new Date(now.getTime() + days * DAY);
}

async function fixture(now = new Date()) {
  const course = await db().course.create({ data: {
    userId: owner.id,
    courseCode: "MATH 1240",
    courseName: "Discrete Mathematics",
    semester: "Fall 2026",
  } });
  const weak = await db().learningTopic.create({ data: {
    userId: owner.id,
    courseId: course.id,
    name: "Mathematical Induction",
    normalizedName: "mathematical induction",
    progress: { create: {
      masteryScore: 42,
      confidenceScore: 82,
      recentAccuracy: 38,
      questionsAttempted: 10,
      correctAnswers: 4,
      incorrectAnswers: 6,
      scoreTotal: 4,
      difficultyWeightedScore: 4,
      difficultyWeightTotal: 10,
      practiceSessions: 3,
      mediumAttempts: 10,
      trend: "DECLINING",
      firstPracticedAt: at(-12, now),
      lastPracticedAt: at(-1, now),
    } },
  } });
  const strong = await db().learningTopic.create({ data: {
    userId: owner.id,
    courseId: course.id,
    name: "Logic",
    normalizedName: "logic",
    progress: { create: {
      masteryScore: 91,
      confidenceScore: 90,
      recentAccuracy: 90,
      questionsAttempted: 12,
      correctAnswers: 11,
      incorrectAnswers: 1,
      scoreTotal: 11,
      difficultyWeightedScore: 11,
      difficultyWeightTotal: 12,
      practiceSessions: 4,
      mediumAttempts: 12,
      trend: "IMPROVING",
      firstPracticedAt: at(-15, now),
      lastPracticedAt: at(-1, now),
    } },
  } });
  const lowConfidence = await db().learningTopic.create({ data: {
    userId: owner.id,
    courseId: course.id,
    name: "Relations",
    normalizedName: "relations",
    progress: { create: {
      masteryScore: 40,
      confidenceScore: 15,
      recentAccuracy: 100,
      questionsAttempted: 1,
      correctAnswers: 1,
      incorrectAnswers: 0,
      scoreTotal: 1,
      difficultyWeightedScore: 1,
      difficultyWeightTotal: 1,
      practiceSessions: 1,
      mediumAttempts: 1,
      trend: "INSUFFICIENT_DATA",
      firstPracticedAt: at(-1, now),
      lastPracticedAt: at(-1, now),
    } },
  } });
  const assignment = await db().assignment.create({ data: {
    userId: owner.id,
    courseId: course.id,
    title: "Proof assignment",
    dueDate: at(1, now),
    priority: "HIGH",
    estimatedHours: 3,
  } });
  const exam = await db().exam.create({ data: {
    userId: owner.id,
    courseId: course.id,
    title: "Midterm",
    examDate: at(4, now),
    topics: ["Mathematical Induction", "Logic"],
  } });
  const plan = await db().studyPlan.create({ data: {
    userId: owner.id,
    title: "Midterm plan",
    startDate: at(-2, now),
    endDate: at(4, now),
    summary: "Repair induction and maintain logic.",
    totalPlannedMinutes: 105,
    tasks: { create: [
      { courseId: course.id, topicId: weak.id, topic: weak.name, examId: exam.id, date: today(now), title: "Practice induction", activityType: "QUIZ", durationMinutes: 45, priority: 90, status: "PLANNED", reason: "Induction needs attention before the midterm." },
      { courseId: course.id, topicId: strong.id, topic: strong.name, examId: exam.id, date: today(now), title: "Review logic", activityType: "REVIEW", durationMinutes: 30, priority: 55, status: "COMPLETED", reason: "Maintain a strong topic." },
      { courseId: course.id, assignmentId: assignment.id, date: today(now), title: "Outline proof assignment", activityType: "ASSIGNMENT", durationMinutes: 30, priority: 80, status: "SKIPPED", reason: "Assignment is due tomorrow." },
    ] },
  } });
  return { course, weak, strong, lowConfidence, assignment, exam, plan };
}

beforeAll(async () => {
  owner = await actor("Dashboard Owner");
  foreign = await actor("Dashboard Foreign");
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset(owner.id);
  await reset(foreign.id);
});

afterAll(async () => {
  await db().user.deleteMany({ where: { id: { in: actors.map((item) => item.id) } } });
  await db().$disconnect();
});

describe.sequential("Smart Dashboard aggregation", () => {
  it("returns the useful new-student state without empty analytics", async () => {
    const result = await getStudentDashboard(owner.id, owner.headers);
    expect(result).toMatchObject({ hasCourses: false, nextBestAction: null, todayTasks: [], courses: [] });
    expect(result.summary).toContain("no study tasks");
  });

  it("composes bounded daily work, deadlines, recommendations, learning and courses", async () => {
    await fixture();
    const result = await getStudentDashboard(owner.id, owner.headers);
    expect(result.hasCourses).toBe(true);
    expect(result.todayTasks).toHaveLength(3);
    expect(result.upcomingDeadlines.slice(0, 2).map((item) => item.kind)).toEqual(["assignment", "exam"]);
    expect(result.nextBestAction).toMatchObject({ title: expect.any(String), actionLabel: expect.any(String) });
    expect(result.recommendations.length).toBeLessThanOrEqual(3);
    expect(result.courses[0]).toMatchObject({ courseCode: "MATH 1240", attentionLabel: expect.any(String) });
  });

  it("reuses confidence-aware learning classifications and exam readiness", async () => {
    const values = await fixture();
    const result = await getStudentDashboard(owner.id, owner.headers);
    expect(result.weakTopics).toContainEqual(expect.objectContaining({ id: values.weak.id, stateLabel: "Developing", needsMoreData: false }));
    expect(result.weakTopics).toContainEqual(expect.objectContaining({ id: values.lowConfidence.id, stateLabel: "Needs more data", needsMoreData: true }));
    expect(result.strongTopics).toContainEqual(expect.objectContaining({ id: values.strong.id, stateLabel: "Strong" }));
    expect(result.improvingTopics).toContainEqual(expect.objectContaining({ id: values.strong.id }));
    expect(result.examReadiness[0]).toMatchObject({ examId: values.exam.id, readinessLevel: expect.stringMatching(/high|moderate|low|insufficient-data/) });
  });

  it("returns active study-plan completion, remaining and skipped counts", async () => {
    await fixture();
    expect((await getStudentDashboard(owner.id, owner.headers)).studyPlanProgress).toEqual({
      completed: 1,
      remaining: 1,
      skipped: 1,
      missed: 0,
      percentage: 50,
      planCount: 1,
    });
  });

  it("refreshes today's work and plan progress after completing a task", async () => {
    await fixture();
    const before = await getStudentDashboard(owner.id, owner.headers);
    const planned = before.todayTasks.find((item) => item.status === "planned")!;
    await createStudyPlannerAgentService().updateTaskStatus(planned.id, "completed", owner.headers);
    const after = await getStudentDashboard(owner.id, owner.headers);
    expect(after.todayTasks.find((item) => item.id === planned.id)?.status).toBe("completed");
    expect(after.studyPlanProgress).toBeNull();
  });

  it("refreshes today's work after skipping a task", async () => {
    await fixture();
    const before = await getStudentDashboard(owner.id, owner.headers);
    const planned = before.todayTasks.find((item) => item.status === "planned")!;
    await createStudyPlannerAgentService().updateTaskStatus(planned.id, "skipped", owner.headers);
    expect((await getStudentDashboard(owner.id, owner.headers)).todayTasks.find((item) => item.id === planned.id)?.status).toBe("skipped");
  });

  it("persists recommendation dismissal and returns the next ranked action", async () => {
    await fixture();
    const before = await getStudentDashboard(owner.id, owner.headers);
    expect(before.nextBestAction).not.toBeNull();
    await dismissRecommendation(owner.id, before.nextBestAction!.id);
    const after = await getStudentDashboard(owner.id, owner.headers);
    expect(after.nextBestAction?.id).not.toBe(before.nextBestAction!.id);
  });

  it("keeps useful task and recommendation data when the academic section fails", async () => {
    await fixture();
    const result = await getStudentDashboard(owner.id, owner.headers, {
      dependencies: { buildContext: async () => { throw new Error("Academic reader unavailable"); } },
    });
    expect(result.hasCourses).toBe(true);
    expect(result.todayTasks.length).toBeGreaterThan(0);
    expect(result.nextBestAction).not.toBeNull();
    expect(result.sectionErrors).toContain("academic");
  });

  it("does not expose another user's dashboard through a forged service scope", async () => {
    await fixture();
    await expect(getStudentDashboard(owner.id, foreign.headers)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const foreignResult = await getStudentDashboard(foreign.id, foreign.headers);
    expect(JSON.stringify(foreignResult)).not.toContain("MATH 1240");
  });

  it("loads a normal dashboard without initializing an AI provider", async () => {
    await fixture();
    const provider = vi.spyOn(ai, "getAIProvider");
    await getStudentDashboard(owner.id, owner.headers);
    expect(provider).not.toHaveBeenCalled();
  });
});
