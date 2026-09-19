import "server-only";
import type { AIUsage } from "./types";

const messages = {
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
export class AIError extends Error {
  readonly retryable: boolean;
  constructor(public readonly code: AIErrorCode, public readonly usage?: AIUsage, public readonly model?: string) {
    super(messages[code]);
    this.name = "AIError";
    this.retryable = code === "RATE_LIMIT" || code === "PROVIDER_FAILURE";
  }
}
