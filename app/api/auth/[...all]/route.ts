import { z } from "zod";
import { limitCredentialAttempts } from "@/server/auth/rate-limit";
import { auth } from "@/server/auth/config";
import { checkOrigin, readJson, RequestError } from "@/server/api";
import { credentialsSchema } from "@/features/student/validation/schemas";
import { getEnv } from "@/server/env";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const safeHeaders = { "Cache-Control": "private, no-store" };
const directDeletion = (request: Request) => /\/delete-user(?:\/|$)/.test(new URL(request.url).pathname);
function validateRedirects(input: Record<string, unknown>) {
  const origin = new URL(getEnv().BETTER_AUTH_URL).origin;
  for (const name of ["callbackURL", "redirectTo", "errorCallbackURL", "newUserCallbackURL"]) {
    const value = input[name];
    if (value === undefined) continue;
    let valid = false;
    if (typeof value === "string" && value.length <= 2048) {
      try { const url = new URL(value, origin); valid = url.origin === origin && !url.username && !url.password; } catch { /* Reject malformed URLs. */ }
    }
    if (!valid) throw new RequestError("Choose a destination within this application.", 403);
  }
}
export async function GET(request: Request) {
  if (directDeletion(request)) return Response.json({ message: "Use account settings to delete your account." }, { status: 403, headers: safeHeaders });
  try {
    for (const [name, value] of new URL(request.url).searchParams) validateRedirects({ [name]: value });
  } catch { return Response.json({ message: "Choose a destination within this application." }, { status: 403, headers: safeHeaders }); }
  return auth().handler(request);
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    if (directDeletion(request)) throw new RequestError("Use account settings to delete your account.", 403);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/sign-up/email") || path.endsWith("/sign-in/email")) {
      const schema = path.endsWith("/sign-up/email")
        ? credentialsSchema.extend({
            name: z.string().trim().min(1).max(100),
            callbackURL: z.string().optional(),
            rememberMe: z.boolean().optional(),
          })
        : credentialsSchema.extend({
            callbackURL: z.string().optional(),
            rememberMe: z.boolean().optional(),
          });
      const data = await readJson(request, schema.strict());
      validateRedirects(data);
      const retryAfter = await limitCredentialAttempts(data.email, path);
      if (retryAfter !== null)
        return Response.json(
          {
            message:
              "Too many attempts for this email. Please try again later.",
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(retryAfter),
              "Cache-Control": "no-store",
            },
          },
        );
      return auth().handler(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(data),
        }),
      );
    }
    // Bound every enabled auth mutation, including those supplied by Better Auth.
    // Password changes always rotate the current session and revoke other sessions.
    const data = await readJson(request, path.endsWith("/change-password") ? z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: credentialsSchema.shape.password,
      revokeOtherSessions: z.boolean().optional(),
    }).strict() : z.record(z.unknown()));
    validateRedirects(data);
    if (path.endsWith("/change-password")) {
      const session = await auth().api.getSession({ headers: request.headers });
      if (!session) throw new RequestError("Please sign in to continue.", 401);
      if (await limitCredentialAttempts(session.user.id, "change-password") !== null) throw new RequestError("Too many password attempts. Please try again later.", 429);
    }
    return auth().handler(new Request(request.url, { method: "POST", headers: request.headers,
      body: JSON.stringify(path.endsWith("/change-password") ? { ...data, revokeOtherSessions: true } : data) }));
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        { message: error.issues[0].message },
        { status: 400, headers: safeHeaders },
      );
    if (error instanceof RequestError)
      return Response.json(
        { message: error.message },
        { status: error.status, headers: safeHeaders },
      );
    console.error("Authentication unavailable", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json(
      { message: "Authentication is unavailable. Please try again." },
      { status: 503, headers: safeHeaders },
    );
  }
}
