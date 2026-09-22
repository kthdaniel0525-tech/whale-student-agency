import "server-only";
import { z } from "zod";
import { db } from "../db/client";
import { assertActiveUser } from "./account-state";
import { lockEntitlementUser } from "../entitlements/service";
import { billingProvider } from "../billing/service";
import { withBillingLease } from "../billing/lease";
import { disconnectConnectedAccount } from "../integrations/service";
import { cleanupAfterDelete } from "../documents/cleanup";
import type { BillingProvider } from "../billing/types";
export class PrivacyError extends Error {
  constructor(readonly code: "PRIVACY_CONFIGURATION" | "PRIVACY_REAUTHENTICATION" | "PRIVACY_PENDING", readonly status = 409) {
    super(code === "PRIVACY_REAUTHENTICATION" ? "Confirm your current password to delete your account." : code === "PRIVACY_CONFIGURATION" ? "Account deletion needs an operator-configured billing retention policy. Please contact support." : "Account deletion is pending. Existing access has been disabled."); this.name = "PrivacyError";
  }
}
function retentionDays(required: boolean) {
  const raw = process.env.PRIVACY_BILLING_RETENTION_DAYS;
  if (!raw && required) throw new PrivacyError("PRIVACY_CONFIGURATION");
  const result = z.coerce.number().int().min(0).max(3650).safeParse(raw || "0");
  if (!result.success) throw new PrivacyError("PRIVACY_CONFIGURATION");
  return result.data;
}
/** Authenticated API performs password reauthentication before this server-only
 * operation. No frontend identity, retention value or provider ID is accepted. */
export async function requestAccountDeletion(userId: string) {
  await assertActiveUser(userId);
  retentionDays(!!await db().billingCustomer.findUnique({ where: { userId } }));
  await db().$transaction(async tx => {
    await lockEntitlementUser(tx, userId);
    await tx.user.update({ where: { id: userId }, data: { deletionRequestedAt: new Date() } });
    await tx.session.deleteMany({ where: { userId } });
    await tx.oAuthConnectionSession.deleteMany({ where: { userId } });
    await tx.jobRun.updateMany({ where: { userId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "CANCELLED", completedAt: new Date() } });
    await tx.workflowRun.updateMany({ where: { userId, status: { in: ["PENDING", "RUNNING", "WAITING_FOR_INPUT"] } }, data: { status: "CANCELLED" } });
  });
  return { accepted: true };
}
type DeletionDependencies = { billing?: BillingProvider; disconnect?: typeof disconnectConnectedAccount };
/** Retryable canonical deletion. Provider calls happen outside transactions;
 * local credentials disappear even when best-effort OAuth revocation fails. */
export async function completeAccountDeletion(userId: string, dependencies: DeletionDependencies = {}) {
  const user = await db().user.findUnique({ where: { id: userId } });
  if (!user) return { deleted: true, revocationFailures: 0 };
  if (!user.deletionRequestedAt) throw new PrivacyError("PRIVACY_PENDING");
  const customer = await db().billingCustomer.findUnique({ where: { userId } });
  const days = retentionDays(!!customer);
  if (customer?.providerCustomerId) {
    const provider = dependencies.billing ?? billingProvider();
    await withBillingLease(userId, async lease => {
      const checkout = await db().billingCheckout.findUnique({ where: { userId } });
      let sessionId = checkout?.providerSessionId;
      // Recover an ambiguous checkout using its original idempotency key before
      // destroying the only local link to an externally payable session.
      if (checkout && !sessionId && checkout.expiresAt > new Date()) {
        sessionId = (await provider.checkout({ customerId: customer.providerCustomerId!, priceId: checkout.priceId, key: `checkout:${checkout.id}`, expiresAt: checkout.expiresAt })).id;
        await lease.persist(tx => tx.billingCheckout.update({ where: { id: checkout.id }, data: { providerSessionId: sessionId } }));
      }
      if (sessionId && (await provider.checkoutState(sessionId)).status === "open") await provider.expireCheckout(sessionId);
      for (const id of await provider.subscriptionIds(customer.providerCustomerId!)) await provider.cancelSubscription(id);
      // Fence against a stale worker before deleting local content. Failure keeps
      // the account disabled and retries instead of losing an ongoing charge.
      await lease.persist(async () => undefined);
    }, true);
  } else if (customer && !customer.providerCustomerId) {
    // An ambiguous remote customer creation may exist. Retain the disabled
    // account for operator recovery; don't discard its durable identity.
    throw new PrivacyError("PRIVACY_PENDING");
  }
  let revocationFailures = 0;
  const accounts = await db().connectedAccount.findMany({ where: { userId }, select: { id: true, status: true } });
  for (const account of accounts) {
    if (account.status !== "REVOKED") {
      try { const result = await (dependencies.disconnect ?? disconnectConnectedAccount)(userId, account.id); if (result.revocationFailed) revocationFailures++; }
      catch { revocationFailures++; }
    }
  }
  await db().$transaction(async tx => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    if (!locked.length) return; // Another deletion worker already completed.
    const canonical = await tx.user.findUnique({ where: { id: userId } });
    if (!canonical?.deletionRequestedAt) throw new PrivacyError("PRIVACY_PENDING");
    if (customer?.providerCustomerId && days > 0) {
      const mappings = await tx.billingSubscription.findMany({ where: { userId }, select: { providerSubscriptionId: true } });
      await tx.billingRetentionRecord.create({ data: { providerCustomerId: customer.providerCustomerId, providerSubscriptionIds: mappings.map(s => s.providerSubscriptionId), retainUntil: new Date(Date.now() + days * 86400000) } });
    }
    await tx.aIGuardEvent.deleteMany({ where: { userId } });
    await tx.verification.deleteMany({ where: { value: userId } });
    // All product relations cascade, including vectors, summaries, encrypted
    // tokens and jobs. PostgreSQL enqueues disk files in FileDeletion first.
    await tx.user.delete({ where: { id: userId } });
  }, { timeout: 10000 });
  await cleanupAfterDelete(userId);
  return { deleted: true, revocationFailures };
}
export async function sweepAccountDeletions(signal?: AbortSignal) {
  const users = await db().user.findMany({ where: { deletionRequestedAt: { not: null } }, orderBy: { deletionRequestedAt: "asc" }, take: 10, select: { id: true } });
  let deleted = 0, failed = 0, revocationFailures = 0;
  for (const user of users) {
    if (signal?.aborted) break;
    try { const result = await completeAccountDeletion(user.id); deleted++; revocationFailures += result.revocationFailures; } catch { failed++; }
  }
  const expired = await db().$executeRaw`DELETE FROM "BillingRetentionRecord" WHERE id IN (SELECT id FROM "BillingRetentionRecord" WHERE "retainUntil" < NOW() LIMIT 1000)`;
  return { deleted, failed, revocationFailures, expiredBillingRecords: expired };
}
