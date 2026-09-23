import "server-only";
import { AIError, isGuardrailError } from "../errors";
export const FAILURE_CLASSES = ["timeout", "rate-limit", "provider-unavailable", "overloaded", "authentication", "invalid-request", "unsupported-capability", "context-too-large", "content-schema", "unknown"] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];
export type FailureInfo = { kind: FailureClass; scope?: "model" | "provider" | "request"; retryAfterMs?: number; streamStarted?: boolean; tokensEmitted?: number };
export function classifyFailure(error: unknown): FailureInfo | undefined {
  if (isGuardrailError(error) || error instanceof AIError && ["CANCELLED", "AI_SERVICE_TEMPORARILY_UNAVAILABLE", "AI_STREAM_INTERRUPTED"].includes(error.code)) return undefined;
  if (!(error instanceof AIError)) return { kind: "unknown", scope: "model" };
  if (error.failure) return error.failure;
  const kind: FailureClass = ({ TIMEOUT: "timeout", RATE_LIMIT: "rate-limit", PROVIDER_FAILURE: "provider-unavailable", AUTHENTICATION: "authentication", CONFIGURATION: "authentication",
    INVALID_REQUEST: "invalid-request", INVALID_RESPONSE: "content-schema", UNSUPPORTED_CAPABILITY: "unsupported-capability", CONTEXT_TOO_LARGE: "context-too-large" } as Partial<Record<string, FailureClass>>)[error.code] ?? "unknown";
  return { kind, scope: kind === "authentication" ? "provider" : "model" };
}
export const canRetrySame = (f: FailureInfo) => ["timeout", "provider-unavailable", "overloaded", "content-schema"].includes(f.kind) && !f.retryAfterMs;
export const canFallback = (f: FailureInfo) => !["invalid-request", "unknown"].includes(f.kind);
export function normalizedFailure(error: unknown): AIError { return error instanceof AIError ? error : new AIError("PROVIDER_FAILURE", undefined, undefined, { kind: "unknown" }); }

/** A bounded abort race also protects adapters that fail to settle on abort.
 * Adapters must forward the signal to their transport; no hedged calls are made. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      listener = () => reject(signal.reason instanceof AIError ? signal.reason : new AIError("CANCELLED"));
      if (signal.aborted) listener(); else signal.addEventListener("abort", listener, { once: true });
    })]);
  } finally { if (listener) signal.removeEventListener("abort", listener); }
}
