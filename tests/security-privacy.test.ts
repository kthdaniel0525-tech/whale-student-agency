import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { auth } from "@/server/auth/config";
import { requestAccountDeletion, completeAccountDeletion } from "@/server/privacy/deletion";
import { assertActiveUser } from "@/server/privacy/account-state";
import { getUserEntitlements } from "@/server/entitlements/service";
import { withBillingLease } from "@/server/billing/lease";
import { createBillingPortalSession } from "@/server/billing/service";
import { storage } from "@/server/documents/storage/local";
import { DELETE } from "@/app/api/student/account/route";
import type { BillingProvider } from "@/server/billing/types";
const ids: string[] = [], customers: string[] = [];
const password = "Security-delete-test-passphrase-2026!";
async function user() {
  const result = await auth().api.signUpEmail({ body: { name: "Deletion test", email: `privacy-${randomUUID()}@example.test`, password }, asResponse: true });
  expect(result.status).toBe(200);
  const id = (await result.json()).user.id as string; ids.push(id);
  const headers = new Headers({ origin: process.env.BETTER_AUTH_URL!, "content-type": "application/json", cookie: result.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") });
  return { id, headers };
}
function provider(): BillingProvider {
  return { createCustomer: vi.fn(), price: vi.fn(), subscription: vi.fn(), subscriptionIds: vi.fn().mockResolvedValue(["sub_delete"]), checkout: vi.fn().mockResolvedValue({ id: "cs_recovered", url: "https://checkout.stripe.com/test" }), checkoutState: vi.fn().mockResolvedValue({ status: "open", url: null }), portal: vi.fn(), expireCheckout: vi.fn().mockResolvedValue(undefined), cancelSubscription: vi.fn().mockResolvedValue(undefined), verify: vi.fn() };
}
async function customer(userId: string) { const id = `cus_${randomUUID()}`; customers.push(id); return db().billingCustomer.create({ data: { userId, providerCustomerId: id } }); }
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => {
  await db().user.deleteMany({ where: { id: { in: ids } } });
  await db().billingRetentionRecord.deleteMany({ where: { providerCustomerId: { in: customers } } });
  await db().$disconnect();
});
describe.sequential("account deletion security", () => {
  it("requires current password and confirmation; rejects supplied owner and cross-origin", async () => {
    const u = await user();
    const call = (body: unknown, headers = u.headers) => DELETE(new Request(`${process.env.BETTER_AUTH_URL}/api/student/account`, { method: "DELETE", headers, body: JSON.stringify(body) }));
    expect((await call({ password: "wrong", confirmation: "DELETE" })).status).toBe(403);
    expect((await call({ password, confirmation: "DELETE", userId: "foreign" })).status).toBe(400);
    const bad = new Headers(u.headers); bad.set("origin", "https://attacker.example");
    expect((await call({ password, confirmation: "DELETE" }, bad)).status).toBe(403);
    expect((await call({ password, confirmation: "DELETE" })).status).toBe(202);
    expect(await db().session.count({ where: { userId: u.id } })).toBe(0);
    await expect(assertActiveUser(u.id)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(getUserEntitlements(u.id)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await call({ password, confirmation: "DELETE" })).status).toBe(401);
  });
  it("cancels queued work, cascades content and credentials, and physically removes private files", async () => {
    const u = await user(), other = await user();
    const course = await db().course.create({ data: { userId: u.id, courseCode: "AUDIT", courseName: "Private course", semester: "Fall" } });
    const key = randomUUID(); await storage.put(key, new TextEncoder().encode("private file"));
    await db().document.create({ data: { userId: u.id, courseId: course.id, title: "Private", originalFileName: "private.txt", fileType: "text/plain", fileSize: 12, storageKey: key } });
    const conversation = await db().conversation.create({ data: { userId: u.id } });
    await db().conversationMessage.create({ data: { userId: u.id, conversationId: conversation.id, sequence: 1, role: "USER", content: "private message", tokenEstimate: 4 } });
    await db().connectedAccount.create({ data: { userId: u.id, provider: "google", providerAccountId: randomUUID(), scopes: [], accessTokenEncrypted: "ciphertext", refreshTokenEncrypted: "ciphertext" } });
    await db().verification.create({ data: { id: randomUUID(), identifier: "reset-password:test", value: u.id, expiresAt: new Date(Date.now() + 60000) } });
    const job = await db().jobRun.create({ data: { userId: u.id, queueJobId: randomUUID(), idempotencyKey: randomUUID(), jobName: "test", jobVersion: 1, status: "RUNNING" } });
    await requestAccountDeletion(u.id);
    expect((await db().jobRun.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("CANCELLED");
    const disconnect = vi.fn().mockResolvedValue({ revocationFailed: true });
    const result = await completeAccountDeletion(u.id, { disconnect });
    expect(result).toEqual({ deleted: true, revocationFailures: 1 });
    expect(disconnect).toHaveBeenCalledOnce();
    const where = { userId: u.id };
    expect(await Promise.all([db().course.count({ where }), db().document.count({ where }), db().conversation.count({ where }), db().conversationMessage.count({ where }), db().connectedAccount.count({ where }), db().jobRun.count({ where })])).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await db().verification.count({ where: { value: u.id } })).toBe(0);
    await expect(storage.get(key)).rejects.toThrow();
    await expect(assertActiveUser(other.id)).resolves.toBeUndefined();
    expect(await completeAccountDeletion(u.id)).toEqual({ deleted: true, revocationFailures: 0 });
  });
  it("requires an explicit billing retention decision before disabling account access", async () => {
    const u = await user(); await customer(u.id); vi.stubEnv("PRIVACY_BILLING_RETENTION_DAYS", "");
    await expect(requestAccountDeletion(u.id)).rejects.toMatchObject({ code: "PRIVACY_CONFIGURATION" });
    await expect(assertActiveUser(u.id)).resolves.toBeUndefined();
  });
  it("recovers ambiguous checkout, expires it and cancels subscriptions before retaining only financial IDs", async () => {
    const u = await user(), c = await customer(u.id), p = provider(); vi.stubEnv("PRIVACY_BILLING_RETENTION_DAYS", "30");
    const intent = await db().billingCheckout.create({ data: { userId: u.id, priceId: "price_fixture", expiresAt: new Date(Date.now() + 3600000) } });
    await requestAccountDeletion(u.id); await completeAccountDeletion(u.id, { billing: p });
    expect(p.checkout).toHaveBeenCalledWith({ customerId: c.providerCustomerId, priceId: "price_fixture", key: `checkout:${intent.id}`, expiresAt: intent.expiresAt });
    expect(p.expireCheckout).toHaveBeenCalledWith("cs_recovered"); expect(p.cancelSubscription).toHaveBeenCalledWith("sub_delete");
    const retained = await db().billingRetentionRecord.findFirstOrThrow({ where: { providerCustomerId: c.providerCustomerId! } });
    expect(retained.retainUntil.getTime() - retained.deletedAt.getTime()).toBeGreaterThan(29 * 86400000);
    expect(retained).not.toHaveProperty("userId"); expect(await db().user.findUnique({ where: { id: u.id } })).toBeNull();
  });
  it("keeps a failed remote cancellation disabled and retryable, without discarding the customer mapping", async () => {
    const u = await user(); await customer(u.id); const p = provider(); vi.stubEnv("PRIVACY_BILLING_RETENTION_DAYS", "0");
    vi.mocked(p.cancelSubscription).mockRejectedValueOnce(new Error("provider unavailable"));
    await requestAccountDeletion(u.id);
    await expect(completeAccountDeletion(u.id, { billing: p })).rejects.toThrow();
    expect(await db().billingCustomer.findUnique({ where: { userId: u.id } })).not.toBeNull();
    await expect(assertActiveUser(u.id)).rejects.toThrow();
    await completeAccountDeletion(u.id, { billing: p }); expect(await db().user.findUnique({ where: { id: u.id } })).toBeNull();
  });
  it("refuses to erase an ambiguous provider customer and refuses unrequested deletion", async () => {
    const u = await user(); await expect(completeAccountDeletion(u.id)).rejects.toMatchObject({ code: "PRIVACY_PENDING" });
    await db().billingCustomer.create({ data: { userId: u.id } }); vi.stubEnv("PRIVACY_BILLING_RETENTION_DAYS", "0"); await requestAccountDeletion(u.id);
    await expect(completeAccountDeletion(u.id, { billing: provider() })).rejects.toMatchObject({ code: "PRIVACY_PENDING" });
  });
  it("concurrent content deletion produces one result without resurrecting data", async () => {
    const u = await user(); await requestAccountDeletion(u.id);
    const results = await Promise.all([completeAccountDeletion(u.id), completeAccountDeletion(u.id)]);
    expect(results.every(r => r.deleted)).toBe(true);
  });
});
describe("billing transaction fencing", () => {
  it("does not return a newly issued portal URL after account deletion starts", async () => {
    const u = await user(); await customer(u.id); const p = provider();
    vi.stubEnv("PRIVACY_BILLING_RETENTION_DAYS", "0");
    vi.mocked(p.portal).mockImplementation(async () => { await requestAccountDeletion(u.id); return "https://billing.stripe.com/private-session"; });
    await expect(createBillingPortalSession(u.id, p)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("does not hold a row lock during provider work and refuses a stale commit", async () => {
    const u = await user(); await customer(u.id);
    await withBillingLease(u.id, async lease => {
      await db().$transaction(async tx => { await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`; await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${u.id} FOR UPDATE`; });
      await db().billingCustomer.update({ where: { userId: u.id }, data: { operationLeaseToken: "replacement-worker" } });
      const write = vi.fn(); await expect(lease.persist(write)).rejects.toMatchObject({ code: "BILLING_CONFLICT" }); expect(write).not.toHaveBeenCalled();
    });
    expect((await db().billingCustomer.findUniqueOrThrow({ where: { userId: u.id } })).operationLeaseToken).toBe("replacement-worker");
  });
});
