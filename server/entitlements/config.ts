import "server-only";
import { z } from "zod";
import { CAPABILITIES, LIMITS, entitlementSchema, type Capability, type Entitlements } from "@/lib/entitlements/types";
export type PlanDefinition = { code: string; name: string; description: string; version: number; active: boolean; internal: boolean; entitlements: Entitlements };
const capabilities = Object.fromEntries(CAPABILITIES.map(key => [key, true]));
const limits = { "documents.max": 100, "documents.maxFileBytes": 10 * 1024 * 1024, "documents.monthlyProcessing": 500, "courses.max": 50, "ai.monthlyRequests": 2000, "ai.monthlyTokens": 10_000_000, "workflow.monthlyRuns": 200, "integrations.maxAccounts": 10, "memory.maxActive": 100 };
// Beta/development defaults, not a price list. Keep all existing capabilities and
// quality tiers available; commercial limits can evolve here or in the catalog.
export const DEVELOPMENT_PLANS: PlanDefinition[] = [
  { code: "free", name: "Free", multiplier: 1 },
  { code: "student", name: "Student", multiplier: 2 },
  { code: "pro", name: "Pro", multiplier: 5 },
  { code: "internal-unlimited", name: "Internal", multiplier: null },
].map(({ code, name, multiplier }) => ({ code, name, description: code === "internal-unlimited" ? "Internal testing only" : "Beta access to student tools. Allowances may evolve.", version: 1, active: true, internal: multiplier === null,
  entitlements: entitlementSchema.parse({ ...capabilities, ...Object.fromEntries(LIMITS.map(key => [key, multiplier === null ? null : limits[key] * (["documents.max", "documents.maxFileBytes", "memory.maxActive"].includes(key) ? 1 : multiplier)])), "ai.modelTier.max": "REASONING" }),
}));
export function basePlanCode() { return process.env.DEFAULT_PLAN_CODE?.trim() || "free"; }
// Rollout/emergency switches are separate from subscription data and only veto.
export function featureFlags(): Partial<Record<Capability, boolean>> {
  const raw = process.env.ENTITLEMENT_FEATURE_FLAGS_JSON;
  return raw ? z.object(Object.fromEntries(CAPABILITIES.map(key => [key, z.boolean().optional()]))).strict().parse(JSON.parse(raw)) : {};
}
