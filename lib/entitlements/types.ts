import { z } from "zod";

export const CAPABILITIES = [
  "ai.chat", "ai.tutor", "ai.notes", "ai.quiz", "ai.study-planner", "ai.academic-manager", "ai.career",
  "workflow.exam-preparation", "workflow.weak-topic-recovery", "workflow.lecture-study", "workflow.assignment-support", "workflow.career-preparation",
  "academic.courses", "academic.documents", "academic.progress",
  "integration.calendar", "integration.drive", "integration.lms",
  "automation.recommendations", "automation.reminders", "automation.notifications",
  "personalization.memory", "personalization.adaptive",
] as const;
export const LIMITS = ["documents.max", "documents.maxFileBytes", "documents.monthlyProcessing", "courses.max", "ai.monthlyRequests", "ai.monthlyTokens", "workflow.monthlyRuns", "integrations.maxAccounts", "memory.maxActive"] as const;
export const TIERS = ["FAST", "BALANCED", "STRONG", "REASONING"] as const;
export type Capability = typeof CAPABILITIES[number];
export type LimitKey = typeof LIMITS[number];
export type ModelTier = typeof TIERS[number];
export type Entitlements = Record<Capability, boolean> & Record<LimitKey, number | null> & { "ai.modelTier.max": ModelTier };
export type EntitlementKey = keyof Entitlements;
const limit = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
export const entitlementSchema = z.object({
  ...Object.fromEntries(CAPABILITIES.map(key => [key, z.boolean()])) as Record<Capability, z.ZodBoolean>,
  ...Object.fromEntries(LIMITS.map(key => [key, limit])) as Record<LimitKey, typeof limit>,
  "ai.modelTier.max": z.enum(TIERS),
}).strict();
export function parseEntitlement<K extends EntitlementKey>(key: K, value: unknown): Entitlements[K] {
  const schema = entitlementSchema.shape[key];
  if (!schema) throw new Error("Unknown entitlement key");
  return schema.parse(value) as Entitlements[K];
}
export type PublicEntitlements = { plan: { code: string; name: string }; capabilities: Record<Capability, boolean>; limits: Record<LimitKey, number | null>; maxModelTier: ModelTier; period: { start: string; end: string }; usage: { aiRequests: number; workflowRuns: number; documentsProcessed: number }; plansUrl: "/plans" };
export const ENTITLEMENT_CODES = ["ENTITLEMENT_REQUIRED", "PLAN_USAGE_EXHAUSTED", "PLAN_MODEL_QUALITY_CONFLICT", "ENTITLEMENT_FEATURE_DISABLED"] as const;
