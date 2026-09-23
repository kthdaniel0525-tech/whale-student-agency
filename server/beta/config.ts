import "server-only";
import { z } from "zod";
import { CAPABILITIES, type Capability } from "@/lib/entitlements/types";

export const cohortSchema = z.enum(["core", "integrations", "paid-pilot"]);
export type BetaCohort = z.infer<typeof cohortSchema>;
const capabilityFlags = z.object(Object.fromEntries(CAPABILITIES.map(key => [key, z.boolean().optional()]))).strict();
export function betaConfig() {
  const env = z.object({
    BETA_MODE: z.enum(["true", "false"]).default("false"),
    BETA_DEFAULT_COHORT: cohortSchema.default("core"),
    BETA_INTERNAL_USER_IDS: z.string().default(""),
    BETA_ADMIN_USER_IDS: z.string().default(""),
    BETA_COHORT_FLAGS_JSON: z.string().optional(),
  }).parse(process.env);
  const custom = env.BETA_COHORT_FLAGS_JSON ? z.record(cohortSchema, capabilityFlags).parse(JSON.parse(env.BETA_COHORT_FLAGS_JSON)) : {};
  const core: Partial<Record<Capability, boolean>> = { "integration.calendar": false, "integration.drive": false, "integration.lms": false, "ai.career": false, "workflow.career-preparation": false };
  return { enabled: env.BETA_MODE === "true", defaultCohort: env.BETA_DEFAULT_COHORT,
    admins: env.BETA_ADMIN_USER_IDS.split(",").map(v => v.trim()).filter(Boolean),
    internal: env.BETA_INTERNAL_USER_IDS.split(",").map(v => v.trim()).filter(Boolean),
    flags: { core: { ...core, ...custom.core }, integrations: { ...custom.integrations }, "paid-pilot": { ...custom["paid-pilot"] } } };
}
