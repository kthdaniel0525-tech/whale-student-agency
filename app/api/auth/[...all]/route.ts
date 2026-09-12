import { z } from "zod";
import { limitCredentialAttempts } from "@/server/auth/rate-limit";
import { auth } from "@/server/auth/config";
import { checkOrigin, readJson, RequestError } from "@/server/api";
import { credentialsSchema } from "@/features/student/validation/schemas";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return auth().handler(request);
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
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
    return auth().handler(request);
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        { message: error.issues[0].message },
        { status: 400 },
      );
    if (error instanceof RequestError)
      return Response.json(
        { message: error.message },
        { status: error.status },
      );
    console.error("Authentication unavailable", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json(
      { message: "Authentication is unavailable. Please try again." },
      { status: 503 },
    );
  }
}
