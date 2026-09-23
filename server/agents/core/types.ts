import type { AIErrorCode } from "../../ai/errors";
import type {
  AgentExecutionErrorCode,
  AgentExecutionRequest,
  AgentExecutorOptions,
} from "../executor/types";
import type {
  AgentRouterOptions,
  AgentRoutingRequest,
  AgentRoutingResult,
} from "../router/types";
import type { AgentExecutionResult, AgentId, AgentSource } from "../types";
import type { AgentExecutor } from "../executor";
import type { AgentRegistry } from "../registry";

export type AgentExecutionHandler<Extension extends string = never> = (
  input: AgentExecutionRequest<Extension>,
  headers: Headers,
  executor: AgentExecutor<Extension>,
  registry: AgentRegistry<Extension>,
) => Promise<AgentExecutionResult<unknown, Extension>>;

export type AgentRequestInput = Omit<AgentExecutionRequest, "agentId"> &
  Pick<AgentRoutingRequest, "preferredAgentId">;

export interface AgentServiceOptions<Extension extends string = never> {
  readonly router?: AgentRouterOptions<Extension>;
  readonly executor?: AgentExecutorOptions<Extension>;
  /** Trusted application configuration for agents using structured execution. */
  readonly handlers?: Readonly<Partial<Record<AgentId<Extension>, AgentExecutionHandler<Extension>>>>;
}

export interface AgentRequestSuccess<Extension extends string = never> {
  readonly ok: true;
  readonly agent: { readonly id: AgentId<Extension>; readonly name: string };
  readonly routing: Pick<
    AgentRoutingResult<Extension>,
    "agentId" | "confidence" | "method"
  >;
  readonly response: {
    readonly content: string;
    readonly sources: readonly AgentSource[];
    readonly structuredData?: unknown;
  };
  readonly metadata: NonNullable<AgentExecutionResult["metadata"]> & {
    readonly totalDurationMs: number;
  };
}

export type AgentRequestErrorCode =
  | AIErrorCode
  | AgentExecutionErrorCode
  | "AUTHENTICATION_FAILURE"
  | "AGENT_NOT_ALLOWED"
  | "ROUTING_FAILURE"
  | "INTERNAL_ERROR";

export interface AgentRequestFailure {
  readonly ok: false;
  readonly error: {
    readonly code: AgentRequestErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type AgentRequestResult<Extension extends string = never> =
  | AgentRequestSuccess<Extension>
  | AgentRequestFailure;
