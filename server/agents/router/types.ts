import type { AIProvider } from "../../ai/types";
import type { AgentId } from "../types";

export interface AgentRoutingRequest {
  readonly request: string;
  /** May come from UI input; validated against the registry and server allowlist. */
  readonly preferredAgentId?: string;
}

export type AgentRoutingMethod =
  | "rule"
  | "capability"
  | "llm-fallback"
  | "default";

export interface AgentRoutingResult<Extension extends string = never> {
  readonly agentId: AgentId<Extension>;
  readonly confidence: number;
  readonly method: AgentRoutingMethod;
  readonly reason?: string;
}

export interface AgentRouterOptions<Extension extends string = never> {
  /** Trusted server configuration, not a client-controlled permissions mechanism. */
  readonly allowedAgentIds?: readonly AgentId<Extension>[];
  readonly defaultAgentId?: AgentId<Extension>;
  /** Default 0.8; 0.5–1 allows a caller to accept a clear, moderate match. */
  readonly deterministicThreshold?: number;
  /** Resolved only when fallback is necessary. Defaults to the existing AI factory. */
  readonly getProvider?: () => AIProvider | Promise<AIProvider>;
}

export type AgentRoutingErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_CONFIGURATION"
  | "UNKNOWN_AGENT"
  | "AGENT_NOT_ALLOWED"
  | "NO_AVAILABLE_AGENTS"
  | "DEFAULT_UNAVAILABLE";
