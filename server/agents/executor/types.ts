import type { AIProvider } from "../../ai/types";
import type {
  ContextOptions,
  ContextRequest,
  UserContext,
} from "../../context/types";
import type { AgentExecutionInput, AgentId } from "../types";
import type { z } from "zod";
import type { ContextReadCache } from "../../context/cache";
import type { PersonalizationProfile } from "../../personalization";
import type { AIEmbeddingProvider } from "../../ai/types";
import type { AdaptiveStrategy } from "../../adaptive";

/** Public server input: identity and prepared context are never client-supplied. */
export type AgentExecutionRequest<Extension extends string = never> = Pick<
  ContextRequest,
  "request" | "courseId" | "examId" | "assignmentId" | "projectIds" | "documentIds"
> & {
  readonly agentId: AgentId<Extension>;
  /** Optional owned conversation whose bounded context is loaded server-side. */
  readonly conversation?: AgentExecutionInput["conversation"];
};

export interface AgentExecutorOptions<Extension extends string = never> {
  readonly contextCache?: ContextReadCache;
  /** Trusted short execution instructions, separate from routing metadata. */
  readonly instructions?: Readonly<Partial<Record<AgentId<Extension>, string>>>;
  readonly getProvider?: () => AIProvider | Promise<AIProvider>;
  /** null disables optional semantic conversation retrieval/embedding. */
  readonly conversationEmbeddingProvider?: AIEmbeddingProvider | null;
}

export interface AgentStructuredExecutionOptions<T> {
  readonly schemaName: string;
  readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Trusted, bounded parameters for this execution; never accepted from clients. */
  readonly directive?: string;
  /** Trusted per-execution context additions, merged with registry requirements. */
  readonly contextOverrides?: Readonly<ContextOptions>;
  /** Builds bounded deterministic parameters from the already-authenticated context. */
  readonly buildDirective?: (
    context: Readonly<UserContext>,
    personalization: Readonly<PersonalizationProfile>,
    adaptiveStrategy: Readonly<AdaptiveStrategy>,
  ) => string | Promise<string>;
  /** Bounded reference data from trusted server orchestration, sent as user data. */
  readonly referenceData?: string;
  readonly maxOutputTokens?: number;
  /** Fail before generation when the selected scope retrieves no document passage. */
  readonly requireDocumentSources?: boolean;
}

export type AgentExecutionErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_CONFIGURATION"
  | "UNKNOWN_AGENT"
  | "UNAUTHENTICATED"
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_FAILURE"
  | "CONTEXT_FAILURE"
  | "SOURCE_CONTEXT_UNAVAILABLE";
