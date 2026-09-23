import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PgBoss, SendOptions } from "pg-boss";
import { AIError } from "@/server/ai/errors";
import * as ai from "@/server/ai";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import {
  enqueueDomainBackgroundEvent,
  enqueueRecommendationRefresh,
  getBackgroundJobMetrics,
  resetBackgroundJobMetricsForTests,
} from "@/server/jobs";
import { createBackgroundJobBoss, type BackgroundJobPublisher } from "@/server/jobs/client";
import { enqueueTrackedUserJob } from "@/server/jobs/enqueue";
import { executeBackgroundJob } from "@/server/jobs/executor";
import { createRefreshRecommendationsJob, refreshRecommendationJobPayload, refreshRecommendationsJob } from "@/server/jobs/refresh-recommendations";
import { startBackgroundJobWorker, stopBackgroundJobWorker } from "@/server/jobs/worker";
import { dismissRecommendation } from "@/server/recommendations";

type Actor = { id: string };
type PublisherCall = {
  name: string;
  data: object | null;
  options: SendOptions | null;
  seconds: number;
  key?: string;
};

const actors: Actor[] = [];
const workerSchema = `student_jobs_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let owner: Actor;
let foreign: Actor;
let worker: PgBoss;

async function actor(label: string): Promise<Actor> {
  const response = await auth().api.signUpEmail({
    body: {
      name: label,
      email: `background-${randomUUID()}@example.test`,
      password: "Background-job-test-passphrase-2026!",
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const result = { id: body.user.id };
  actors.push(result);
  await db().profile.create({ data: {
    userId: result.id,
    school: "Job Test University",
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

function publisher(responses: Array<"accept" | "dedupe"> = ["accept"]) {
  const calls: PublisherCall[] = [];
  const boundary: BackgroundJobPublisher = {
    async sendDebounced(name, data, options, seconds, key) {
      calls.push({ name, data, options: options ?? null, seconds, key });
      const response = responses.shift() ?? "accept";
      return response === "accept" ? options?.id ?? randomUUID() : null;
    },
  };
  return { boundary, calls };
}

function queued(
  call: PublisherCall,
  retryCount = 0,
  retryLimit = 3,
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    id: call.options?.id ?? randomUUID(),
    name: call.name,
    data: call.data,
    retryCount,
    retryLimit,
    signal,
  };
}

async function assignmentFixture(userId = owner.id) {
  const course = await db().course.create({ data: {
    userId,
    courseCode: `JOB ${randomUUID().slice(0, 5)}`,
    courseName: "Background Systems",
    semester: "Fall 2026",
  } });
  const assignment = await db().assignment.create({ data: {
    userId,
    courseId: course.id,
    title: "Queue safety assignment",
    dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    priority: "HIGH",
    estimatedHours: 2,
  } });
  return { course, assignment };
}

async function resetActor(userId: string) {
  await db().jobRun.deleteMany({ where: { userId } });
  await db().recommendation.deleteMany({ where: { userId } });
  await db().assignment.deleteMany({ where: { userId } });
  await db().exam.deleteMany({ where: { userId } });
  await db().course.deleteMany({ where: { userId } });
}

async function waitForCompleted(runId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const run = await db().jobRun.findUnique({ where: { id: runId } });
    if (run?.status === "COMPLETED") return run;
    if (run?.status === "FAILED") throw new Error(`Job failed: ${run.errorCode}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the background worker.");
}

beforeAll(async () => {
  owner = await actor("Background Owner");
  foreign = await actor("Background Foreign");
  worker = await startBackgroundJobWorker(
    createBackgroundJobBoss("worker", { schema: workerSchema }),
  );
});

beforeEach(async () => {
  vi.restoreAllMocks();
  resetBackgroundJobMetricsForTests();
  await resetActor(owner.id);
  await resetActor(foreign.id);
});

afterAll(async () => {
  await stopBackgroundJobWorker(worker);
  for (const item of actors)
    await db().user.deleteMany({ where: { id: item.id } });
  await db().$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${workerSchema}" CASCADE`);
  await db().$disconnect();
});

