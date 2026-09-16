import "server-only";
import { AIError } from "../../ai/errors";
import { AgentExecutionError } from "../executor/executor";
import { AgentRegistryError } from "../registry";
import { AgentRoutingError } from "../router/router";
import type { AgentRequestErrorCode, AgentRequestFailure } from "./types";

export function failure(
  code: AgentRequestErrorCode,
  message: string,
  retryable = false,
): AgentRequestFailure {
  return { ok: false, error: { code, message, retryable } };
}

/** Return only known public fields, never Error objects, causes, or stack traces. */
export function normalizeAgentFailure(
  error: unknown,
  stage: "authentication" | "routing" | "execution",
): AgentRequestFailure {
  if (error instanceof AIError) {
    const safe = new AIError(error.code);
    return failure(safe.code, safe.message, safe.retryable);
  }
  if (error instanceof AgentExecutionError) {
    return failure(error.code, new AgentExecutionError(error.code).message);
  }
  if (error instanceof AgentRoutingError) {
    switch (error.code) {
      case "UNKNOWN_AGENT":
      case "AGENT_NOT_ALLOWED":
      case "INVALID_REQUEST":
      case "INVALID_CONFIGURATION":
        return failure(error.code, new AgentRoutingError(error.code).message);
      default:
        return failure(
          "ROUTING_FAILURE",
          "No available agent could be selected for this request.",
        );
    }
  }
  if (error instanceof AgentRegistryError && error.code === "AGENT_NOT_FOUND") {
    return failure("UNKNOWN_AGENT", "The selected agent is not registered.");
  }
  if (stage === "authentication") {
    return failure(
      "AUTHENTICATION_FAILURE",
      "Authentication could not be verified. Try again later.",
    );
  }
  if (stage === "routing") {
    return failure(
      "ROUTING_FAILURE",
      "The request could not be routed. Try again later.",
    );
  }
  return failure(
    "INTERNAL_ERROR",
    "The agent request could not be completed. Try again later.",
  );
}
