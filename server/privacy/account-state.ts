import "server-only";
import { db } from "../db/client";
export class AccountUnavailableError extends Error {
  readonly code = "UNAUTHENTICATED";
  readonly status = 401;
  constructor() { super("This account is no longer available. Please sign in again."); this.name = "AccountUnavailableError"; }
}
export async function assertActiveUser(userId: string) {
  const user = await db().user.findUnique({ where: { id: userId }, select: { deletionRequestedAt: true } });
  if (!user || user.deletionRequestedAt) throw new AccountUnavailableError();
}