describe.sequential("Background Job Infrastructure", () => {
  it("validates the versioned recommendation payload", () => {
    expect(refreshRecommendationJobPayload.parse({
      version: 1,
      trackingId: "run-1",
      userId: "user-1",
    })).toMatchObject({ version: 1, userId: "user-1" });
    expect(() => refreshRecommendationJobPayload.parse({
      version: 2,
      trackingId: "run-1",
      userId: "user-1",
    })).toThrow();
  });

  it("creates a safe pending JobRun without copying the queue payload", async () => {
    const fake = publisher();
    const run = await enqueueRecommendationRefresh(owner.id, {
      idempotencyKey: `create:${randomUUID()}`,
      resourceId: "resource-1",
      sourceEvent: "QUIZ_COMPLETED",
    }, { publisher: fake.boundary });
    const stored = await db().jobRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored).toMatchObject({
      userId: owner.id,
      resourceId: "resource-1",
      status: "PENDING",
      attempt: 0,
      metadata: { sourceEvent: "QUIZ_COMPLETED" },
    });
    expect(JSON.stringify(stored)).not.toContain("trackingId");
  });

  it("enqueues and executes a real pg-boss job", async () => {
    await assignmentFixture();
    const run = await enqueueRecommendationRefresh(owner.id, {
      idempotencyKey: `real:${randomUUID()}`,
    }, { publisher: worker });
    expect(run.deduplicated).toBe(false);
    expect(await waitForCompleted(run.id)).toMatchObject({ attempt: 1, errorCode: null });
    expect(await db().recommendation.count({ where: { userId: owner.id, status: "ACTIVE" } })).toBe(1);
  });

  it("refreshes recommendations successfully through the shared executor", async () => {
    await assignmentFixture();
    const fake = publisher();
    const run = await enqueueRecommendationRefresh(owner.id, {
      idempotencyKey: `success:${randomUUID()}`,
    }, { publisher: fake.boundary });
    const result = await executeBackgroundJob(refreshRecommendationsJob, queued(fake.calls[0]));
    expect(result.status).toBe("completed");
    expect(await db().jobRun.findUnique({ where: { id: run.id } })).toMatchObject({
      status: "COMPLETED",
      attempt: 1,
      errorCode: null,
    });
  });

  it("deduplicates identical explicit refresh requests", async () => {
    const fake = publisher();
    const key = `same:${randomUUID()}`;
    const first = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: key }, { publisher: fake.boundary });
    const second = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: key }, { publisher: fake.boundary });
    expect(second).toMatchObject({ id: first.id, queueJobId: first.queueJobId, deduplicated: true });
    expect(fake.calls).toHaveLength(1);
  });

  it("rolls back JobRun creation when queue publication fails", async () => {
    const idempotencyKey = `publish-failure:${randomUUID()}`;
    const failingPublisher: BackgroundJobPublisher = {
      async sendDebounced() {
        const error = new Error("Database unavailable") as Error & { code: string };
        error.code = "P1001";
        throw error;
      },
    };
    await expect(enqueueRecommendationRefresh(owner.id, {
      idempotencyKey,
    }, { publisher: failingPublisher })).rejects.toMatchObject({ code: "DATABASE_ERROR" });
    expect(await db().jobRun.findUnique({ where: { idempotencyKey } })).toBeNull();
  });

  it("keeps recommendation refresh idempotent after repeated execution", async () => {
    await assignmentFixture();
    const fake = publisher(["accept", "accept"]);
    await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `first:${randomUUID()}` }, { publisher: fake.boundary });
    await executeBackgroundJob(refreshRecommendationsJob, queued(fake.calls[0]));
    await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `second:${randomUUID()}` }, { publisher: fake.boundary });
    await executeBackgroundJob(refreshRecommendationsJob, queued(fake.calls[1]));
    expect(await db().recommendation.count({ where: { userId: owner.id, status: "ACTIVE" } })).toBe(1);
  });

  it("expires stale recommendations when their source state changes", async () => {
    const { assignment } = await assignmentFixture();
    const fake = publisher(["accept", "accept"]);
    await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `stale-1:${randomUUID()}` }, { publisher: fake.boundary });
    await executeBackgroundJob(refreshRecommendationsJob, queued(fake.calls[0]));
    await db().assignment.update({ where: { id: assignment.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `stale-2:${randomUUID()}` }, { publisher: fake.boundary });
    await executeBackgroundJob(refreshRecommendationsJob, queued(fake.calls[1]));
    expect(await db().recommendation.count({ where: { userId: owner.id, status: "ACTIVE" } })).toBe(0);
    expect(await db().recommendation.count({ where: { userId: owner.id, status: "EXPIRED" } })).toBe(1);
  });

  it("preserves dismissal suppression during a background refresh", async () => {
    await assignmentFixture();
    const fake = publisher(["accept", "accept"]);
    await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `dismiss-1:${randomUUID()}` }, { publisher: fake.boundary });
    await executeBackgroundJob(refreshRecommendationsJob, queued(fake.calls[0]));
    const active = await db().recommendation.findFirstOrThrow({ where: { userId: owner.id, status: "ACTIVE" } });
    await dismissRecommendation(owner.id, active.id);
    await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `dismiss-2:${randomUUID()}` }, { publisher: fake.boundary });
    await executeBackgroundJob(refreshRecommendationsJob, queued(fake.calls[1]));
    expect(await db().recommendation.count({ where: { userId: owner.id, status: "ACTIVE" } })).toBe(0);
    expect(await db().recommendation.findUnique({ where: { id: active.id } })).toMatchObject({ status: "DISMISSED" });
  });

  it("schedules a bounded retry for transient provider failures", async () => {
    const fake = publisher();
    const run = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `retry:${randomUUID()}` }, { publisher: fake.boundary });
    const failing = createRefreshRecommendationsJob(async () => {
      throw new AIError("PROVIDER_FAILURE");
    });
    const result = await executeBackgroundJob(failing, queued(fake.calls[0], 0, 3));
    expect(result).toMatchObject({ status: "failed", output: { errorCode: "TRANSIENT_PROVIDER_ERROR", retryable: true } });
    expect(await db().jobRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: "PENDING", attempt: 1 });
    expect(getBackgroundJobMetrics()).toMatchObject({ failed: 1, retries: 1 });
  });

  it("marks a transient failure terminal after retry exhaustion", async () => {
    const fake = publisher();
    const run = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `exhaust:${randomUUID()}` }, { publisher: fake.boundary });
    const failing = createRefreshRecommendationsJob(async () => {
      throw new AIError("RATE_LIMIT");
    });
    const result = await executeBackgroundJob(failing, queued(fake.calls[0], 3, 3));
    expect(result.status).toBe("deadletter");
    expect(await db().jobRun.findUnique({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      attempt: 4,
      errorCode: "TRANSIENT_PROVIDER_ERROR",
    });
  });

  it("dead-letters malformed payloads without retrying", async () => {
    const fake = publisher();
    const run = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `invalid:${randomUUID()}` }, { publisher: fake.boundary });
    const invalidCall = { ...fake.calls[0], data: { trackingId: run.id, userId: owner.id, version: 99 } };
    const result = await executeBackgroundJob(refreshRecommendationsJob, queued(invalidCall));
    expect(result).toMatchObject({ status: "deadletter", output: { errorCode: "INVALID_PAYLOAD", retryable: false } });
  });

  it("records a bounded timeout as retryable", async () => {
    const fake = publisher();
    const run = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `timeout:${randomUUID()}` }, { publisher: fake.boundary });
    const controller = new AbortController();
    controller.abort();
    const result = await executeBackgroundJob(
      refreshRecommendationsJob,
      queued(fake.calls[0], 3, 3, controller.signal),
    );
    expect(result).toMatchObject({ status: "deadletter", output: { errorCode: "TIMEOUT" } });
    expect(await db().jobRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: "FAILED", errorCode: "TIMEOUT" });
  });

  it("uses a global per-user concurrency group without serializing other users", async () => {
    const ownerPublisher = publisher();
    const foreignPublisher = publisher();
    await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `group-owner:${randomUUID()}` }, { publisher: ownerPublisher.boundary });
    await enqueueRecommendationRefresh(foreign.id, { idempotencyKey: `group-foreign:${randomUUID()}` }, { publisher: foreignPublisher.boundary });
    expect(ownerPublisher.calls[0].options?.group).toEqual({ id: owner.id });
    expect(foreignPublisher.calls[0].options?.group).toEqual({ id: foreign.id });
    expect(refreshRecommendationsJob.concurrency).toEqual({ scope: "user", limit: 1 });
  });

  it("rejects a cross-user payload and does not read the foreign state", async () => {
    await assignmentFixture(foreign.id);
    const fake = publisher();
    const run = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `ownership:${randomUUID()}` }, { publisher: fake.boundary });
    const tampered = { ...fake.calls[0], data: { version: 1, trackingId: run.id, userId: foreign.id } };
    const result = await executeBackgroundJob(refreshRecommendationsJob, queued(tampered));
    expect(result).toMatchObject({ status: "deadletter", output: { errorCode: "AUTHORIZATION_ERROR" } });
    expect(await db().recommendation.count({ where: { userId: foreign.id } })).toBe(0);
    expect(await db().jobRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: "PENDING", attempt: 0 });
  });

  it("claims a duplicate delivery only once and never replays completed work", async () => {
    const fake = publisher(), ref = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: randomUUID() }, { publisher: fake.boundary });
    let enter!: () => void, release!: () => void;
    const hit = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    const handler = vi.fn(async () => { enter(); await gate; return { done: true }; });
    const definition = { ...refreshRecommendationsJob, handler };
    const first = executeBackgroundJob(definition, queued(fake.calls[0]));
    await hit;
    expect(await executeBackgroundJob(definition, queued(fake.calls[0]))).toMatchObject({ output: { skipped: true } });
    expect(await db().jobRun.findUnique({ where: { id: ref.id } })).toMatchObject({ status: "RUNNING", attempt: 1 });
    release(); await first;
    await executeBackgroundJob(definition, queued(fake.calls[0]));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("recovers an expired delivery and fences stale completion/failure (failure=%s)", async failure => {
    const fake = publisher(), ref = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: randomUUID() }, { publisher: fake.boundary });
    let enter!: () => void, release!: () => void;
    const hit = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    const stale = executeBackgroundJob({ ...refreshRecommendationsJob, handler: async () => { enter(); await gate; if (failure) throw new AIError("PROVIDER_FAILURE"); return { marker: "stale" }; } }, queued(fake.calls[0]));
    await hit;
    await db().jobRun.update({ where: { id: ref.id }, data: { startedAt: new Date(Date.now() - 31000) } });
    const retry = await executeBackgroundJob({ ...refreshRecommendationsJob, handler: async () => ({ marker: "current" }) }, queued(fake.calls[0], 1));
    expect(retry).toMatchObject({ status: "completed", output: { marker: "current" } });
    release(); await stale;
    expect(await db().jobRun.findUnique({ where: { id: ref.id } })).toMatchObject({ status: "COMPLETED", attempt: 2, metadata: { marker: "current" } });
  });

  it("preserves cancellation against in-flight completion and later replay", async () => {
    const fake = publisher(), ref = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: randomUUID() }, { publisher: fake.boundary });
    let enter!: () => void, release!: () => void;
    const hit = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    const handler = vi.fn(async () => { enter(); await gate; return { done: true }; });
    const definition = { ...refreshRecommendationsJob, handler };
    const running = executeBackgroundJob(definition, queued(fake.calls[0]));
    await hit;
    await db().jobRun.update({ where: { id: ref.id }, data: { status: "CANCELLED" } });
    release(); await running; await executeBackgroundJob(definition, queued(fake.calls[0], 1));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await db().jobRun.findUnique({ where: { id: ref.id } })).toMatchObject({ status: "CANCELLED" });
  });

  it("scopes idempotency to owner, job, version and resource and returns only safe references", async () => {
    const fake = publisher(), key = randomUUID();
    const ref = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: key }, { publisher: fake.boundary });
    expect(Object.keys(ref).sort()).toEqual(["deduplicated", "id", "queueJobId", "status"]);
    await expect(enqueueRecommendationRefresh(foreign.id, { idempotencyKey: key }, { publisher: fake.boundary })).rejects.toMatchObject({ code: "AUTHORIZATION_ERROR" });
    for (const definition of [{ ...refreshRecommendationsJob, name: "different" }, { ...refreshRecommendationsJob, version: 2 }])
      await expect(enqueueTrackedUserJob(definition, owner.id, { idempotencyKey: key }, { publisher: fake.boundary })).rejects.toMatchObject({ code: "AUTHORIZATION_ERROR" });
    await expect(enqueueRecommendationRefresh(owner.id, { idempotencyKey: key, resourceId: "other" }, { publisher: fake.boundary })).rejects.toMatchObject({ code: "AUTHORIZATION_ERROR" });
    expect(fake.calls).toHaveLength(1);
  });

  it("cross-user concurrent idempotency collisions cannot reveal the winning reference", async () => {
    const fake = publisher(), key = randomUUID();
    const outcomes = await Promise.allSettled([owner, foreign].map(user => enqueueRecommendationRefresh(user.id, { idempotencyKey: key }, { publisher: fake.boundary })));
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(x => x.status === "rejected")).toMatchObject({ reason: { code: "AUTHORIZATION_ERROR" } });
  });

  it("does not enqueue or return a duplicate job for an account being deleted", async () => {
    const fake = publisher(), key = randomUUID();
    await enqueueRecommendationRefresh(owner.id, { idempotencyKey: key }, { publisher: fake.boundary });
    await db().user.update({ where: { id: owner.id }, data: { deletionRequestedAt: new Date() } });
    try {
      await expect(enqueueRecommendationRefresh(owner.id, { idempotencyKey: key }, { publisher: fake.boundary })).rejects.toMatchObject({ code: "AUTHORIZATION_ERROR" });
      await expect(enqueueRecommendationRefresh(owner.id, { idempotencyKey: randomUUID() }, { publisher: fake.boundary })).rejects.toMatchObject({ code: "AUTHORIZATION_ERROR" });
    } finally { await db().user.update({ where: { id: owner.id }, data: { deletionRequestedAt: null } }); }
    expect(fake.calls).toHaveLength(1);
  });

  it("creates one system tracking row under simultaneous schedule delivery", async () => {
    let enter!: () => void, release!: () => void;
    const hit = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    const handler = vi.fn(async () => { enter(); await gate; return { done: true }; });
    const definition = { ...refreshRecommendationsJob, name: "test-system-security", executionScope: "system" as const, payloadSchema: refreshRecommendationJobPayload.pick({ version: true }), handler };
    const job = { id: randomUUID(), name: definition.name, data: { version: 1 }, retryCount: 0, retryLimit: 3, signal: new AbortController().signal };
    const deliveries = [executeBackgroundJob(definition, job), executeBackgroundJob(definition, job)];
    await hit; release(); await Promise.all(deliveries);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await db().jobRun.count({ where: { queueJobId: job.id } })).toBe(1);
    await db().jobRun.deleteMany({ where: { queueJobId: job.id } });
  });

  it("enqueues supported domain events with exact event deduplication", async () => {
    const fake = publisher();
    const event = {
      eventId: randomUUID(),
      name: "QUIZ_COMPLETED" as const,
      userId: owner.id,
      resourceId: "quiz-attempt-1",
    };
    const first = await enqueueDomainBackgroundEvent(event, { publisher: fake.boundary });
    const second = await enqueueDomainBackgroundEvent(event, { publisher: fake.boundary });
    expect(second).toMatchObject({ id: first.id, deduplicated: true });
    expect(second.reminder).toMatchObject({ id: first.reminder.id, deduplicated: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("coalesces rapid related events into the existing pending user refresh", async () => {
    const fake = publisher(["accept", "accept", "dedupe", "dedupe"]);
    const first = await enqueueDomainBackgroundEvent({
      eventId: randomUUID(),
      name: "LEARNING_PROGRESS_UPDATED",
      userId: owner.id,
      resourceId: "topic-1",
    }, { publisher: fake.boundary });
    const second = await enqueueDomainBackgroundEvent({
      eventId: randomUUID(),
      name: "QUIZ_COMPLETED",
      userId: owner.id,
      resourceId: "attempt-1",
    }, { publisher: fake.boundary });
    expect(second).toMatchObject({ id: first.id, deduplicated: true });
    expect(second.reminder).toMatchObject({ id: first.reminder.id, deduplicated: true });
    expect(await db().jobRun.count({ where: { userId: owner.id } })).toBe(2);
    expect(fake.calls.map((call) => call.key).sort()).toEqual([
      `event-recommendation:${owner.id}`,
      `event-recommendation:${owner.id}`,
      `event-reminder:${owner.id}`,
      `event-reminder:${owner.id}`,
    ]);
  });

  it("emits structured safe logging metadata", async () => {
    await assignmentFixture();
    const fake = publisher();
    const run = await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `logging:${randomUUID()}` }, { publisher: fake.boundary });
    const logger = { info: vi.fn(), error: vi.fn() };
    await executeBackgroundJob(refreshRecommendationsJob, queued(fake.calls[0]), { logger });
    const entries = logger.info.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>);
    expect(entries).toContainEqual(expect.objectContaining({
      scope: "background-job",
      event: "started",
      jobName: refreshRecommendationsJob.name,
      jobRunId: run.id,
      userId: owner.id,
      attempt: 1,
    }));
    expect(JSON.stringify(entries)).not.toContain("Queue safety assignment");
  });

  it("makes no AI call during deterministic recommendation refresh", async () => {
    const provider = vi.spyOn(ai, "getAIProvider");
    await assignmentFixture();
    const fake = publisher();
    await enqueueRecommendationRefresh(owner.id, { idempotencyKey: `no-ai:${randomUUID()}` }, { publisher: fake.boundary });
    await executeBackgroundJob(refreshRecommendationsJob, queued(fake.calls[0]));
    expect(provider).not.toHaveBeenCalled();
  });
});
