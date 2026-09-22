import "server-only";
import { limitCredentialAttempts } from "../auth/rate-limit";
import { RequestError } from "../api";

/** The legacy bring-your-own-key tool still consumes shared server capacity.
 * One stable server-derived user key covers both endpoints and all sessions. */
export async function limitLegacyAI(userId: string) {
  const retryAfter = await limitCredentialAttempts(userId, "legacy-ai");
  if (retryAfter !== null) throw new RequestError("Too many code review requests. Please try again later.", 429);
}
