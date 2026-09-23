import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { db } from "../db/client";
import { analyticsConfig } from "./config";
import { betaConfig } from "../beta/config";
import { parseEvent, type ProductEventName } from "@/lib/product-analytics/events";
import type { Prisma } from "@/generated/prisma/client";

type SafeEvent = ReturnType<typeof parseEvent> & { id: string; anonymousId: string; environment: string; cohort?: string; createdAt: string };
export interface ProductAnalytics {
  track(event: SafeEvent): Promise<void>;
  identify(anonymousId: string, traits: { environment: string; cohort?: string }): Promise<void>;
}
/** First adapter stays in our database. No vendor SDK or outbound network call. */
export class DatabaseAnalytics implements ProductAnalytics {
  constructor(private readonly userId: string) {}
  async identify() { /* Mapping is private ProductAnalyticsState, not a second profile. */ }
  async track(event: SafeEvent) {
    await db().$transaction(async tx => {
      // Serialize with privacy preference writes across ALL web/worker processes.
      const enabled = await tx.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "ProductAnalyticsState" WHERE "userId"=${this.userId} AND NOT "optedOut" FOR UPDATE`;
      if (!enabled.length) return;
      await tx.productEvent.createMany({ data: [{ userId: this.userId, name: event.name, environment: event.environment,
        cohort: event.cohort, dedupeKey: event.id, createdAt: new Date(event.createdAt), properties: event.properties as Prisma.InputJsonValue }], skipDuplicates: true });
    }, { timeout: 2000, maxWait: 1000 });
  }
}
export class ConsoleAnalytics implements ProductAnalytics {
  async identify(anonymousId: string, traits: { environment: string; cohort?: string }) { console.info("product_identity", { anonymousId, ...traits }); }
  async track(event: SafeEvent) { console.info("product_event", event); }
}

const pending = new Set<Promise<void>>();
const backlog: (() => Promise<void>)[] = [];
let dropped = 0;
function drain() {
  while (pending.size < 4 && backlog.length) {
    const job = backlog.shift()!;
    const promise = Promise.resolve().then(job).catch(() => { dropped++; }).finally(() => { pending.delete(promise); drain(); });
    pending.add(promise);
  }
}
export async function flushProductAnalytics() { while (pending.size || backlog.length) { drain(); await Promise.all([...pending]); } }
export function deliveryHealth() { return { queued: backlog.length, inFlight: pending.size, dropped }; }
export function recommendationProperties(userId: string, recommendationId: string) {
  return { recommendationKey: createHash("sha256").update(JSON.stringify([userId, recommendationId])).digest("hex") };
}

/** Validation is synchronous, delivery is bounded and best effort. Call AFTER
 * the domain write commits. Analytics never participates in its transaction. */
export function trackProductEvent(userId: string, event: ProductEventName, properties: unknown = {}, key: string = randomUUID()): void {
  try {
    const config = analyticsConfig();
    if (!config.enabled) return;
    const safe = parseEvent(event, properties);
    if (backlog.length >= 500) { dropped++; return; }
    const createdAt = new Date().toISOString();
    backlog.push(async () => {
      const user = await db().user.findUnique({ where: { id: userId }, select: { deletionRequestedAt: true, betaAccess: true, analyticsState: true } });
      const beta = betaConfig();
      if (!user || user.deletionRequestedAt || user.betaAccess?.internal || beta.internal.includes(userId) || beta.admins.includes(userId) || user.analyticsState?.optedOut) return;
      // In beta mode only approved participants contribute. Revoked traffic is excluded.
      if (beta.enabled && user.betaAccess?.status !== "active") return;
      if (!user.analyticsState) await db().productAnalyticsState.createMany({ data: [{ userId }], skipDuplicates: true });
      const state = user.analyticsState ?? await db().productAnalyticsState.findUniqueOrThrow({ where: { userId } });
      if (state.optedOut) return;
      const cohort = user.betaAccess?.cohort;
      const adapter: ProductAnalytics = config.provider === "console" ? new ConsoleAnalytics() : new DatabaseAnalytics(userId);
      await adapter.identify(state.anonymousId, { environment: config.environment, ...(cohort ? { cohort } : {}) });
      await adapter.track({ ...safe, id: createHash("sha256").update(JSON.stringify([config.environment, userId, safe.name, key])).digest("hex"),
        anonymousId: state.anonymousId, environment: config.environment, ...(cohort ? { cohort } : {}), createdAt });
    });
    drain();
  } catch { dropped++; }
}

export async function setAnalyticsPreference(userId: string, optedOut: boolean) {
  await db().$transaction(async tx => {
    await tx.productAnalyticsState.upsert({ where: { userId }, create: { userId, optedOut }, update: { optedOut } });
    if (optedOut) await tx.productEvent.deleteMany({ where: { userId } });
  });
}

export async function pruneProductAnalytics() {
  return db().$executeRaw`DELETE FROM "ProductEvent" WHERE id IN (SELECT id FROM "ProductEvent" WHERE "createdAt" < ${new Date(Date.now() - analyticsConfig().retentionDays * 86400000)} LIMIT 5000)`;
}
