import { z } from "zod";
import { api, readJson, RequestError } from "@/server/api";
import { limitCredentialAttempts } from "@/server/auth/rate-limit";
import { auth } from "@/server/auth/config";
import { PrivacyError, requestAccountDeletion } from "@/server/privacy/deletion";
const input = z.object({ password: z.string().min(1).max(128), confirmation: z.literal("DELETE") }).strict();
export const runtime = "nodejs";
export async function DELETE(request: Request) {
  return api(request, async userId => {
    const value = await readJson(request, input);
    if (await limitCredentialAttempts(userId, "account-deletion") !== null) throw new RequestError("Too many attempts. Please try again later.", 429);
    try { await auth().api.verifyPassword({ headers: request.headers, body: { password: value.password } }); }
    catch { throw new PrivacyError("PRIVACY_REAUTHENTICATION", 403); }
    await requestAccountDeletion(userId);
    return Response.json({ accepted: true, message: "Your account is disabled and deletion has been queued." }, { status: 202 });
  }, false);
}
