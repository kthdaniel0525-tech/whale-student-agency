import "server-only";
import { db } from "../db/client";
import type { Prisma } from "@/generated/prisma/client";
import { betaConfig, cohortSchema } from "./config";
export class BetaAccessError extends Error {
  readonly code = "BETA_ACCESS_REQUIRED";
  constructor(message = "This account does not have beta access yet.") { super(message); }
}
/** Revocation always wins over the signup allowlist. No plan implies beta/admin access. */
export async function betaAccess(userId: string, tx: Prisma.TransactionClient = db()) {
  const config = betaConfig();
  if (!config.enabled) return null;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, deletionRequestedAt: true } });
  if (!user || user.deletionRequestedAt) throw new BetaAccessError();
  let access = await tx.betaAccess.findUnique({ where: { userId } });
  if (!access) {
    const allowed = (process.env.SIGNUP_EMAIL_ALLOWLIST ?? "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(user.email.toLowerCase())) throw new BetaAccessError();
    access = await tx.betaAccess.upsert({ where: { userId }, create: { userId, cohort: config.defaultCohort, source: "allowlist" }, update: {} });
  }
  if (!cohortSchema.safeParse(access.cohort).success || !["invited", "active"].includes(access.status)) throw new BetaAccessError();
  if (access.status === "invited") {
    await tx.betaAccess.updateMany({ where: { userId, status: "invited" }, data: { status: "active", activatedAt: new Date() } });
    access = await tx.betaAccess.findUniqueOrThrow({ where: { userId } });
    if (access.status !== "active") throw new BetaAccessError();
  }
  return access;
}
export async function betaFeatureFlags(userId: string, tx: Prisma.TransactionClient = db()) {
  const access = await betaAccess(userId, tx);
  return access ? betaConfig().flags[access.cohort as keyof ReturnType<typeof betaConfig>["flags"]] ?? {} : {};
}
export async function assertBetaBilling(userId: string) {
  const access = await betaAccess(userId);
  if (access && access.cohort !== "paid-pilot") throw new BetaAccessError("Paid subscriptions are available to the paid pilot beta group.");
}
export async function assertBetaAdmin(userId: string) {
  if (!betaConfig().admins.includes(userId) || !await db().user.findFirst({ where: { id: userId, deletionRequestedAt: null }, select: { id: true } })) throw new BetaAccessError();
}
