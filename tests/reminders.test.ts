import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendOptions } from "pg-boss";
import * as ai from "@/server/ai";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import type { BackgroundJobPublisher } from "@/server/jobs/client";
import { enqueueReminderRefresh } from "@/server/jobs/enqueue";
import { enqueueDomainBackgroundEvent } from "@/server/jobs/events";
import { executeBackgroundJob } from "@/server/jobs/executor";
import { refreshRemindersJob } from "@/server/jobs/refresh-reminders";
import { createScheduledRecommendationRefreshJob } from "@/server/jobs/scheduled-recommendations";
import type { JobRunReference } from "@/server/jobs/types";
import {
  calculateReminderPriority,
  dismissReminder,
  evaluateReminders,
  getReminderAction,
  getUpcomingReminders,
  reminderPriorityLevel,
  snoozeReminder,
  updateReminderPreferences,
} from "@/server/reminders";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-09-15T12:00:00.000Z");
const at = (days: number, hours = 0) => new Date(NOW.getTime() + days * DAY + hours * HOUR);

type Actor = { id: string };
let owner: Actor;
let foreign: Actor;

async function actor(label: string): Promise<Actor> {
  const response = await auth().api.signUpEmail({
    body: {
      name: label,
      email: `reminder-${randomUUID()}@example.test`,
      password: "Reminder-test-passphrase-2026!",
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const result = { id: body.user.id };
  await db().profile.create({ data: {
    userId: result.id,
    school: "Reminder University",
    program: "Computer Science",
    currentYear: 2,
    semester: "Fall 2026",
    academicGoal: "Stay current",
    studySessionMinutes: 45,
    explanationDifficulty: "INTERMEDIATE",
    timezone: "UTC",
  } });
  return result;
}

async function reset(userId: string) {
  await db().jobRun.deleteMany({ where: { userId } });
  await db().reminder.deleteMany({ where: { userId } });
  await db().reminderPreference.deleteMany({ where: { userId } });
  await db().recommendation.deleteMany({ where: { userId } });
  await db().workflowRun.deleteMany({ where: { userId } });
  await db().studyPlan.deleteMany({ where: { userId } });
  await db().learningTopic.deleteMany({ where: { userId } });
  await db().assignment.deleteMany({ where: { userId } });
  await db().exam.deleteMany({ where: { userId } });
  await db().course.deleteMany({ where: { userId } });
  await db().profile.update({ where: { userId }, data: { timezone: "UTC" } });
}

async function course(userId = owner.id, code = "MATH 1240") {
  return db().course.create({ data: {
    userId, courseCode: code, courseName: "Discrete Mathematics", semester: "Fall 2026",
  } });
}

async function assignmentFixture(input: {
  userId?: string;
  days?: number;
  dueDate?: Date;
  status?: "TODO" | "IN_PROGRESS" | "COMPLETED";
  priority?: "LOW" | "MEDIUM" | "HIGH";
  estimatedHours?: number;
} = {}) {
  const userId = input.userId ?? owner.id;
  const subject = await course(userId, `MATH ${randomUUID().slice(0, 4)}`);
  const status = input.status ?? "TODO";
  const assignment = await db().assignment.create({ data: {
    userId,
    courseId: subject.id,
    title: "Proof Assignment",
    dueDate: input.dueDate ?? at(input.days ?? 1),
    status,
    priority: input.priority ?? "HIGH",
    estimatedHours: input.estimatedHours ?? 4,
    completedAt: status === "COMPLETED" ? NOW : null,
  } });
  return { course: subject, assignment };
}

async function examFixture(input: { days?: number; topics?: string[] } = {}) {
  const subject = await course(owner.id, `MATH ${randomUUID().slice(0, 4)}`);
  const exam = await db().exam.create({ data: {
    userId: owner.id,
    courseId: subject.id,
    title: "Midterm",
    examDate: at(input.days ?? 3),
    topics: input.topics ?? [],
  } });
  return { course: subject, exam };
}

async function topicFixture(
  courseId: string,
  input: { mastery: number; confidence: number; name?: string },
) {
  const name = input.name ?? "Mathematical Induction";
  return db().learningTopic.create({
    data: {
      userId: owner.id,
      courseId,
      name,
      normalizedName: name.normalize("NFKC").trim().toLocaleLowerCase(),
      progress: { create: {
        masteryScore: input.mastery,
        confidenceScore: input.confidence,
        questionsAttempted: 6,
        correctAnswers: 2,
        incorrectAnswers: 4,
        scoreTotal: 2,
        difficultyWeightedScore: 2,
        difficultyWeightTotal: 6,
        practiceSessions: 2,
        mediumAttempts: 6,
        recentAccuracy: 33,
        firstPracticedAt: at(-10),
        lastPracticedAt: at(-1),
      } },
    },
    include: { progress: true },
  });
}

async function studyPlanFixture(tasks: Array<{
  title: string;
  date: Date;
  priority: number;
  status?: "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
  examId?: string;
}> = []) {
  return db().studyPlan.create({
    data: {
      userId: owner.id,
      title: "Exam Study Plan",
      startDate: at(-3),
      endDate: at(10),
      summary: "Prepare consistently.",
      totalPlannedMinutes: tasks.length * 45,
      tasks: { create: tasks.map((task) => ({
        title: task.title,
        date: task.date,
        activityType: "PRACTICE" as const,
        durationMinutes: 45,
        priority: task.priority,
        status: task.status ?? "PLANNED",
        reason: "Prepare for the exam.",
        examId: task.examId,
      })) },
    },
    include: { tasks: true },
  });
}

function fakePublisher() {
  const calls: { name: string; data: object | null; options: SendOptions | null }[] = [];
  const boundary: BackgroundJobPublisher = {
    async sendDebounced(name, data, options) {
      calls.push({ name, data, options: options ?? null });
      return options?.id ?? randomUUID();
    },
  };
  return { boundary, calls };
}

function reference(id: string): JobRunReference {
  return { id, queueJobId: `queue-${id}`, status: "PENDING", deduplicated: false };
}

beforeAll(async () => {
  owner = await actor("Reminder Owner");
  foreign = await actor("Reminder Foreign");
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

describe.sequential("Deadline & Study Reminder Engine", () => {
  it("creates a selective assignment due reminder", async () => {
    const { assignment } = await assignmentFixture({ days: 1 });
    const result = await evaluateReminders(owner.id, { now: NOW });
    expect(result.reminders).toContainEqual(expect.objectContaining({
      type: "assignment-due", sourceId: assignment.id, priority: "high",
      reasonCode: "ASSIGNMENT_DUE_TOMORROW",
    }));
  });

  it("ignores completed assignments", async () => {
    await assignmentFixture({ days: 1, status: "COMPLETED" });
    expect((await evaluateReminders(owner.id, { now: NOW })).reminders).toHaveLength(0);
  });

  it("creates one overdue assignment reminder", async () => {
    await assignmentFixture({ days: -2, status: "IN_PROGRESS" });
    const result = await evaluateReminders(owner.id, { now: NOW });
    expect(result.reminders[0]).toMatchObject({
      type: "assignment-overdue", reasonCode: "ASSIGNMENT_OVERDUE",
      reasonData: { daysOverdue: 2 },
    });
  });

  it("creates an upcoming exam reminder", async () => {
    const { exam } = await examFixture({ days: 7 });
    expect((await evaluateReminders(owner.id, { now: NOW })).reminders)
      .toContainEqual(expect.objectContaining({ type: "exam-upcoming", sourceId: exam.id }));
  });

  it("creates a high-priority exam-tomorrow reminder", async () => {
    await examFixture({ days: 1 });
    const reminder = (await evaluateReminders(owner.id, { now: NOW })).reminders
      .find((item) => item.type === "exam-tomorrow");
    expect(reminder).toMatchObject({ priority: "high", reasonCode: "EXAM_TOMORROW" });
  });

  it("selects one meaningful weak topic before an exam", async () => {
    const { course: subject } = await examFixture({ days: 3, topics: ["Mathematical Induction", "Logic"] });
    const weakest = await topicFixture(subject.id, { mastery: 38, confidence: 82 });
    await topicFixture(subject.id, { mastery: 55, confidence: 70, name: "Logic" });
    const reminders = (await evaluateReminders(owner.id, { now: NOW })).reminders;
    expect(reminders.filter((item) => item.type === "weak-topic-before-exam"))
      .toEqual([expect.objectContaining({ sourceId: weakest.id, action: expect.objectContaining({ id: "weak-topic-recovery" }) })]);
  });

  it("labels low-confidence evidence as diagnostic practice", async () => {
    const { course: subject } = await examFixture({ days: 3, topics: ["Recursion"] });
    await topicFixture(subject.id, { mastery: 45, confidence: 20, name: "Recursion" });
    const reminder = (await evaluateReminders(owner.id, { now: NOW })).reminders
      .find((item) => item.type === "diagnostic-practice");
    expect(reminder).toMatchObject({ action: { type: "agent", id: "quiz" } });
    expect(reminder?.message).toContain("limited evidence");
  });

  it("schedules a timed study-session reminder using the configured lead time", async () => {
    const plan = await studyPlanFixture([{ title: "Induction practice", date: at(0, 2), priority: 70 }]);
    await updateReminderPreferences(owner.id, { leadTimeMinutes: 30 });
    const reminder = (await evaluateReminders(owner.id, { now: NOW })).reminders
      .find((item) => item.type === "study-session");
    expect(reminder).toMatchObject({ sourceId: plan.tasks[0].id, scheduledFor: "2026-09-15T13:30:00.000Z" });
  });

  it("creates a reminder for an important missed StudyTask", async () => {
    const plan = await studyPlanFixture([{ title: "Critical review", date: at(-1), priority: 90 }]);
    expect((await evaluateReminders(owner.id, { now: NOW })).reminders)
      .toContainEqual(expect.objectContaining({ type: "missed-study-task", sourceId: plan.tasks[0].id }));
  });

  it("detects an existing Study Plan falling behind", async () => {
    const plan = await studyPlanFixture([
      { title: "Missed one", date: at(-2), priority: 85 },
      { title: "Missed two", date: at(-1), priority: 80 },
    ]);
    expect((await evaluateReminders(owner.id, { now: NOW })).reminders)
      .toContainEqual(expect.objectContaining({ type: "study-plan-behind", sourceId: plan.id }));
  });

  it("waits before reminding about a workflow checkpoint", async () => {
    const run = await db().workflowRun.create({ data: {
      userId: owner.id,
      workflowId: "assignment-support",
      status: "WAITING_FOR_INPUT",
      currentStep: "student-draft",
      input: {}, context: {},
      updatedAt: new Date(NOW.getTime() - 25 * HOUR),
    } });
    expect((await evaluateReminders(owner.id, { now: NOW })).reminders)
      .toContainEqual(expect.objectContaining({ type: "workflow-waiting", sourceId: run.id }));
  });

  it("uses deterministic bounded priority ranking", () => {
    expect(calculateReminderPriority({ urgency: 40, academicImpact: 30, missedWork: 20 })).toBe(90);
    expect(calculateReminderPriority({ urgency: 80, academicImpact: 80 })).toBe(100);
    expect(reminderPriorityLevel(39)).toBe("low");
    expect(reminderPriorityLevel(70)).toBe("high");
    expect(reminderPriorityLevel(95)).toBe("critical");
  });

  it("uses the student's timezone for deadline-day timing", async () => {
    await db().profile.update({ where: { userId: owner.id }, data: { timezone: "America/Winnipeg" } });
    await assignmentFixture({ dueDate: new Date("2026-09-16T00:30:00.000Z") });
    const reminder = (await evaluateReminders(owner.id, { now: NOW })).reminders[0];
    expect(reminder).toMatchObject({ reasonCode: "ASSIGNMENT_DUE_TODAY", reasonData: { daysRemaining: 0 } });
  });

  it("keeps intelligence current during configured quiet hours", async () => {
    const late = new Date("2026-09-15T23:00:00.000Z");
    await assignmentFixture({ dueDate: new Date("2026-09-16T18:00:00.000Z") });
    await updateReminderPreferences(owner.id, { quietHoursStart: 22 * 60, quietHoursEnd: 8 * 60 });
    const reminder = (await evaluateReminders(owner.id, { now: late })).reminders[0];
    expect(reminder.scheduledFor).toBe(late.toISOString());
    expect(reminder.reasonData).not.toHaveProperty("quietHoursDeferred");
  });

  it("deduplicates the same source, type, and urgency window", async () => {
    await assignmentFixture({ days: 1 });
    const first = await evaluateReminders(owner.id, { now: NOW });
    const second = await evaluateReminders(owner.id, { now: NOW });
    expect(await db().reminder.count({ where: { userId: owner.id } })).toBe(1);
    expect(first.created).toBe(1);
    expect(second.deduplicated).toBe(1);
  });

  it("supersedes an older reminder when urgency changes", async () => {
    const { assignment } = await assignmentFixture({ days: 7 });
    const old = (await evaluateReminders(owner.id, { now: NOW })).reminders[0];
    const current = (await evaluateReminders(owner.id, { now: at(6) })).reminders[0];
    expect(current.id).not.toBe(old.id);
    expect(await db().reminder.findUnique({ where: { id: old.id } })).toMatchObject({ status: "EXPIRED", activeKey: null });
    expect(current.sourceId).toBe(assignment.id);
  });

  it("preserves a snoozed reminder until its requested time", async () => {
    await assignmentFixture({ days: 1 });
    const reminder = (await evaluateReminders(owner.id, { now: NOW })).reminders[0];
    await snoozeReminder(owner.id, reminder.id, new Date(NOW.getTime() + 2 * HOUR), NOW);
    const refreshed = await evaluateReminders(owner.id, { now: new Date(NOW.getTime() + HOUR) });
    expect(refreshed.reminders[0]).toMatchObject({ id: reminder.id, status: "snoozed" });
    expect(refreshed.deduplicated).toBe(1);
  });

  it("preserves dismissal for the same reminder state", async () => {
    await assignmentFixture({ days: 3 });
    const reminder = (await evaluateReminders(owner.id, { now: NOW })).reminders[0];
    await dismissReminder(owner.id, reminder.id, NOW);
    const refreshed = await evaluateReminders(owner.id, { now: NOW });
    expect(refreshed.reminders).toHaveLength(0);
    expect(refreshed.dismissed).toBe(1);
  });

  it("allows a dismissed source to reactivate after material urgency change", async () => {
    await assignmentFixture({ days: 7 });
    const first = (await evaluateReminders(owner.id, { now: NOW })).reminders[0];
    await dismissReminder(owner.id, first.id, NOW);
    const changed = await evaluateReminders(owner.id, { now: at(6) });
    expect(changed.reminders).toHaveLength(1);
    expect(changed.reminders[0].id).not.toBe(first.id);
  });

  it("expires a reminder when its source is completed", async () => {
    const { assignment } = await assignmentFixture({ days: 1 });
    const reminder = (await evaluateReminders(owner.id, { now: NOW })).reminders[0];
    await db().assignment.update({ where: { id: assignment.id }, data: { status: "COMPLETED", completedAt: NOW } });
    const refreshed = await evaluateReminders(owner.id, { now: NOW });
    expect(refreshed.reminders).toHaveLength(0);
    expect(await db().reminder.findUnique({ where: { id: reminder.id } })).toMatchObject({ status: "EXPIRED" });
  });

  it("validates action targets and owned payload references", async () => {
    await assignmentFixture({ days: 1 });
    const reminder = (await evaluateReminders(owner.id, { now: NOW })).reminders[0];
    expect(await getReminderAction(owner.id, reminder.id)).toMatchObject({
      target: { type: "workflow", id: "assignment-support" },
    });
    await expect(getReminderAction(foreign.id, reminder.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().reminder.update({ where: { id: reminder.id }, data: { actionTargetId: "unregistered-workflow" } });
    await expect(getReminderAction(owner.id, reminder.id)).rejects.toMatchObject({ code: "INVALID_TARGET" });
  });

  it("executes refresh-user-reminders through the shared background executor", async () => {
    await assignmentFixture({ days: 1 });
    const fake = fakePublisher();
    const run = await enqueueReminderRefresh(owner.id, {
      idempotencyKey: `reminder-job:${randomUUID()}`,
    }, { publisher: fake.boundary });
    const call = fake.calls[0];
    const result = await executeBackgroundJob(refreshRemindersJob, {
      id: call.options!.id!, name: call.name, data: call.data,
      retryCount: 0, retryLimit: 3, signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(await db().jobRun.findUnique({ where: { id: run.id } })).toMatchObject({
      status: "COMPLETED",
      metadata: expect.objectContaining({ created: 1, active: 1 }),
    });
  });

  it("fans scheduled active-user refresh into recommendation and reminder jobs", async () => {
    const recommendation = vi.fn(async () => reference("recommendation"));
    const reminder = vi.fn(async () => reference("reminder"));
    const job = createScheduledRecommendationRefreshJob({
      selectPage: async () => ({ users: [{ userId: owner.id, timezone: "UTC" }], nextCursor: null }),
      enqueueUserRefresh: recommendation,
      enqueueReminderRefresh: reminder,
    });
    const result = await job.handler({
      payload: { version: 1, scheduledFor: NOW.toISOString() },
      signal: new AbortController().signal,
      attempt: 1,
      jobRunId: "scheduled-reminders",
    });
    expect(recommendation).toHaveBeenCalledOnce();
    expect(reminder).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ recommendationJobsEnqueued: 1, reminderJobsEnqueued: 1 });
  });

  it("enqueues recommendation and reminder refreshes for domain events", async () => {
    const fake = fakePublisher();
    const result = await enqueueDomainBackgroundEvent({
      eventId: randomUUID(),
      name: "ASSIGNMENT_UPDATED",
      userId: owner.id,
      resourceId: "assignment-1",
      occurredAt: NOW,
    }, { publisher: fake.boundary });
    expect(fake.calls.map((call) => call.name).sort()).toEqual([
      "refresh-user-recommendations", "refresh-user-reminders",
    ]);
    expect(result.reminder.status).toBe("PENDING");
  });

  it("never includes cross-user academic sources", async () => {
    const foreignWork = await assignmentFixture({ userId: foreign.id, days: 1 });
    const ownerResult = await evaluateReminders(owner.id, { now: NOW });
    expect(JSON.stringify(ownerResult)).not.toContain(foreignWork.assignment.id);
    expect(await db().reminder.count({ where: { userId: owner.id } })).toBe(0);
  });

  it("requires no AI provider for detection, timing, or wording", async () => {
    const provider = vi.spyOn(ai, "getAIProvider");
    await assignmentFixture({ days: 1 });
    await evaluateReminders(owner.id, { now: NOW });
    await getUpcomingReminders({ userId: owner.id, now: NOW, refresh: false });
    expect(provider).not.toHaveBeenCalled();
  });
});
