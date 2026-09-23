import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgBoss, SendOptions } from "pg-boss";
import * as ai from "@/server/ai";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { selectActiveRecommendationUsers } from "@/server/jobs/active-users";
import { enqueueDomainBackgroundEvent } from "@/server/jobs/events";
import { executeBackgroundJob } from "@/server/jobs/executor";
import { registerRecommendationRefreshSchedule } from "@/server/jobs/schedule";
import {
  assertManualBackgroundJobTriggerAllowed,
  enqueueScheduledRecommendationCycle,
} from "@/server/jobs/scheduled-enqueue";
import {
  createScheduledRecommendationRefreshJob,
  REFRESH_ACTIVE_USER_RECOMMENDATIONS_JOB,
  RECOMMENDATION_SCHEDULE_KEY,
} from "@/server/jobs/scheduled-recommendations";
import { localDateKey } from "@/server/jobs/time";
import type { BackgroundJobPublisher } from "@/server/jobs/client";
import type { JobRunReference } from "@/server/jobs/types";
import {
  dismissRecommendation,
  evaluateRecommendations,
} from "@/server/recommendations";

const DAY = 86_400_000;
const NOW = new Date("2026-09-15T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

type Actor = { id: string };
const actors: Actor[] = [];
let owner: Actor;
let foreign: Actor;

async function actor(label: string, timezone = "UTC"): Promise<Actor> {
  const response = await auth().api.signUpEmail({
    body: {
      name: label,
      email: `scheduled-${randomUUID()}@example.test`,
      password: "Scheduled-test-passphrase-2026!",
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const result = { id: body.user.id };
  actors.push(result);
  await db().profile.create({ data: {
    userId: result.id,
    school: "Schedule University",
    program: "Computer Science",
    currentYear: 2,
    semester: "Fall 2026",
    academicGoal: "Stay current",
    studySessionMinutes: 45,
    explanationDifficulty: "INTERMEDIATE",
    timezone,
  } });
  return result;
}

async function reset(userId: string) {
  await db().jobRun.deleteMany({ where: { userId } });
  await db().recommendation.deleteMany({ where: { userId } });
  await db().workflowRun.deleteMany({ where: { userId } });
  await db().studyPlan.deleteMany({ where: { userId } });
  await db().careerPlan.deleteMany({ where: { userId } });
  await db().assignment.deleteMany({ where: { userId } });
  await db().exam.deleteMany({ where: { userId } });
  await db().course.deleteMany({ where: { userId } });
}

async function academicFixture(userId = owner.id) {
  const course = await db().course.create({ data: {
    userId,
    courseCode: `SCHEDULE ${randomUUID().slice(0, 5)}`,
    courseName: "Scheduled Systems",
    semester: "Fall 2026",
  } });
  return { course };
}

function runReference(index: number, deduplicated = false): JobRunReference {
  return {
    id: `run-${index}`,
    queueJobId: `queue-${index}`,
    status: "PENDING",
    deduplicated,
  };
}

function context(jobRunId = "schedule-run") {
  return {
    payload: { version: 1 as const, scheduledFor: NOW.toISOString() },
    signal: new AbortController().signal,
    attempt: 1,
    jobRunId,
  };
}

function userPublisher() {
  const calls: { name: string; data: object | null; options: SendOptions | null }[] = [];
  const boundary: BackgroundJobPublisher = {
    async sendDebounced(name, data, options) {
      calls.push({ name, data, options: options ?? null });
      return options?.id ?? randomUUID();
    },
  };
  return { boundary, calls };
}

beforeAll(async () => {
  owner = await actor("Scheduled Owner", "America/Winnipeg");
  foreign = await actor("Scheduled Foreign");
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset(owner.id);
  await reset(foreign.id);
  await db().jobRun.deleteMany({ where: { userId: null } });
});

afterAll(async () => {
  await db().user.deleteMany({ where: { id: { in: actors.map((item) => item.id) } } });
  await db().$disconnect();
});

describe.sequential("Scheduled Recommendation Refresh", () => {
  it("registers one framework-native daily schedule", async () => {
    const schedule = vi.fn(async () => undefined);
    const registered = await registerRecommendationRefreshSchedule(
      { schedule } as unknown as Pick<PgBoss, "schedule">,
      { enabled: true, cron: "15 4 * * *" },
    );
    expect(registered).toBe(true);
    expect(schedule).toHaveBeenCalledWith(
      REFRESH_ACTIVE_USER_RECOMMENDATIONS_JOB,
      "15 4 * * *",
      { version: 1 },
      expect.objectContaining({ key: RECOMMENDATION_SCHEDULE_KEY, tz: "UTC", missed: "once" }),
    );
  });

  it("selects users with current academic work", async () => {
    const { course } = await academicFixture();
    await db().assignment.create({ data: {
      userId: owner.id,
      courseId: course.id,
      title: "Active deadline",
      dueDate: at(3),
    } });
    const page = await selectActiveRecommendationUsers({ now: NOW, limit: 100 });
    expect(page.users).toContainEqual({ userId: owner.id, timezone: "America/Winnipeg" });
  });

  it("skips users without recent activity or current work", async () => {
    const inactive = await actor("Inactive Schedule User");
    await db().session.deleteMany({ where: { userId: inactive.id } });
    const page = await selectActiveRecommendationUsers({ now: NOW, limit: 100 });
    expect(page.users.map((user) => user.userId)).not.toContain(inactive.id);
  });

  it("paginates active users without loading the full set", async () => {
    const created = await Promise.all([
      actor("Page One"), actor("Page Two"), actor("Page Three"),
    ]);
    for (const item of created) {
      const { course } = await academicFixture(item.id);
      await db().exam.create({ data: {
        userId: item.id,
        courseId: course.id,
        title: "Paged exam",
        examDate: at(20),
        topics: [],
      } });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await selectActiveRecommendationUsers({ now: NOW, limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.users.map((user) => user.userId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(created.every((item) => seen.includes(item.id))).toBe(true);
  });

  it("fans out one existing per-user refresh job for each discovered user", async () => {
    const enqueue = vi.fn(async (userId: string) => {
      void userId;
      return runReference(enqueue.mock.calls.length);
    });
    const job = createScheduledRecommendationRefreshJob({
      selectPage: async () => ({ users: [
        { userId: "user-a", timezone: "UTC" },
        { userId: "user-b", timezone: "UTC" },
      ], nextCursor: null }),
      enqueueUserRefresh: enqueue,
      enqueueReminderRefresh: async (userId) => runReference(`reminder-${userId}`.length),
      pageSize: 100,
    });
    const result = await job.handler(context());
    expect(enqueue.mock.calls.map(([userId]) => userId)).toEqual(["user-a", "user-b"]);
    expect(result).toMatchObject({ activeUsersDiscovered: 2, recommendationJobsEnqueued: 2, reminderJobsEnqueued: 2 });
  });

  it("uses a user-local daily idempotency key", async () => {
    const fake = userPublisher();
    const enqueue = (userId: string, options: Parameters<typeof import("@/server/jobs/enqueue").enqueueRecommendationRefresh>[1]) =>
      import("@/server/jobs/enqueue").then(({ enqueueRecommendationRefresh }) =>
        enqueueRecommendationRefresh(userId, options, { publisher: fake.boundary }));
    const enqueueReminder = (userId: string, options: Parameters<typeof import("@/server/jobs/enqueue").enqueueReminderRefresh>[1]) =>
      import("@/server/jobs/enqueue").then(({ enqueueReminderRefresh }) =>
        enqueueReminderRefresh(userId, options, { publisher: fake.boundary }));
    const job = createScheduledRecommendationRefreshJob({
      selectPage: async () => ({ users: [{ userId: owner.id, timezone: "America/Winnipeg" }], nextCursor: null }),
      enqueueUserRefresh: enqueue,
      enqueueReminderRefresh: enqueueReminder,
    });
    const first = await job.handler(context("daily-one"));
    const second = await job.handler(context("daily-two"));
    expect(first.jobsEnqueued).toBe(2);
    expect(second.duplicatesSkipped).toBe(2);
    expect(fake.calls).toHaveLength(2);
  });

  it("keeps event refreshes separate from the daily window", async () => {
    const fake = userPublisher();
    const enqueue = (userId: string, options: Parameters<typeof import("@/server/jobs/enqueue").enqueueRecommendationRefresh>[1]) =>
      import("@/server/jobs/enqueue").then(({ enqueueRecommendationRefresh }) =>
        enqueueRecommendationRefresh(userId, options, { publisher: fake.boundary }));
    const enqueueReminder = (userId: string, options: Parameters<typeof import("@/server/jobs/enqueue").enqueueReminderRefresh>[1]) =>
      import("@/server/jobs/enqueue").then(({ enqueueReminderRefresh }) =>
        enqueueReminderRefresh(userId, options, { publisher: fake.boundary }));
    const job = createScheduledRecommendationRefreshJob({
      selectPage: async () => ({ users: [{ userId: owner.id, timezone: "UTC" }], nextCursor: null }),
      enqueueUserRefresh: enqueue,
      enqueueReminderRefresh: enqueueReminder,
    });
    await job.handler(context());
    await enqueueDomainBackgroundEvent({
      eventId: "quiz-event-after-schedule",
      name: "QUIZ_COMPLETED",
      userId: owner.id,
    }, { publisher: fake.boundary });
    expect(fake.calls).toHaveLength(4);
  });

  it("raises assignment urgency as its deadline approaches", async () => {
    const { course } = await academicFixture();
    await db().assignment.create({ data: {
      userId: owner.id, courseId: course.id, title: "Timed assignment",
      dueDate: at(4), priority: "HIGH",
    } });
    const earlier = (await evaluateRecommendations(owner.id, { now: NOW })).recommendations[0];
    const later = (await evaluateRecommendations(owner.id, { now: at(3) })).recommendations[0];
    expect(later.priorityScore).toBeGreaterThan(earlier.priorityScore);
    expect(later.reasonData.daysRemaining).toBe(1);
  });

  it("raises exam urgency as the exam approaches", async () => {
    const { course } = await academicFixture();
    await db().exam.create({ data: {
      userId: owner.id, courseId: course.id, title: "Timed exam",
      examDate: at(10), topics: [],
    } });
    const earlier = (await evaluateRecommendations(owner.id, { now: NOW })).recommendations[0];
    const later = (await evaluateRecommendations(owner.id, { now: at(8) })).recommendations[0];
    expect(later.priorityScore).toBeGreaterThan(earlier.priorityScore);
    expect(later.reasonData.daysRemaining).toBe(2);
  });

  it("expires an exam recommendation after the exam passes", async () => {
    const { course } = await academicFixture();
    await db().exam.create({ data: {
      userId: owner.id, courseId: course.id, title: "Past exam",
      examDate: at(2), topics: [],
    } });
    const first = (await evaluateRecommendations(owner.id, { now: NOW })).recommendations[0];
    const after = await evaluateRecommendations(owner.id, { now: at(4) });
    expect(after.recommendations).toHaveLength(0);
    expect(await db().recommendation.findUnique({ where: { id: first.id } }))
      .toMatchObject({ status: "EXPIRED", activeKey: null });
  });

  it("preserves dismissal suppression when time has not changed the state", async () => {
    const { course } = await academicFixture();
    await db().assignment.create({ data: {
      userId: owner.id, courseId: course.id, title: "Dismissed deadline",
      dueDate: at(6), priority: "MEDIUM",
    } });
    const first = (await evaluateRecommendations(owner.id, { now: NOW })).recommendations[0];
    await dismissRecommendation(owner.id, first.id, NOW);
    const repeat = await evaluateRecommendations(owner.id, { now: NOW });
    expect(repeat.recommendations).toHaveLength(0);
    expect(repeat.suppressed).toBe(1);
  });

  it("continues fan-out and reports a partial enqueue failure", async () => {
    const enqueue = vi.fn(async (userId: string) => {
      if (userId === "user-b") throw new Error("queue unavailable");
      return runReference(enqueue.mock.calls.length);
    });
    const job = createScheduledRecommendationRefreshJob({
      selectPage: async () => ({ users: [
        { userId: "user-a", timezone: "UTC" },
        { userId: "user-b", timezone: "UTC" },
        { userId: "user-c", timezone: "UTC" },
      ], nextCursor: null }),
      enqueueUserRefresh: enqueue,
      enqueueReminderRefresh: enqueue,
    });
    expect(await job.handler(context())).toMatchObject({ jobsEnqueued: 4, failedEnqueues: 2 });
    expect(enqueue).toHaveBeenCalledTimes(6);
  });

  it("uses bounded scheduler retries for page-level failures", async () => {
    const job = createScheduledRecommendationRefreshJob({
      selectPage: async () => {
        const error = new Error("database unavailable") as Error & { code: string };
        error.code = "P1001";
        throw error;
      },
    });
    expect(job.retryPolicy).toMatchObject({ limit: 2, exponentialBackoff: true });
    const send = vi.fn(async (_name, _data, options) => options?.id ?? randomUUID());
    const run = await enqueueScheduledRecommendationCycle({
      idempotencyKey: `retry-audit:${randomUUID()}`,
      now: NOW,
    }, { publisher: { send } as unknown as Pick<PgBoss, "send"> });
    const queued = send.mock.calls[0];
    const result = await executeBackgroundJob(job, {
      id: queued[2].id!,
      name: queued[0],
      data: queued[1],
      retryCount: 0,
      retryLimit: 2,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "failed", output: { errorCode: "DATABASE_ERROR", retryable: true } });
    expect(await db().jobRun.findUnique({ where: { id: run.id } })).toMatchObject({
      status: "PENDING",
      attempt: 1,
    });
  });

  it("isolates per-user failures from successful user jobs", async () => {
    const successful: string[] = [];
    const job = createScheduledRecommendationRefreshJob({
      selectPage: async () => ({ users: [
        { userId: "good", timezone: "UTC" },
        { userId: "bad", timezone: "UTC" },
      ], nextCursor: null }),
      enqueueUserRefresh: async (userId) => {
        if (userId === "bad") throw new Error("one user failed");
        successful.push(userId);
        return runReference(1);
      },
      enqueueReminderRefresh: async () => runReference(2),
    });
    await job.handler(context());
    expect(successful).toEqual(["good"]);
  });

  it("bounds fan-out concurrency within each page", async () => {
    let inFlight = 0;
    let maximum = 0;
    const job = createScheduledRecommendationRefreshJob({
      selectPage: async () => ({
        users: Array.from({ length: 7 }, (_, index) => ({ userId: `user-${index}`, timezone: "UTC" })),
        nextCursor: null,
      }),
      fanoutConcurrency: 2,
      enqueueUserRefresh: async () => {
        inFlight++;
        maximum = Math.max(maximum, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        return runReference(maximum);
      },
      enqueueReminderRefresh: async () => {
        inFlight++;
        maximum = Math.max(maximum, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        return runReference(maximum);
      },
    });
    await job.handler(context());
    expect(maximum).toBe(2);
  });

  it("derives daily windows and deadline days from the user timezone", async () => {
    const boundary = new Date("2026-09-16T00:30:00.000Z");
    expect(localDateKey(boundary, "Asia/Seoul")).toBe("2026-09-16");
    expect(localDateKey(boundary, "America/Winnipeg")).toBe("2026-09-15");
    expect(localDateKey(boundary, "invalid/timezone")).toBe("2026-09-16");
    const { course } = await academicFixture();
    await db().assignment.create({ data: {
      userId: owner.id,
      courseId: course.id,
      title: "Local-day deadline",
      dueDate: boundary,
      priority: "HIGH",
    } });
    const recommendation = (await evaluateRecommendations(owner.id, { now: NOW })).recommendations[0];
    expect(recommendation.reasonData.daysRemaining).toBe(0);
  });

  it("supports a protected manual development cycle", async () => {
    expect(() => assertManualBackgroundJobTriggerAllowed("development")).not.toThrow();
    expect(() => assertManualBackgroundJobTriggerAllowed("production")).toThrow();
    const send = vi.fn(async (_name, _data, options) => options?.id ?? randomUUID());
    const run = await enqueueScheduledRecommendationCycle({
      idempotencyKey: `manual:${randomUUID()}`,
      now: NOW,
      sourceEvent: "DEVELOPMENT_TRIGGER",
    }, { publisher: { send } as unknown as Pick<PgBoss, "send"> });
    expect(run).toMatchObject({ status: "PENDING", deduplicated: false });
    expect(send).toHaveBeenCalledWith(
      REFRESH_ACTIVE_USER_RECOMMENDATIONS_JOB,
      expect.objectContaining({ version: 1, scheduledFor: NOW.toISOString() }),
      expect.objectContaining({ group: { id: "recommendation-scheduler" } }),
    );
  });

  it("does not call an AI provider in the scheduler", async () => {
    const provider = vi.spyOn(ai, "getAIProvider");
    const job = createScheduledRecommendationRefreshJob({
      selectPage: async () => ({ users: [], nextCursor: null }),
    });
    await job.handler(context());
    expect(provider).not.toHaveBeenCalled();
  });

  it("records scheduler results separately from per-user JobRuns", async () => {
    const send = vi.fn(async (_name, _data, options) => options?.id ?? randomUUID());
    const run = await enqueueScheduledRecommendationCycle({
      idempotencyKey: `scheduler-audit:${randomUUID()}`,
      now: NOW,
    }, { publisher: { send } as unknown as Pick<PgBoss, "send"> });
    const queued = send.mock.calls[0];
    const job = createScheduledRecommendationRefreshJob({ selectPage: async () => ({ users: [], nextCursor: null }) });
    const result = await executeBackgroundJob(job, {
      id: queued[2].id!,
      name: queued[0],
      data: queued[1],
      retryCount: 0,
      retryLimit: 2,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(await db().jobRun.findUnique({ where: { id: run.id } })).toMatchObject({
      userId: null,
      status: "COMPLETED",
      metadata: expect.objectContaining({ scheduleRunId: run.id, activeUsersDiscovered: 0 }),
    });
  });
});
