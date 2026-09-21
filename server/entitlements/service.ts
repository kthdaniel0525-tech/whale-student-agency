import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { CAPABILITIES, LIMITS, TIERS, entitlementSchema, parseEntitlement, type Capability, type EntitlementKey, type Entitlements, type LimitKey, type ModelTier } from "@/lib/entitlements/types";
import { db } from "../db/client";
import { basePlanCode, DEVELOPMENT_PLANS, featureFlags, type PlanDefinition } from "./config";
import { EntitlementError } from "./errors";
export type EntitlementClient = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const statuses = z.enum(["active", "trialing", "past-due", "cancelled", "expired"]);
const planSchema = z.object({ code: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), name: z.string().min(1).max(80), description: z.string().max(400), version: z.number().int().positive(), active: z.boolean(), internal: z.boolean(), entitlements: entitlementSchema }).strict();

/** Internal catalog mutation: never mounted as a frontend endpoint. */
export async function savePlan(input: PlanDefinition) {
  const value = planSchema.parse(input);
  return db().plan.upsert({ where: { code: value.code }, create: { ...value, entitlements: json(value.entitlements) }, update: { ...value, entitlements: json(value.entitlements) } });
}
/** Explicit catalog sync; does not silently overwrite server-managed plans on reads. */
export async function syncDevelopmentPlans() {
  for (const definition of DEVELOPMENT_PLANS) await savePlan(definition);
}
async function planByCode(code: string, tx: EntitlementClient) {
  const existing = await tx.plan.findUnique({ where: { code } });
  if (existing) return existing;
  const definition = DEVELOPMENT_PLANS.find(p => p.code === code);
  if (!definition) throw new Error("Unknown plan configuration");
  return tx.plan.upsert({ where: { code }, create: { ...definition, entitlements: json(definition.entitlements) }, update: {} });
}
export async function ensureDefaultSubscription(userId: string, tx: EntitlementClient = db()) {
  const existing = await tx.userSubscription.findUnique({ where: { userId }, include: { plan: true } });
  if (existing) return existing;
  if (!await tx.user.findUnique({ where: { id: userId }, select: { id: true } })) throw new EntitlementError("ENTITLEMENT_REQUIRED");
  const plan = await planByCode(basePlanCode(), tx);
  if (!plan.active || plan.internal) throw new Error("Default plan must be public and active");
  return tx.userSubscription.upsert({ where: { userId }, create: { userId, planId: plan.id }, update: {}, include: { plan: true } });
}
export async function lockEntitlementUser(tx: EntitlementClient, userId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
  if (!rows.length) throw new EntitlementError("ENTITLEMENT_REQUIRED");
}
export function usagePeriod(subscription: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null }, now: Date) {
  const { currentPeriodStart: start, currentPeriodEnd: end } = subscription;
  if (start && end && start <= now && now < end && start < end) return { start, end };
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}
export function subscriptionIsEffective(subscription: { status: string; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; trialEndsAt: Date | null; graceUntil: Date | null }, now: Date) {
  if (subscription.status === "trialing") return !!subscription.trialEndsAt && subscription.trialEndsAt > now;
  if (subscription.status === "past-due") return !!subscription.graceUntil && subscription.graceUntil > now;
  if (subscription.status !== "active") return false;
  return !subscription.currentPeriodEnd || subscription.currentPeriodEnd > now;
}
/** No cross-request cache: plan/override edits and emergency flags apply on the
 * next boundary, including a queued job or the next step of an active workflow. */
