import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { recordQuestionEvaluation } from "@/server/learning";
import { getStudentProgress } from "@/server/progress";
import { createStudyPlannerAgentService } from "@/server/agents/study-planner";
import * as ai from "@/server/ai";

const DAY = 86_400_000;
const NOW = new Date("2026-09-16T12:00:00.000Z");
type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor;
let foreign: Actor;

async function actor(name: string): Promise<Actor> {
  const email = `student-progress-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: { name, email, password: "Student-progress-passphrase-2026!" },
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
    school: "Progress University",
    program: "Mathematics",
    currentYear: 2,
    semester: "Fall 2026",
    academicGoal: "Build durable understanding",
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

function at(days: number) {
  return new Date(NOW.getTime() + days * DAY);
}

function monday() {
  return new Date("2026-09-14T00:00:00.000Z");
}

async function learningTopic(courseId: string, input: {
  name: string;
  mastery: number;
  confidence: number;
  accuracy: number;
  trend: "IMPROVING" | "STABLE" | "DECLINING" | "INSUFFICIENT_DATA";
  attempts: number;
  sessions: number;
}) {
  return db().learningTopic.create({ data: {
    userId: owner.id,
    courseId,
    name: input.name,
    normalizedName: input.name.toLowerCase(),
    progress: { create: {
      masteryScore: input.mastery,
      confidenceScore: input.confidence,
      recentAccuracy: input.accuracy,
      questionsAttempted: input.attempts,
      correctAnswers: Math.round(input.attempts * input.accuracy / 100),
      incorrectAnswers: input.attempts - Math.round(input.attempts * input.accuracy / 100),
      scoreTotal: input.attempts * input.accuracy / 100,
      difficultyWeightedScore: input.attempts * input.accuracy / 100,
      difficultyWeightTotal: input.attempts,
      practiceSessions: input.sessions,
      mediumAttempts: input.attempts,
      trend: input.trend,
      firstPracticedAt: at(-20),
      lastPracticedAt: at(-1),
    } },
  } });
}

async function fixture() {
  const math = await db().course.create({ data: {
    userId: owner.id, courseCode: "MATH 1240", courseName: "Discrete Mathematics", semester: "Fall 2026",
  } });
  const comp = await db().course.create({ data: {
    userId: owner.id, courseCode: "COMP 2140", courseName: "Data Structures", semester: "Fall 2026",
  } });
  const weak = await learningTopic(math.id, { name: "Mathematical Induction", mastery: 38, confidence: 88, accuracy: 35, trend: "DECLINING", attempts: 12, sessions: 4 });
  const strong = await learningTopic(math.id, { name: "Logic", mastery: 91, confidence: 92, accuracy: 92, trend: "IMPROVING", attempts: 14, sessions: 5 });
  const lowEvidence = await learningTopic(math.id, { name: "Relations", mastery: 42, confidence: 18, accuracy: 100, trend: "INSUFFICIENT_DATA", attempts: 1, sessions: 1 });
  const developing = await learningTopic(comp.id, { name: "Recursion", mastery: 58, confidence: 72, accuracy: 55, trend: "STABLE", attempts: 8, sessions: 3 });

  await db().learningProgressSnapshot.createMany({ data: [
    { userId: owner.id, courseId: math.id, topicId: weak.id, masteryScore: 52, confidenceScore: 65, recentAccuracy: 50, questionsAttempted: 6, trend: "STABLE", recordedAt: at(-14) },
    { userId: owner.id, courseId: math.id, topicId: weak.id, masteryScore: 38, confidenceScore: 88, recentAccuracy: 35, questionsAttempted: 12, trend: "DECLINING", recordedAt: at(-1) },
    { userId: owner.id, courseId: math.id, topicId: strong.id, masteryScore: 78, confidenceScore: 68, recentAccuracy: 80, questionsAttempted: 7, trend: "STABLE", recordedAt: at(-12) },
    { userId: owner.id, courseId: math.id, topicId: strong.id, masteryScore: 91, confidenceScore: 92, recentAccuracy: 92, questionsAttempted: 14, trend: "IMPROVING", recordedAt: at(-1) },
  ] });

  const quiz = await db().quiz.create({ data: {
    userId: owner.id, courseId: math.id, title: "Induction practice", topic: "Mathematical Induction", difficulty: "HARD",
  } });
  const questions = [];
  for (let position = 1; position <= 4; position++) {
    questions.push(await db().quizQuestion.create({ data: {
      userId: owner.id,
      quizId: quiz.id,
      position,
      type: position <= 3 ? "MULTIPLE_CHOICE" : "SHORT_ANSWER",
      prompt: `Question ${position}`,
      choices: position <= 3 ? ["A", "B"] : undefined,
      correctAnswer: "A",
      explanation: "Test explanation",
      topicNames: [weak.name],
      topicMappings: { create: { courseId: math.id, topicId: weak.id } },
    } }));
  }
  const attempt = await db().quizAttempt.create({ data: {
    userId: owner.id, quizId: quiz.id, startedAt: at(-2), completedAt: at(-2),
  } });
  await db().questionAttempt.createMany({ data: questions.map((question, index) => ({
    userId: owner.id,
    quizId: quiz.id,
    quizAttemptId: attempt.id,
    questionId: question.id,
    userAnswer: index < 2 ? "A" : "B",
    score: index < 2 ? 1 : 0,
    isCorrect: index < 2,
    evaluationMethod: "DETERMINISTIC" as const,
    attemptedAt: at(-2),
  })) });

  const exam = await db().exam.create({ data: {
    userId: owner.id, courseId: math.id, title: "Midterm", examDate: at(5), topics: [weak.name, strong.name],
  } });
  const plan = await db().studyPlan.create({ data: {
    userId: owner.id,
    title: "Midterm plan",
    startDate: at(-3),
    endDate: at(5),
    summary: "Prepare for the midterm.",
    totalPlannedMinutes: 285,
    tasks: { create: [
      { courseId: math.id, topicId: weak.id, topic: weak.name, examId: exam.id, date: monday(), title: "Review induction", activityType: "REVIEW", durationMinutes: 30, priority: 90, status: "COMPLETED", reason: "Repair a reliable weak topic." },
      { courseId: math.id, topicId: strong.id, topic: strong.name, examId: exam.id, date: at(0), title: "Maintain logic", activityType: "QUIZ", durationMinutes: 45, priority: 50, status: "COMPLETED", reason: "Maintain a reliable strength." },
      { courseId: math.id, topicId: weak.id, topic: weak.name, examId: exam.id, date: at(1), title: "Long induction set", activityType: "PRACTICE", durationMinutes: 90, priority: 88, status: "SKIPPED", reason: "Repair induction." },
      { courseId: comp.id, topicId: developing.id, topic: developing.name, date: at(2), title: "Long recursion set", activityType: "PRACTICE", durationMinutes: 90, priority: 60, status: "SKIPPED", reason: "Build recursion fluency." },
      { courseId: math.id, examId: exam.id, date: at(3), title: "Mixed exam review", activityType: "EXAM_REVIEW", durationMinutes: 30, priority: 80, status: "PLANNED", reason: "Prepare for the exam." },
    ] },
  } });
  await db().recommendation.create({ data: {
    userId: owner.id,
    type: "WEAK_TOPIC",
    title: "Review Mathematical Induction",
    message: "Induction has reliable evidence of a mastery gap.",
    priority: "HIGH",
    priorityScore: 88,
    status: "ACTIVE",
    sourceType: "LEARNING_TOPIC",
    sourceId: weak.id,
    recommendedWorkflowId: "weak-topic-recovery",
    actionPayload: { courseId: math.id, topicId: weak.id, topicName: weak.name },
    reasonCode: "weak-topic",
    reasonData: { mastery: 38 },
    dedupeKey: `weak:${weak.id}`,
    supersessionKey: `weak:${weak.id}`,
    stateFingerprint: "progress-test",
    activeKey: `${owner.id}:weak:${weak.id}`,
    expiresAt: at(7),
  } });
  return { math, comp, weak, strong, lowEvidence, developing, quiz, questions, exam, plan };
}

beforeAll(async () => {
  owner = await actor("Progress Owner");
  foreign = await actor("Progress Foreign");
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

describe.sequential("Student Progress aggregation", () => {
  it("returns calm empty states for new students and students without learning evidence", async () => {
    const empty = await getStudentProgress(owner.id, owner.headers, { now: NOW });
    expect(empty).toMatchObject({ hasCourses: false, hasLearningData: false, topics: [], activePlans: [] });
    await db().course.create({ data: { userId: owner.id, courseCode: "TEST 100", courseName: "Foundations", semester: "Fall 2026" } });
    const courseOnly = await getStudentProgress(owner.id, owner.headers, { now: NOW });
    expect(courseOnly).toMatchObject({ hasCourses: true, hasLearningData: false });
    expect(courseOnly.quizSummary.completed).toBe(0);
  });

  it("composes overview, course grouping, confidence-aware weak and strong topics, and trends", async () => {
    const values = await fixture();
    const result = await getStudentProgress(owner.id, owner.headers, { now: NOW });
    expect(result.overview).toMatchObject({ activeCourses: 2, topicsTracked: 4, highestPriorityTopic: "Mathematical Induction" });
    expect(result.courses.map((course) => course.courseCode)).toEqual(expect.arrayContaining(["MATH 1240", "COMP 2140"]));
    expect(result.weakTopics).toContainEqual(expect.objectContaining({ id: values.weak.id, stateLabel: "Weak", confidenceLabel: "High confidence", trend: "declining" }));
    expect(result.strongTopics).toContainEqual(expect.objectContaining({ id: values.strong.id, stateLabel: "Strong", trend: "improving" }));
    expect(result.lowEvidenceTopics).toContainEqual(expect.objectContaining({ id: values.lowEvidence.id, stateLabel: "Needs more evidence", recommendedAction: "diagnostic" }));
    expect(result.improvingTopics.map((topic) => topic.id)).toContain(values.strong.id);
    expect(result.decliningTopics.map((topic) => topic.id)).toContain(values.weak.id);
    expect(result.topics.find((topic) => topic.id === values.weak.id)?.history).toHaveLength(2);
  });

  it("returns bounded quiz history, difficulty context and evidence-backed question type insight", async () => {
    await fixture();
    const result = await getStudentProgress(owner.id, owner.headers, { now: NOW });
    expect(result.quizSummary).toMatchObject({ completed: 1, recentAccuracy: 50, weakestTopic: "Mathematical Induction", strongestTopic: "Logic" });
    expect(result.quizSummary.history[0]).toMatchObject({ difficulty: "hard", accuracy: 50, answered: 4 });
    expect(result.quizSummary.questionTypes).toEqual([
      expect.objectContaining({ type: "multiple-choice", attempts: 3, accuracy: 67 }),
    ]);
  });

  it("uses actual StudyTask rows for weekly consistency and existing plan summaries", async () => {
    const values = await fixture();
    const result = await getStudentProgress(owner.id, owner.headers, { now: NOW });
    expect(result.studyConsistency).toMatchObject({ plannedMinutes: 285, completedMinutes: 75, completedTasks: 2, skippedTasks: 2, completionRate: 50 });
    expect(result.studyConsistency.insight).toContain("Longer planned sessions");
    expect(result.studyConsistency.days).toHaveLength(7);
    expect(result.activePlans[0]).toMatchObject({ id: values.plan.id, completedTasks: 2, remainingTasks: 1, skippedTasks: 2, completionPercentage: 67 });
  });

  it("reuses readiness output and preserves insufficient evidence instead of claiming readiness", async () => {
    const values = await fixture();
    const result = await getStudentProgress(owner.id, owner.headers, { now: NOW });
    expect(result.examReadiness[0]).toMatchObject({ examId: values.exam.id, courseCode: "MATH 1240" });
    expect(["Ready", "Developing", "Needs attention", "Insufficient data"]).toContain(result.examReadiness[0].readinessLabel);
    await db().learningProgress.deleteMany({ where: { userId: owner.id } });
    const insufficient = await getStudentProgress(owner.id, owner.headers, { now: NOW });
    expect(insufficient.examReadiness[0]).toMatchObject({ readinessLevel: "insufficient-data", readinessLabel: "Insufficient data", readinessScore: null });
  });

  it("returns the Proactive Recommendation Engine next action without generating a replacement", async () => {
    await fixture();
    expect((await getStudentProgress(owner.id, owner.headers, { now: NOW })).nextBestAction).toMatchObject({
      title: "Review Mathematical Induction", actionLabel: "Start recovery", priority: "high",
    });
  });

  it("refreshes progress and writes a meaningful history point after quiz completion", async () => {
    const values = await fixture();
    const quiz = await db().quiz.create({ data: {
      userId: owner.id, courseId: values.math.id, title: "Induction check", topic: values.weak.name, difficulty: "MEDIUM",
    } });
    const question = await db().quizQuestion.create({ data: {
      userId: owner.id, quizId: quiz.id, position: 1, type: "TRUE_FALSE", prompt: "Check induction", choices: ["True", "False"], correctAnswer: "True", explanation: "Test", topicNames: [values.weak.name],
      topicMappings: { create: { courseId: values.math.id, topicId: values.weak.id } },
    } });
    const before = await getStudentProgress(owner.id, owner.headers, { now: NOW });
    const beforeTopic = before.topics.find((topic) => topic.id === values.weak.id)!;
    await recordQuestionEvaluation({ userId: owner.id, quizId: quiz.id, questionId: question.id, startNewAttempt: true, userAnswer: "False", score: 0, correct: false, method: "deterministic", attemptedAt: NOW });
    const after = await getStudentProgress(owner.id, owner.headers, { now: new Date(NOW.getTime() + 1000) });
    const afterTopic = after.topics.find((topic) => topic.id === values.weak.id)!;
    expect(afterTopic.questionsAttempted).toBe(beforeTopic.questionsAttempted + 1);
    expect(afterTopic.history.length).toBe(beforeTopic.history.length + 1);
    expect(after.quizSummary.completed).toBe(before.quizSummary.completed + 1);
  });

  it("refreshes after a StudyTask update and blocks cross-user scope", async () => {
    const values = await fixture();
    const before = await getStudentProgress(owner.id, owner.headers, { now: NOW });
    const planned = await db().studyTask.findFirstOrThrow({ where: { userId: owner.id, studyPlanId: values.plan.id, status: "PLANNED" } });
    await createStudyPlannerAgentService().updateTaskStatus(planned.id, "completed", owner.headers);
    const after = await getStudentProgress(owner.id, owner.headers, { now: NOW });
    expect(after.studyConsistency.completedTasks).toBe(before.studyConsistency.completedTasks + 1);
    await expect(getStudentProgress(owner.id, foreign.headers, { now: NOW })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(JSON.stringify(await getStudentProgress(foreign.id, foreign.headers, { now: NOW }))).not.toContain("MATH 1240");
  });

  it("loads all normal ranges without initializing an AI provider", async () => {
    await fixture();
    const provider = vi.spyOn(ai, "getAIProvider");
    for (const range of ["7d", "30d", "semester"] as const) {
      const result = await getStudentProgress(owner.id, owner.headers, { now: NOW, range });
      expect(result.range).toBe(range);
    }
    expect(provider).not.toHaveBeenCalled();
  });
});
