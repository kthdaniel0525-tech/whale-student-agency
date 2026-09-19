import "server-only";
import { z } from "zod";

export const BACKGROUND_JOB_ERROR_CODES = [
  "TRANSIENT_PROVIDER_ERROR",
  "DATABASE_ERROR",
  "RESOURCE_NOT_FOUND",
  "AUTHORIZATION_ERROR",
  "INVALID_PAYLOAD",
  "PROCESSING_FAILED",
  "TIMEOUT",
  "CONFLICT",
] as const;

export type BackgroundJobErrorCode =
  (typeof BACKGROUND_JOB_ERROR_CODES)[number];

const retryableCodes = new Set<BackgroundJobErrorCode>([
  "TRANSIENT_PROVIDER_ERROR",
  "DATABASE_ERROR",
  "TIMEOUT",
]);

export class BackgroundJobError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: BackgroundJobErrorCode) {
    super(code);
    this.name = "BackgroundJobError";
    this.retryable = retryableCodes.has(code);
  }
}

type CodedError = Error & {
  code?: string;
  retryable?: boolean;
};

export function normalizeBackgroundJobError(
  error: unknown,
  signal?: AbortSignal,
): BackgroundJobError {
  if (error instanceof BackgroundJobError) return error;
  if (signal?.aborted) return new BackgroundJobError("TIMEOUT");
  if (error instanceof z.ZodError)
    return new BackgroundJobError("INVALID_PAYLOAD");

  if (error instanceof Error) {
    const coded = error as CodedError;
    if (coded.name === "AIError") {
      return new BackgroundJobError(
        coded.retryable
          ? "TRANSIENT_PROVIDER_ERROR"
          : coded.code === "AUTHENTICATION"
            ? "AUTHORIZATION_ERROR"
            : "PROCESSING_FAILED",
      );
    }
    if (coded.name === "AcademicIntegrationError") {
      if (coded.code === "PROVIDER_UNAVAILABLE") return new BackgroundJobError("TRANSIENT_PROVIDER_ERROR");
      if (coded.code === "STORAGE_FAILURE") return new BackgroundJobError("DATABASE_ERROR");
      if (coded.code === "NOT_FOUND") return new BackgroundJobError("RESOURCE_NOT_FOUND");
      if (["DISCONNECTED", "AUTHORIZATION_REQUIRED"].includes(coded.code ?? "")) return new BackgroundJobError("AUTHORIZATION_ERROR");
      return new BackgroundJobError("PROCESSING_FAILED");
    }
    if (coded.name === "IntegrationError") {
      if (["NOT_FOUND", "DISCONNECTED"].includes(coded.code ?? "")) return new BackgroundJobError("RESOURCE_NOT_FOUND");
      if (["UNAUTHENTICATED", "RECONNECT_REQUIRED", "AUTHORIZATION_REQUIRED", "INVALID_GRANT"].includes(coded.code ?? "")) return new BackgroundJobError("AUTHORIZATION_ERROR");
      if (coded.code === "PROVIDER_UNAVAILABLE") return new BackgroundJobError("TRANSIENT_PROVIDER_ERROR");
      if (coded.code === "STORAGE_FAILURE") return new BackgroundJobError("DATABASE_ERROR");
      return new BackgroundJobError("PROCESSING_FAILED");
    }
    if (coded.name === "RecommendationError") {
      if (coded.code === "NOT_FOUND")
        return new BackgroundJobError("RESOURCE_NOT_FOUND");
      if (coded.code === "UNAUTHENTICATED")
        return new BackgroundJobError("AUTHORIZATION_ERROR");
      if (coded.code === "INVALID_REQUEST")
        return new BackgroundJobError("INVALID_PAYLOAD");
      if (coded.code === "STORAGE_FAILURE")
        return new BackgroundJobError("DATABASE_ERROR");
    }
    if (coded.name === "ReminderError" || coded.name === "NotificationError" || coded.name === "NotificationPreferenceError") {
      if (coded.code === "NOT_FOUND")
        return new BackgroundJobError("RESOURCE_NOT_FOUND");
      if (coded.code === "INVALID_REQUEST")
        return new BackgroundJobError("INVALID_PAYLOAD");
      if (coded.code === "STORAGE_FAILURE")
        return new BackgroundJobError("DATABASE_ERROR");
      if (coded.code === "INVALID_TARGET")
        return new BackgroundJobError("PROCESSING_FAILED");
    }
    if (["P1001", "P1002", "P1008", "P1017"].includes(coded.code ?? ""))
      return new BackgroundJobError("DATABASE_ERROR");
    if (coded.code === "P2025")
      return new BackgroundJobError("RESOURCE_NOT_FOUND");
    if (coded.code === "P2002") return new BackgroundJobError("CONFLICT");
    if (coded.name.includes("Prisma"))
      return new BackgroundJobError("DATABASE_ERROR");
  }
  return new BackgroundJobError("PROCESSING_FAILED");
}
