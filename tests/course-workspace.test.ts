import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { getCourseCards, getCourseWorkspace } from "@/server/course-workspace";
import * as ai from "@/server/ai";

const DAY = 86_400_000;
const NOW = new Date("2026-09-17T12:00:00.000Z");
type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor;
let foreign: Actor;

async function actor(name: string): Promise<Actor> {
  const email = `course-workspace-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: { name, email, password: "Course-workspace-passphrase-2026!" },
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
    school: "Workspace University",
    program: "Mathematics",
    currentYear: 2,
    semester: "Fall 2026",
    academicGoal: "Master proofs",
    studySessionMinutes: 45,
    explanationDifficulty: "INTERMEDIATE",
    timezone: "UTC",
  } });
  return value;
}

function at(days: number) {
  return new Date(NOW.getTime() + days * DAY);
}

async function reset(userId: string) {
  await db().recommendation.deleteMany({ where: { userId } });
  await db().conversation.deleteMany({ where: { userId } });
  await db().studyPlan.deleteMany({ where: { userId } });
  await db().quiz.deleteMany({ where: { userId } });
  await db().learningTopic.deleteMany({ where: { userId } });
  await db().assignment.deleteMany({ where: { userId } });
  await db().exam.deleteMany({ where: { userId } });
  await db().document.deleteMany({ where: { userId } });
  await db().course.deleteMany({ where: { userId } });
}

async function topic(courseId: string, values: {
  name: string;
  mastery: number;
  confidence: number;
  attempts: number;
  trend: "IMPROVING" | "STABLE" | "DECLINING" | "INSUFFICIENT_DATA";
}) {
  return db().learningTopic.create({ data: {
    userId: owner.id,
    courseId,
    name: values.name,
    normalizedName: values.name.toLowerCase(),
    progress: { create: {
      masteryScore: values.mastery,
      confidenceScore: values.confidence,
      questionsAttempted: values.attempts,
      correctAnswers: Math.round(values.attempts * values.mastery / 100),
      incorrectAnswers: values.attempts - Math.round(values.attempts * values.mastery / 100),
      scoreTotal: values.attempts * values.mastery / 100,
      difficultyWeightedScore: values.attempts * values.mastery / 100,
      difficultyWeightTotal: values.attempts,
      practiceSessions: Math.max(1, Math.ceil(values.attempts / 3)),
      mediumAttempts: values.attempts,
      recentAccuracy: values.mastery,
      firstPracticedAt: at(-20),
      lastPracticedAt: at(-1),
      trend: values.trend,
    } },
  } });
}

async function fixture() {
  const course = await db().course.create({ data: {
    userId: owner.id,
    courseCode: "MATH 1240",
    courseName: "Discrete Mathematics",
    professor: "Dr. Ada",
    semester: "Fall 2026",
    description: "Proofs, logic and discrete structures.",
  } });
  const otherCourse = await db().course.create({ data: {
    userId: owner.id,
    courseCode: "COMP 2140",
    courseName: "Data Structures",
    semester: "Fall 2026",
  } });
  const overdue = await db().assignment.create({ data: {
    userId: owner.id, courseId: course.id, title: "Proof set", description: "Induction proofs",
    dueDate: at(-1), priority: "HIGH", estimatedHours: 3, status: "TODO",
  } });
  await db().assignment.create({ data: {
    userId: owner.id, courseId: course.id, title: "Logic worksheet", dueDate: at(2),
    priority: "MEDIUM", estimatedHours: 1, status: "COMPLETED", completedAt: at(-2),
  } });
  const exam = await db().exam.create({ data: {
    userId: owner.id, courseId: course.id, title: "Midterm", examDate: at(5),
    topics: ["Mathematical Induction", "Logic"], notes: "Covers chapters 1–3.",
  } });
  const weak = await topic(course.id, { name: "Mathematical Induction", mastery: 38, confidence: 88, attempts: 12, trend: "DECLINING" });
  const strong = await topic(course.id, { name: "Logic", mastery: 91, confidence: 92, attempts: 14, trend: "IMPROVING" });
  const lowEvidence = await topic(course.id, { name: "Relations", mastery: 42, confidence: 18, attempts: 1, trend: "INSUFFICIENT_DATA" });
  const readyDocument = await db().document.create({ data: {
    userId: owner.id, courseId: course.id, title: "Lecture 6 — Induction", originalFileName: "lecture-6.pdf",
    fileType: "application/pdf", fileSize: 2048, storageKey: `workspace/${randomUUID()}`,
    processingStatus: "READY", pageCount: 12, uploadedAt: at(-1),
  } });
  await db().document.create({ data: {
    userId: owner.id, courseId: course.id, title: "Review sheet", originalFileName: "review.pdf",
    fileType: "application/pdf", fileSize: 1024, storageKey: `workspace/${randomUUID()}`,
    processingStatus: "FAILED", processingError: "Unreadable PDF", uploadedAt: at(-2),
  } });
  const conversation = await db().conversation.create({ data: {
    userId: owner.id, courseId: course.id, title: "Lecture notes", messageCount: 1,
  } });
  await db().conversationMessage.create({ data: {
    userId: owner.id, conversationId: conversation.id, sequence: 1, role: "ASSISTANT",
    content: "Induction starts with a base case and an inductive step.", agentId: "notes", tokenEstimate: 14,
    metadata: { presentationData: JSON.stringify({ title: "Lecture 6 Summary" }), sourceRefs: JSON.stringify([{ documentId: readyDocument.id, pageNumber: 3 }]) },
  } });
  const quiz = await db().quiz.create({ data: {
    userId: owner.id, courseId: course.id, title: "Induction check", topic: weak.name, difficulty: "HARD",
  } });
  const question = await db().quizQuestion.create({ data: {
    userId: owner.id, quizId: quiz.id, position: 1, type: "TRUE_FALSE", prompt: "Induction has a base case.",
    choices: ["True", "False"], correctAnswer: "True", explanation: "It does.", topicNames: [weak.name],
    topicMappings: { create: { courseId: course.id, topicId: weak.id } },
  } });
  const attempt = await db().quizAttempt.create({ data: {
    userId: owner.id, quizId: quiz.id, startedAt: at(-2), completedAt: at(-2),
  } });
  await db().questionAttempt.create({ data: {
    userId: owner.id, quizId: quiz.id, quizAttemptId: attempt.id, questionId: question.id,
    userAnswer: "False", score: 0, isCorrect: false, evaluationMethod: "DETERMINISTIC", attemptedAt: at(-2),
  } });
  const plan = await db().studyPlan.create({ data: {
    userId: owner.id, title: "Midterm preparation", startDate: at(-2), endDate: at(5),
    summary: "Prepare for the midterm.", totalPlannedMinutes: 90, status: "ACTIVE",
    tasks: { create: [
      { courseId: course.id, topicId: weak.id, examId: exam.id, date: at(-1), title: "Review induction", topic: weak.name, activityType: "REVIEW", durationMinutes: 45, priority: 90, status: "COMPLETED", reason: "Repair a reliable gap." },
      { courseId: course.id, topicId: weak.id, examId: exam.id, date: at(1), title: "Induction practice", topic: weak.name, activityType: "PRACTICE", durationMinutes: 45, priority: 88, status: "PLANNED", reason: "Prepare for the exam." },
    ] },
  } });
  await db().recommendation.create({ data: {
    userId: owner.id, type: "WEAK_TOPIC", title: "Review Mathematical Induction",
    message: "Induction has reliable evidence of a mastery gap.", priority: "HIGH", priorityScore: 91,
    status: "ACTIVE", sourceType: "LEARNING_TOPIC", sourceId: weak.id,
    recommendedWorkflowId: "weak-topic-recovery",
    actionPayload: { courseId: course.id, topicId: weak.id, topicName: weak.name },
    reasonCode: "weak-topic", reasonData: { mastery: 38 }, dedupeKey: `workspace:${weak.id}`,
    supersessionKey: `workspace:${weak.id}`, stateFingerprint: "course-workspace-test",
    activeKey: `${owner.id}:workspace:${weak.id}`, expiresAt: at(7),
  } });
  return { course, otherCourse, overdue, exam, weak, strong, lowEvidence, readyDocument, plan };
}

beforeAll(async () => {
  owner = await actor("Course Workspace Owner");
  foreign = await actor("Course Workspace Foreign");
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

describe.sequential("Course Workspace aggregation", () => {
  it("builds useful course cards with deterministic deadlines, exams and attention", async () => {
    const values = await fixture();
    const cards = await getCourseCards(owner.id, owner.headers, { now: NOW });
    expect(cards).toHaveLength(2);
    expect(cards.find((item) => item.id === values.course.id)).toMatchObject({
      courseCode: "MATH 1240",
      professor: "Dr. Ada",
      attention: "needs-attention",
      nextDeadline: { title: "Proof set", overdue: true },
      nextExam: { title: "Midterm", daysRemaining: 5 },
    });
    expect(cards.find((item) => item.id === values.otherCourse.id)?.attention).toBe("low-evidence");
  });

  it("composes overview, assignments, exams, documents and persisted notes", async () => {
    const values = await fixture();
    const result = await getCourseWorkspace(owner.id, values.course.id, owner.headers, { now: NOW });
    expect(result.course).toMatchObject({ courseCode: "MATH 1240", courseName: "Discrete Mathematics" });
    expect(result.overview).toMatchObject({
      nextAssignment: { id: values.overdue.id, overdue: true },
      nextExam: { id: values.exam.id, daysRemaining: 5 },
      topWeakTopic: { id: values.weak.id },
      latestReadyDocument: { id: values.readyDocument.id },
    });
    expect(result.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Proof set", priority: "HIGH" })]));
    expect(result.exams[0]).toEqual(expect.objectContaining({ title: "Midterm", readinessLabel: expect.any(String), topics: ["Mathematical Induction", "Logic"] }));
    expect(result.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Lecture 6 — Induction", category: "Lecture", processingStatus: "READY" }),
      expect.objectContaining({ title: "Review sheet", processingStatus: "FAILED" }),
    ]));
    expect(result.notes[0]).toMatchObject({ title: "Lecture 6 Summary", documentIds: [values.readyDocument.id] });
  });

  it("uses confidence-aware learning state, quiz history and the existing recommendation", async () => {
    const values = await fixture();
    const result = await getCourseWorkspace(owner.id, values.course.id, owner.headers, { now: NOW });
    expect(result.weakTopics).toContainEqual(expect.objectContaining({ id: values.weak.id, stateLabel: "Weak", confidenceLabel: "High confidence" }));
    expect(result.strongTopics).toContainEqual(expect.objectContaining({ id: values.strong.id, stateLabel: "Strong" }));
    expect(result.topics).toContainEqual(expect.objectContaining({ id: values.lowEvidence.id, needsMoreData: true, stateLabel: "Needs more evidence" }));
    expect(result.recentQuizzes[0]).toMatchObject({ topic: "Mathematical Induction", difficulty: "hard", accuracy: 0, answered: 1 });
    expect(result.nextBestAction).toMatchObject({ title: "Review Mathematical Induction", actionLabel: "Start recovery" });
  });

  it("returns the active course plan with completed and upcoming tasks", async () => {
    const values = await fixture();
    const result = await getCourseWorkspace(owner.id, values.course.id, owner.headers, { now: NOW });
    expect(result.studyPlan).toMatchObject({
      id: values.plan.id,
      title: "Midterm preparation",
      completedTasks: 1,
      remainingTasks: 1,
      completionPercentage: 50,
      nextTask: { title: "Induction practice", durationMinutes: 45 },
    });
  });

  it("refreshes from database state after assignment and study-task changes", async () => {
    const values = await fixture();
    const before = await getCourseWorkspace(owner.id, values.course.id, owner.headers, { now: NOW });
    expect(before.overview.nextAssignment?.id).toBe(values.overdue.id);
    await db().assignment.update({ where: { id: values.overdue.id }, data: { status: "COMPLETED", completedAt: NOW } });
    await db().studyTask.updateMany({ where: { userId: owner.id, studyPlanId: values.plan.id, status: "PLANNED" }, data: { status: "COMPLETED" } });
    const after = await getCourseWorkspace(owner.id, values.course.id, owner.headers, { now: NOW });
    expect(after.overview.nextAssignment).toBeNull();
    expect(after.studyPlan).toMatchObject({ completedTasks: 2, remainingTasks: 0, completionPercentage: 100 });
  });

  it("degrades one failed section without losing the rest of the workspace", async () => {
    const values = await fixture();
    const result = await getCourseWorkspace(owner.id, values.course.id, owner.headers, {
      now: NOW,
      dependencies: { loadDocuments: async () => { throw new Error("document service unavailable"); } },
    });
    expect(result.documents).toEqual([]);
    expect(result.sectionErrors).toContain("documents");
    expect(result.assignments).toHaveLength(2);
    expect(result.topics.length).toBeGreaterThan(0);
  });

  it("enforces session and course ownership across the full aggregate", async () => {
    const values = await fixture();
    await expect(getCourseWorkspace(owner.id, values.course.id, foreign.headers, { now: NOW })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(getCourseWorkspace(foreign.id, values.course.id, foreign.headers, { now: NOW })).rejects.toThrow();
    expect(JSON.stringify(await getCourseCards(foreign.id, foreign.headers, { now: NOW }))).not.toContain("MATH 1240");
  });

  it("performs normal list and workspace loads without initializing an AI provider", async () => {
    const values = await fixture();
    const provider = vi.spyOn(ai, "getAIProvider");
    await getCourseCards(owner.id, owner.headers, { now: NOW });
    await getCourseWorkspace(owner.id, values.course.id, owner.headers, { now: NOW });
    expect(provider).not.toHaveBeenCalled();
  });
});
