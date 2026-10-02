import { trackApiSuccess, trackApiFailure } from "./product-analytics/http";
import { betaAccess, BetaAccessError } from "./beta/access";
import { observeRequest, reportError, safeRoute } from "./operations/monitoring";
import { BillingError } from "./billing/errors";
import { EntitlementError } from "./entitlements/errors";
import "server-only";
import { captureUsageContext, withAIUsageContext } from "./ai/usage/context";
import { DocumentError } from "@/server/documents/config";
import { z } from "zod";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { NotFoundError } from "@/server/services/academic";
import { RecommendationError } from "@/server/recommendations";
import { AIError } from "@/server/ai/errors";
import { assertActiveUser } from "@/server/privacy/account-state";
import { PrivacyError } from "@/server/privacy/deletion";
const noStore = { "Cache-Control": "private, no-store" };
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export function checkOrigin(request: Request) {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    request.headers.get("origin") !== new URL(getEnv().BETTER_AUTH_URL).origin
  ) {
    throw new RequestError(
      "Please submit this request from the application.",
      403,
    );
  }
}
export async function readJson<Output, Input>(
  request: Request,
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  maxBytes = 32768,
): Promise<Output> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    throw new RequestError("JSON is required.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("Request body is required.", 400);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new RequestError("Request is too large.", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new RequestError("Invalid JSON.", 400);
  }
  return schema.parse(json);
}
async function apiOperation(
  request: Request,
  operation: (userId: string) => Promise<unknown>,
  needsProfile = true,
) {
  let analyticsUserId: string | undefined;
  try {
    checkOrigin(request);
    const session = await auth().api.getSession({ headers: request.headers });
    if (!session) throw new RequestError("Please sign in to continue.", 401);
    await assertActiveUser(session.user.id);
    analyticsUserId = session.user.id;
    if (!new URL(request.url).pathname.match(/^\/api\/(student\/(account|product-feedback|product-analytics|billing\/portal)|internal\/beta)(\/|$)/)) await betaAccess(session.user.id);
    if (
      needsProfile &&
      !(await db().profile.findUnique({
        where: { userId: session.user.id },
        select: { id: true },
      }))
    ) {
      throw new RequestError("Complete onboarding first.", 403);
    }
    const usageContext = captureUsageContext({ userId: session.user.id });
    const result = await withAIUsageContext(usageContext, () => operation(session.user.id));
    trackApiSuccess(session.user.id, request, result);
    if (result instanceof Response) {
      result.headers.set("Cache-Control", "private, no-store");
      result.headers.set("X-Request-ID", usageContext.requestId!);
      return result;
    }
    return Response.json(result ?? { success: true }, { headers: { ...noStore, "X-Request-ID": usageContext.requestId! } });
  } catch (error) {
    trackApiFailure(analyticsUserId, request, error);
    if (error instanceof BetaAccessError) return Response.json({ error: error.message, code: error.code, accessUrl: "/beta" }, { status: 403, headers: noStore });
    if (error instanceof PrivacyError) return Response.json({ error: new PrivacyError(error.code).message, code: error.code }, { status: error.status, headers: noStore });
    if (error instanceof BillingError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: noStore });
    if (error instanceof EntitlementError) return Response.json({ error: error.message, code: error.code, plansUrl: error.plansUrl }, { status: error.status, headers: noStore });
    if (error instanceof z.ZodError)
      return Response.json(
        {
          error: "Check the highlighted fields.",
          fields: error.flatten().fieldErrors,
        },
        { status: 400, headers: noStore },
      );
    if (
      error instanceof RequestError ||
      error instanceof DocumentError ||
      error instanceof NotFoundError ||
      error instanceof RecommendationError
    ) {
      return Response.json(
        { error: error.message },
        {
          status:
            error instanceof RequestError || error instanceof DocumentError
              ? error.status
              : error instanceof RecommendationError
                ? error.code === "UNAUTHENTICATED" ? 401
                  : error.code === "NOT_FOUND" || error.code === "INVALID_TARGET" ? 404
                    : error.code === "STORAGE_FAILURE" ? 503 : 400
                : 404,
          headers: noStore,
        },
      );
    }
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    // A provider/ORM/driver's `code` does not make its message public. In
    // particular Prisma messages can contain queries, schema names and inputs.
    if (code === "P2003" || code === "P2025")
      return Response.json(
        { error: "This item is no longer available. Refresh and try again." },
        { status: 404, headers: noStore },
      );
    const publicCodes = [
      "UNAUTHENTICATED", "AUTHENTICATION_FAILURE", "NOT_FOUND", "RUN_NOT_FOUND", "QUIZ_NOT_FOUND", "PLAN_NOT_FOUND", "TASK_NOT_FOUND", "CONVERSATION_NOT_FOUND", "REFERENCE_NOT_FOUND",
      "ENTITLEMENT_REQUIRED", "PLAN_USAGE_EXHAUSTED", "PLAN_MODEL_QUALITY_CONFLICT", "ENTITLEMENT_FEATURE_DISABLED", "RATE_LIMIT", "AI_REQUEST_RATE_LIMITED", "AI_CONCURRENCY_LIMIT", "AI_EMBEDDING_LIMIT", "AI_DUPLICATE_REQUEST",
      "AI_GUARD_STORAGE_UNAVAILABLE", "AI_FEATURE_DISABLED", "AI_SERVICE_TEMPORARILY_UNAVAILABLE", "AI_STREAM_INTERRUPTED", "TIMEOUT", "PROVIDER_FAILURE", "STORAGE_FAILURE", "CONFIGURATION", "AUTHENTICATION", "INVALID_RESPONSE",
      "INVALID_REQUEST", "CONTEXT_MISMATCH", "INVALID_TARGET", "LIMIT_EXCEEDED", "LIMIT_REACHED", "CONFLICT", "MEMORY_NOT_FOUND",
    ];
    if (typeof code === "string" && (error instanceof AIError || publicCodes.includes(code))) {
      const status =
        ["UNAUTHENTICATED", "AUTHENTICATION_FAILURE"].includes(code) ? 401
          : ["ENTITLEMENT_REQUIRED", "PLAN_MODEL_QUALITY_CONFLICT", "ENTITLEMENT_FEATURE_DISABLED"].includes(code) ? 403
          : ["NOT_FOUND", "RUN_NOT_FOUND", "QUIZ_NOT_FOUND", "PLAN_NOT_FOUND", "TASK_NOT_FOUND", "CONVERSATION_NOT_FOUND", "MEMORY_NOT_FOUND", "REFERENCE_NOT_FOUND"].includes(code) ? 404
            : ["PLAN_USAGE_EXHAUSTED", "LIMIT_REACHED", "RATE_LIMIT", "AI_REQUEST_RATE_LIMITED", "AI_CONCURRENCY_LIMIT", "AI_EMBEDDING_LIMIT"].includes(code) ? 429
              : code === "AI_DUPLICATE_REQUEST" ? 409
                : ["AI_GUARD_STORAGE_UNAVAILABLE", "AI_FEATURE_DISABLED", "AI_SERVICE_TEMPORARILY_UNAVAILABLE", "AI_STREAM_INTERRUPTED", "TIMEOUT"].includes(code) ? 503
              : ["PROVIDER_FAILURE", "STORAGE_FAILURE", "CONFIGURATION", "AUTHENTICATION", "INVALID_RESPONSE"].includes(code) ? 503
                : 400;
      return Response.json(
        { error: error instanceof AIError ? new AIError(error.code).message
          : status === 401 ? "Please sign in to continue."
            : status === 404 ? "This item was not found."
              : status === 429 ? "Too many requests. Please try again later."
                : status === 503 ? "This service is temporarily unavailable. Please try again."
                  : "The request could not be completed. Check its inputs and try again.", ...(["ENTITLEMENT_REQUIRED", "PLAN_USAGE_EXHAUSTED", "PLAN_MODEL_QUALITY_CONFLICT", "ENTITLEMENT_FEATURE_DISABLED"].includes(code) ? { code, plansUrl: "/plans" } : {}) },
        { status, headers: noStore },
      );
    }
    reportError(error, { route: safeRoute(request) });
    return Response.json(
      { error: "Unable to save or load your data. Please try again." },
      { status: 500, headers: noStore },
    );
  }
}

export function api(request: Request, operation: (userId: string) => Promise<unknown>, needsProfile = true) {
  return observeRequest(request, () => apiOperation(request, operation, needsProfile));
}
