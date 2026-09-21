import "server-only";
import { createHash } from "node:crypto";
import { db } from "../../db/client";
import type { Prisma } from "@/generated/prisma/client";
export const guardKey = (...parts: (string | null | undefined)[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export type GuardState = { data: Record<string, unknown>; expiresAt: number };
export type GuardTransaction = { get(key: string): GuardState | undefined; set(key: string, state: GuardState): void };
export interface GuardStore { transaction<T>(keys: string[], run: (tx: GuardTransaction, now: number) => T): Promise<T> }

/** Shared PostgreSQL counters, token buckets and leases. Short transactions lock
 * hashed keys in deterministic order; no provider call runs while holding a lock. */
export const postgresGuardStore: GuardStore = {
  async transaction(keys, run) {
    return db().$transaction(async tx => {
      // PostgreSQL returns void for advisory locks; cast for Prisma's typed decoder.
      for (const key of [...new Set(keys)].sort()) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const rows = await tx.aIGuardState.findMany({ where: { key: { in: keys } } });
      const states = new Map(rows.filter(r => r.expiresAt > now).map(r => [r.key, { data: r.data as Record<string, unknown>, expiresAt: r.expiresAt.getTime() }]));
      const writes = new Map<string, GuardState>();
      const result = run({ get: key => states.get(key), set: (key, value) => {
        if (!keys.includes(key)) throw new Error("UNLOCKED_GUARD_KEY");
        states.set(key, value); writes.set(key, value);
      } }, now.getTime());
      for (const [key, value] of writes) {
        const data = { data: value.data as Prisma.InputJsonObject, expiresAt: new Date(value.expiresAt) };
        await tx.aIGuardState.upsert({ where: { key }, create: { key, ...data }, update: data });
      }
      return result;
    }, { timeout: 4000, maxWait: 2000 });
  },
};
/** Deterministic test store only. Production always uses shared PostgreSQL state. */
export function createMemoryGuardStore(clock = Date.now): GuardStore {
  const states = new Map<string, GuardState>();
  let tail: Promise<unknown> = Promise.resolve();
  return { transaction(keys, run) {
    const result = tail.then(() => {
      const copy = new Map([...states].filter(([, s]) => s.expiresAt > clock()).map(([k, v]) => [k, structuredClone(v)]));
      const value = run({ get: k => copy.get(k), set: (k, s) => { if (!keys.includes(k)) throw new Error("UNLOCKED_GUARD_KEY"); copy.set(k, s); } }, clock());
      states.clear(); for (const [k, v] of copy) states.set(k, v);
      return value;
    });
    tail = result.catch(() => {}); return result;
  } };
}
