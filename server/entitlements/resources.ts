import "server-only";
import { randomUUID } from "node:crypto";
import { CAPABILITIES, type Capability } from "@/lib/entitlements/types";
import { db } from "../db/client";
import { assertEffectiveAccess, assertWithinLimit, getUserEntitlements, lockEntitlementUser, type EntitlementClient } from "./service";
import { readUsage } from "./usage";

/** Hold the user row lock until the caller's resource write commits. */
export async function assertResourceCreation(userId: string, resource: "course" | "memory" | "account", tx: EntitlementClient, existingId?: string) {
  await lockEntitlementUser(tx, userId);
  const effective = await getUserEntitlements(userId, tx);
  if (resource === "course") {
    assertEffectiveAccess(effective, "academic.courses");
    assertWithinLimit(effective.values, "courses.max", await tx.course.count({ where: { userId } }));
  } else if (resource === "memory") {
    assertEffectiveAccess(effective, "personalization.memory");
    assertWithinLimit(effective.values, "memory.maxActive", await tx.userMemory.count({ where: { userId, status: "ACTIVE", ...(existingId ? { id: { not: existingId } } : {}) } }));
  } else {
    assertWithinLimit(effective.values, "integrations.maxAccounts", await tx.connectedAccount.count({ where: { userId, status: { not: "REVOKED" }, ...(existingId ? { id: { not: existingId } } : {}) } }));
  }
}
export async function admitDocumentProcessing(userId: string, bytes: number, tx: EntitlementClient, newDocument = false) {
  await lockEntitlementUser(tx, userId);
  const effective = await getUserEntitlements(userId, tx);
  assertEffectiveAccess(effective, "academic.documents");
  assertWithinLimit(effective.values, "documents.maxFileBytes", 0, bytes);
  if (newDocument) assertWithinLimit(effective.values, "documents.max", await tx.document.count({ where: { userId } }));
  const used = await tx.entitlementUsageAdmission.count({ where: { userId, kind: "document", createdAt: { gte: effective.period.start, lt: effective.period.end } } });
  assertWithinLimit(effective.values, "documents.monthlyProcessing", used);
  return tx.entitlementUsageAdmission.create({ data: { userId, kind: "document", requestId: randomUUID(), periodEnd: effective.period.end } });
}
export async function assertWorkflowAllowance(userId: string, workflowId: string, tx: EntitlementClient = db(), creating = false) {
  if (creating) await lockEntitlementUser(tx, userId);
  const effective = await getUserEntitlements(userId, tx);
  const key = `workflow.${workflowId}` as Capability;
  if (!CAPABILITIES.includes(key)) throw new Error("Workflow entitlement is not configured");
  assertEffectiveAccess(effective, key);
  if (creating) assertWithinLimit(effective.values, "workflow.monthlyRuns", (await readUsage(effective, tx)).workflowRuns);
}
export async function assertIntegrationAccess(userId: string, capability?: string, tx: EntitlementClient = db()) {
  const effective = await getUserEntitlements(userId, tx);
  const key = capability?.startsWith("calendar") ? "integration.calendar" : capability === "drive-read" ? "integration.drive" : capability === "lms" ? "integration.lms" : undefined;
  if (key) assertEffectiveAccess(effective, key);
  // Identity-only OAuth still consumes an account slot at connection time, but
  // reading local account metadata and disconnecting are always available.
}
export const JOB_CAPABILITIES: Readonly<Record<string, Capability>> = {
  "sync-external-course": "integration.lms", "import-google-drive-file": "integration.drive", "sync-google-calendar": "integration.calendar",
  "refresh-user-recommendations": "automation.recommendations", "refresh-user-reminders": "automation.reminders", "deliver-user-notifications": "automation.notifications",
};
export async function canRunBackgroundFeature(userId: string, jobName: string) {
  const key = JOB_CAPABILITIES[jobName];
  return !key || (await getUserEntitlements(userId)).values[key];
}
