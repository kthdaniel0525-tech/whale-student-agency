import "server-only";
import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import { operationsConfig } from "./config";
import { captureUsageContext, withAIUsageContext } from "../ai/usage/context";
import { randomUUID } from "node:crypto";

const fields = ["requestId", "parentRequestId", "route", "agentId", "workflowId", "workflowRunId", "backgroundJobId", "jobName", "provider", "status", "durationMs", "errorCode", "release", "environment", "event", "level"] as const;
type Fields = Partial<Record<typeof fields[number], string | number | boolean | null | undefined>>;
const safeIdentifier = /^[a-zA-Z0-9_.:/\[\]-]{1,160}$/;
export function safeFields(value: Record<string, unknown>): Fields {
  return Object.fromEntries(fields.flatMap(key => {
    const v = value[key];
    return typeof v === "number" && Number.isFinite(v) || typeof v === "boolean" || typeof v === "string" && safeIdentifier.test(v) ? [[key, v]] : [];
  }));
}
/** Default-deny event boundary. No messages, local variables, URLs, request
 * objects, breadcrumbs, users, attachments or arbitrary extras leave the app. */
export function redactMonitoringEvent(event: ErrorEvent): ErrorEvent {
  return {
    type: undefined, event_id: event.event_id, timestamp: event.timestamp, platform: "node", level: event.level,
    release: operationsConfig().RELEASE_SHA, environment: operationsConfig().APP_ENV,
    tags: safeFields(event.tags ?? {}) as Record<string, string>,
    exception: { values: [{ type: "ApplicationError", value: "Server operation failed", stacktrace: { frames:
      (event.exception?.values?.[0]?.stacktrace?.frames ?? []).slice(-20).flatMap(frame => {
        // Retain source line information only for repository/runtime modules.
        const name = frame.filename?.replaceAll("\\", "/").replace(/^\/app\//, "").match(/(?:^|\/)((?:server|app|scripts|\.next|node_modules)\/[A-Za-z0-9_./[\]-]+)$/)?.[1];
        return name ? [{ filename: name, lineno: frame.lineno, colno: frame.colno, in_app: !name.startsWith("node_modules/") }] : [];
      }),
    } }] },
  };
}
let initialized = false;
export function initializeMonitoring(transport?: NonNullable<Parameters<typeof Sentry.init>[0]>["transport"]) {
  if (initialized) return;
  const config = operationsConfig();
  if (!config.monitoringEnabled || !config.SENTRY_DSN) return;
  Sentry.init({ dsn: config.SENTRY_DSN, environment: config.APP_ENV, release: config.RELEASE_SHA,
    transport, defaultIntegrations: false, sendDefaultPii: false, tracesSampleRate: 0, maxBreadcrumbs: 0,
    beforeSend: redactMonitoringEvent,
  });
  initialized = true;
}
export function logOperation(level: "debug" | "info" | "warn" | "error", event: string, details: Fields = {}) {
  const config = operationsConfig();
  if (["debug", "info", "warn", "error"].indexOf(level) < ["debug", "info", "warn", "error"].indexOf(config.LOG_LEVEL)) return;
  const context = captureUsageContext();
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), ...safeFields({ ...context, ...details, event, level, release: config.RELEASE_SHA, environment: config.APP_ENV }) }));
}
export function reportError(error: unknown, details: Fields = {}) {
  logOperation("error", "operation-failed", details);
  if (!initialized) return;
  Sentry.withScope(scope => {
    for (const [key, value] of Object.entries(safeFields({ ...captureUsageContext(), ...details }))) scope.setTag(key, String(value));
    Sentry.captureException(error instanceof Error ? error : new Error("Server operation failed"));
  });
}
export async function flushMonitoring() { if (initialized) await Sentry.flush(2000); }
// Never log resource IDs or callback query strings from URLs. Preserve a useful
// static route family; requestId carries detailed correlation in internal stores.
export function safeRoute(request: Request) {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const known = new Set(["api", "student", "auth", "billing", "health", "operations", "live", "ready", "metrics", "webhook", "integrations", "courses", "assignments", "exams", "documents", "assistant", "conversations", "workflows", "quiz", "progress", "notifications", "calendar", "drive", "lms", "callback"]);
  return "/" + parts.slice(0, 6).map(p => known.has(p) ? p : "[resource]").join("/");
}
export function observeRequest(request: Request, operation: () => Promise<Response>): Promise<Response> {
  const requestId = randomUUID(), start = performance.now(), route = safeRoute(request);
  return withAIUsageContext({ requestId }, async () => {
    try {
      const response = await operation();
      response.headers.set("X-Request-ID", requestId);
      logOperation(response.status >= 500 ? "error" : "info", "http-response", { route, status: response.status, durationMs: Math.round(performance.now() - start) });
      return response;
    } catch (error) { reportError(error, { route, durationMs: Math.round(performance.now() - start) }); throw error; }
  });
}
