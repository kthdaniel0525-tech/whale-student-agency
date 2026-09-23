import { ENTITLEMENT_CODES } from "@/lib/entitlements/types";
import "server-only";
import type { AIUsage } from "./types";
import type { FailureInfo } from "./reliability/failures";
export const AI_GUARD_CODES = [...ENTITLEMENT_CODES, "AI_REQUEST_RATE_LIMITED", "AI_REQUEST_BUDGET_EXCEEDED", "AI_WORKFLOW_STEP_LIMIT", "AI_CONCURRENCY_LIMIT", "AI_CONTEXT_LIMIT", "AI_EMBEDDING_LIMIT", "AI_DUPLICATE_REQUEST", "AI_FEATURE_DISABLED", "AI_GUARD_STORAGE_UNAVAILABLE"] as const;

const messages = {
  ENTITLEMENT_REQUIRED: "This feature is not included in your current access. View plans for available options.",
  PLAN_USAGE_EXHAUSTED: "Your plan allowance has been reached. Saved work remains available. View plans or wait for the next usage period.",
  PLAN_MODEL_QUALITY_CONFLICT: "This task requires a model tier outside your current access. View plans to continue with the required quality.",
  ENTITLEMENT_FEATURE_DISABLED: "This feature is temporarily unavailable for all plans.",
  TIMEOUT: "This AI request took too long. Please try again.",
  UNSUPPORTED_CAPABILITY: "This AI operation is temporarily unsupported.",
  CONTEXT_TOO_LARGE: "The selected material exceeds this model's capacity.",
  AI_SERVICE_TEMPORARILY_UNAVAILABLE: "This AI feature is temporarily unavailable. Please try again. Saved work remains available.",
  AI_STREAM_INTERRUPTED: "The answer was interrupted. The text already shown is incomplete; please try again when ready.",
  AI_REQUEST_RATE_LIMITED: "Please wait a little before starting another AI request.",
  AI_REQUEST_BUDGET_EXCEEDED: "This request reached a safety limit. Saved progress is available; start a new request to continue.",
  AI_WORKFLOW_STEP_LIMIT: "This workflow stopped safely. Completed work remains available.",
  AI_CONCURRENCY_LIMIT: "Other AI work is still running. Please wait for it to finish and try again.",
  AI_CONTEXT_LIMIT: "This request contains more material than can be processed safely. Select a smaller set of relevant sources.",
  AI_EMBEDDING_LIMIT: "Indexing capacity is temporarily limited. Please try again later or split this document.",
  AI_DUPLICATE_REQUEST: "This request is already being processed or has finished. Open the conversation to see its result.",
  AI_FEATURE_DISABLED: "This AI feature is temporarily unavailable. Please try again later.",
  AI_GUARD_STORAGE_UNAVAILABLE: "AI execution could not be started safely. Please try again shortly.",
  CONFIGURATION:
    "AI configuration is missing or invalid. Check the server settings.",
  AUTHENTICATION:
    "The AI provider could not authenticate this request. Check server credentials and access.",
  RATE_LIMIT:
    "The AI provider is currently limiting requests. Try again later.",
  PROVIDER_FAILURE:
    "The AI provider is temporarily unavailable. Try again later.",
  INVALID_REQUEST:
    "The AI request is invalid or unsupported. Check its inputs and model settings.",
  INVALID_RESPONSE:
    "The AI provider did not return a complete, valid response.",
  CANCELLED: "The AI request was cancelled.",
} as const;

export type AIErrorCode = keyof typeof messages;
export function isGuardrailError(error: unknown): error is AIError {
  return error instanceof AIError && AI_GUARD_CODES.some(code => code === error.code);
}
export class AIError extends Error {
  readonly retryable: boolean;
  constructor(public readonly code: AIErrorCode, public readonly usage?: AIUsage, public readonly model?: string, public readonly failure?: FailureInfo) {
    super(messages[code]);
    this.name = "AIError";
    this.retryable = code === "RATE_LIMIT" || code === "PROVIDER_FAILURE" || code === "TIMEOUT";
  }
}
