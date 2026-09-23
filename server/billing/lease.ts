import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { lockEntitlementUser } from "../entitlements/service";
import { BillingError } from "./errors";
import { AccountUnavailableError } from "../privacy/account-state";
const TTL_MS = 90000;
export interface BillingLease {
  persist<T>(write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}
/** Short DB transactions fence commits; network operations run outside them.
 * A renewable lease serializes checkout/sync per customer across processes. */
export async function withBillingLease<T>(userId: string, operation: (lease: BillingLease) => Promise<T>, allowDeleting = false): Promise<T> {
  const token = randomUUID();
  const deadline = Date.now() + 12000;
  let acquired = false;
  do {
    acquired = await db().$transaction(async tx => {
      await lockEntitlementUser(tx, userId);
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { deletionRequestedAt: true } });
      if (user.deletionRequestedAt && !allowDeleting) throw new AccountUnavailableError();
      return (await tx.billingCustomer.updateMany({ where: { userId, OR: [{ operationLeaseUntil: null }, { operationLeaseUntil: { lte: new Date() } }] }, data: { operationLeaseToken: token, operationLeaseUntil: new Date(Date.now() + TTL_MS) } })).count === 1;
    });
    if (acquired) break;
    if (Date.now() >= deadline) throw new BillingError("BILLING_CONFLICT", 409);
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  let lost = false;
  const renewal = setInterval(() => {
    void db().billingCustomer.updateMany({ where: { userId, operationLeaseToken: token, operationLeaseUntil: { gt: new Date() } }, data: { operationLeaseUntil: new Date(Date.now() + TTL_MS) } }).then(result => { if (!result.count) lost = true; }).catch(() => { lost = true; });
  }, 20000);
  renewal.unref();
  const lease: BillingLease = {
    persist: write => db().$transaction(async tx => {
      await lockEntitlementUser(tx, userId);
      const customer = await tx.billingCustomer.findUnique({ where: { userId } });
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { deletionRequestedAt: true } });
      if (user.deletionRequestedAt && !allowDeleting) throw new AccountUnavailableError();
      if (lost || customer?.operationLeaseToken !== token || !customer.operationLeaseUntil || customer.operationLeaseUntil <= new Date()) throw new BillingError("BILLING_CONFLICT", 409);
      return write(tx);
    }, { timeout: 10000 }),
  };
  try { return await operation(lease); }
  finally { clearInterval(renewal); await db().billingCustomer.updateMany({ where: { userId, operationLeaseToken: token }, data: { operationLeaseToken: null, operationLeaseUntil: null } }).catch(() => {}); }
}