export async function getUserEntitlements(userId: string, tx: EntitlementClient = db(), now = new Date()) {
  const subscription = await ensureDefaultSubscription(userId, tx);
  const effective = subscription.plan.active && subscriptionIsEffective(subscription, now);
  const plan = effective ? subscription.plan : await planByCode(basePlanCode(), tx);
  if (!effective && (!plan.active || plan.internal)) throw new Error("Base plan must be public and active");
  const values = entitlementSchema.parse(plan.entitlements);
  const overrides = await tx.userEntitlementOverride.findMany({ where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
  for (const override of overrides) {
    const key = override.entitlementKey as EntitlementKey;
    const value = parseEntitlement(key, override.value);
    Object.assign(values, { [key]: value });
  }
  const flags = featureFlags();
  for (const key of CAPABILITIES) if (flags[key] === false) values[key] = false;
  // An expired subscription never creates a fresh bespoke usage window.
  return { userId, plan, subscription, values, flags, period: usagePeriod(effective ? subscription : { currentPeriodStart: null, currentPeriodEnd: null }, now) };
}
export type EffectiveEntitlements = Awaited<ReturnType<typeof getUserEntitlements>>;
export function assertEffectiveAccess(effective: EffectiveEntitlements, key: Capability) {
  if (!effective.values[key]) throw new EntitlementError(effective.flags[key] === false ? "ENTITLEMENT_FEATURE_DISABLED" : "ENTITLEMENT_REQUIRED", key);
}
export function assertWithinLimit(values: Entitlements, key: LimitKey, current: number, additional = 1) {
  const maximum = values[key];
  if (maximum !== null && current + additional > maximum) throw new EntitlementError("PLAN_USAGE_EXHAUSTED", key);
}
export async function hasEntitlement(userId: string, key: Capability, tx: EntitlementClient = db()) { return (await getUserEntitlements(userId, tx)).values[key]; }
export async function assertEntitlement(userId: string, key: Capability, tx: EntitlementClient = db()) { assertEffectiveAccess(await getUserEntitlements(userId, tx), key); }
export async function getEntitlementLimit(userId: string, key: LimitKey) { return (await getUserEntitlements(userId)).values[key]; }
export function assertModelTier(values: Entitlements, tier: ModelTier) {
  if (TIERS.indexOf(tier) > TIERS.indexOf(values["ai.modelTier.max"])) throw new EntitlementError("PLAN_MODEL_QUALITY_CONFLICT", "ai.modelTier.max");
}
const subscriptionUpdate = z.object({ status: statuses.default("active"), currentPeriodStart: z.date().nullable().default(null), currentPeriodEnd: z.date().nullable().default(null), cancelAtPeriodEnd: z.boolean().default(false), trialEndsAt: z.date().nullable().default(null), graceUntil: z.date().nullable().default(null) }).strict().superRefine((v, ctx) => {
  if (!!v.currentPeriodStart !== !!v.currentPeriodEnd || v.currentPeriodStart && v.currentPeriodEnd && v.currentPeriodStart >= v.currentPeriodEnd || v.status === "trialing" && !v.trialEndsAt) ctx.addIssue({ code: "custom", message: "Invalid subscription dates" });
});
/** Trusted internal operations only. No request body can call these methods. */
export async function setUserPlan(userId: string, planCode: string, options: z.input<typeof subscriptionUpdate> = {}) {
  const state = subscriptionUpdate.parse(options);
  return db().$transaction(async tx => {
    await lockEntitlementUser(tx, userId);
    const plan = await planByCode(planCode, tx);
    if (!plan.active) throw new Error("Inactive plan");
    const before = await tx.userSubscription.findUnique({ where: { userId }, select: { planId: true } });
    const result = await tx.userSubscription.upsert({ where: { userId }, create: { userId, planId: plan.id, ...state }, update: { planId: plan.id, startedAt: new Date(), ...state } });
    await tx.entitlementEvent.create({ data: { userId, type: state.status === "trialing" ? "trial-started" : "plan-changed", details: { previousPlanId: before?.planId ?? null, planId: plan.id, status: state.status } } });
    return result;
  });
}
export async function setEntitlementOverride<K extends EntitlementKey>(userId: string, key: K, value: Entitlements[K], options: { expiresAt?: Date; reason?: string } = {}) {
  const parsed = parseEntitlement(key, value);
  const metadata = z.object({ expiresAt: z.date().optional(), reason: z.string().max(300).optional() }).strict().parse(options);
  return db().$transaction(async tx => {
    await lockEntitlementUser(tx, userId);
    const result = await tx.userEntitlementOverride.upsert({ where: { userId_entitlementKey: { userId, entitlementKey: key } }, create: { userId, entitlementKey: key, value: parsed === null ? Prisma.JsonNull : json(parsed), ...metadata }, update: { value: parsed === null ? Prisma.JsonNull : json(parsed), expiresAt: metadata.expiresAt ?? null, reason: metadata.reason ?? null } });
    await tx.entitlementEvent.create({ data: { userId, type: "override-set", details: { key, expiresAt: metadata.expiresAt?.toISOString() ?? null } } });
    return result;
  });
}
export async function removeEntitlementOverride(userId: string, key: EntitlementKey) {
  await db().$transaction(async tx => {
    await lockEntitlementUser(tx, userId);
    await tx.userEntitlementOverride.deleteMany({ where: { userId, entitlementKey: key } });
    await tx.entitlementEvent.create({ data: { userId, type: "override-removed", details: { key } } });
  });
}
export async function publicPlanCatalog() {
  for (const p of DEVELOPMENT_PLANS) await planByCode(p.code, db());
  const rows = await db().plan.findMany({ where: { active: true, internal: false }, orderBy: { createdAt: "asc" } });
  const groups = { "AI Tutor": "ai.tutor", "Study workflows": "workflow.exam-preparation", "Calendar integration": "integration.calendar", "Drive import": "integration.drive", "Long-term personalization": "personalization.memory", "Career tools": "ai.career" } as const;
  return rows.map(plan => {
    const values = entitlementSchema.parse(plan.entitlements);
    return { code: plan.code, name: plan.name, description: plan.description, features: Object.entries(groups).map(([name, key]) => ({ name, included: values[key] })), limits: LIMITS.filter(key => !key.includes("Tokens") && !key.includes("Bytes")).map(key => ({ key, value: values[key] })) };
  });
}
