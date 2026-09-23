import "server-only";
import { randomUUID } from "node:crypto";
import { captureUsageContext } from "../ai/usage/context";
import { trackProductEvent } from "./service";
import { type ProductEventName } from "@/lib/product-analytics/events";
import { z } from "zod";

/** Only durable successful mutations, never request bodies or returned content. */
export function trackApiSuccess(userId: string, request: Request, result: unknown) {
  try {
    if (result instanceof Response || !["POST", "PUT", "PATCH"].includes(request.method)) return;
    const path = new URL(request.url).pathname;
    const object = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const id = typeof object.id === "string" ? object.id : captureUsageContext().requestId ?? randomUUID();
    let event: ProductEventName | undefined;
    if (path === "/api/student/profile" && request.method === "PUT") { trackProductEvent(userId, "onboarding_completed", {}, userId); return; }
    if (request.method === "POST") {
      if (path === "/api/student/courses") event = "course_created";
      if (/^\/api\/student\/courses\/[^/]+\/assignments$/.test(path)) event = "assignment_created";
      if (/^\/api\/student\/courses\/[^/]+\/exams$/.test(path)) event = "exam_created";
      if (path === "/api/student/documents") event = "document_uploaded";
      if (path === "/api/student/career/projects") event = "project_added";

    }
    if (path === "/api/student/career/profile" && request.method === "PUT") { trackProductEvent(userId, "career_profile_created", {}, userId); return; }
    if (event) trackProductEvent(userId, event, {}, id);
  } catch { /* Analytics cannot invalidate a completed mutation. */ }
}

export function trackApiFailure(userId: string | undefined, request: Request, error: unknown) {
  if (!userId) return;
  try {
    const path = new URL(request.url).pathname;
    const feature = path.includes("/assistant/") ? "assistant" : path.includes("/documents") ? "documents" : path.includes("/billing") ? "billing" : path.includes("/integrations") ? "integrations" : undefined;
    if (!feature) return;
    const rawCode = error instanceof Error && "code" in error ? error.code : "";
    const status = error instanceof Error && "status" in error ? error.status : undefined;
    const errorCode = rawCode === "TIMEOUT" ? "TIMEOUT" : status === 429 || ["RATE_LIMIT", "AI_REQUEST_RATE_LIMITED", "PLAN_USAGE_EXHAUSTED"].includes(String(rawCode)) ? "RATE_LIMIT"
      : status === 401 || status === 403 || rawCode === "BETA_ACCESS_REQUIRED" ? "ACCESS_DENIED"
        : error instanceof z.ZodError || status === 400 || status === 404 || rawCode === "INVALID_REQUEST" ? "INVALID_REQUEST" : "UNAVAILABLE";
    trackProductEvent(userId, "feature_failed", { feature, errorCode, requestId: captureUsageContext().requestId });
  } catch { /* No raw exception text is stored. */ }
}
