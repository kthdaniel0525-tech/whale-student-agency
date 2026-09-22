import "server-only";
import { z } from "zod";
import { db } from "../db/client";
import { planSchema } from "../entitlements/service";
import { basePlanCode } from "../entitlements/config";
const catalogSchema = z.array(planSchema).min(1).max(20).superRefine((plans, ctx) => {
  if (new Set(plans.map(p => p.code)).size !== plans.length || plans.some(p => p.internal)) ctx.addIssue({ code: "custom", message: "Production catalog requires unique public plans" });
});
/** Only explicit reviewed system configuration. No users or academic fixtures. */
export async function bootstrapPlans(input: unknown) {
  const plans = catalogSchema.parse(input);
  if (!plans.some(p => p.code === basePlanCode() && p.active)) throw new Error("Default plan is missing or inactive");
  await db().$transaction(async tx => {
    for (const plan of plans) await tx.plan.upsert({ where: { code: plan.code }, create: plan, update: plan });
  });
  return plans.length;
}
