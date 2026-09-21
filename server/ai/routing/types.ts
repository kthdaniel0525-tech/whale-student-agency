import type { AIOperation } from "../usage/types";

export const MODEL_TIERS = ["FAST", "BALANCED", "STRONG", "REASONING"] as const;
export type ModelTier = typeof MODEL_TIERS[number];
export const COMPLEXITY_LEVELS = ["LOW", "MEDIUM", "HIGH", "VERY_HIGH"] as const;
export type TaskComplexity = typeof COMPLEXITY_LEVELS[number];
export const ROUTING_METHODS = ["rule", "historical", "explicit"] as const;
export type ReasoningEffort = "none" | "low" | "medium" | "high";
export type ModelReference = { provider: string; model: string };
export type AIModelDefinition = ModelReference & {
  /** A conservative quality qualification, not a claim of measured equivalence. */
  tiers: ModelTier[];
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  supportsReasoning: boolean;
  supportsEmbeddings: boolean;
  supportsTools: boolean;
  reasoningEfforts: ReasoningEffort[];
  contextWindow: number;
  maxOutputTokens: number;
  relativeCostClass: number;
  latencyClass: number;
  enabled: boolean;
  fallbackModels: ModelReference[];
};
export type RoutingSignals = {
  task?: "classification" | "title" | "extraction" | "transformation" | "reschedule" | "career-strategy";
  requestCharacters?: number;
  actionCount?: number;
  sourceCount?: number;
  ragChunkCount?: number;
  structuredFieldCount?: number;
  reasoningSteps?: number;
  proof?: boolean;
  crossDomain?: boolean;
  ambiguity?: boolean;
  planning?: boolean;
  deadlineCount?: number;
  courseCount?: number;
  calendarConflicts?: boolean;
  semesterStrategy?: boolean;
  repeatedMisunderstanding?: boolean;
  grading?: "short" | "long" | "proof";
};
/** Server-internal hints. No prompts, documents, or user-controlled model IDs. */
export type ModelRoutingHints = {
  /** Explicit server policy. Lower-quality degradation is deliberately unsupported. */
  degradationPolicy?: "none" | "same-tier-only";
  signals?: RoutingSignals;
  requestComplexity?: TaskComplexity;
  qualityCritical?: boolean;
  latencySensitive?: boolean;
  reasoningRequired?: boolean;
  minimumTier?: ModelTier;
};
export type ModelRoutingRequest = ModelRoutingHints & {
  operationType: AIOperation;
  agentId?: string | null;
  workflowId?: string;
  contextTokens: number;
  outputTokens: number;
  requiresStructuredOutput?: boolean;
  requiresStreaming?: boolean;
  requiresTools?: boolean;
  explicitOverride?: { tier?: ModelTier; model?: ModelReference };
};
export type ModelHistory = ModelReference & {
  samples: number;
  failureRate: number;
  averageLatencyMs?: number;
};
export type ModelRoutingDecision = ModelReference & {
  tier: ModelTier;
  complexity: TaskComplexity;
  reasonCode: string;
  /** Rule confidence only; never an invented model quality score. */
  confidence: number;
  routingMethod: typeof ROUTING_METHODS[number];
  fallbackModels: ModelReference[];
  fallbackUsed: boolean;
  qualityFloorTier: ModelTier;
  primary: ModelCandidate;
  fallbackDepth: number;
  fallbackChain: ModelCandidate[];
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
};
export type ModelCandidate = ModelReference & { tier: ModelTier; reasoningEffort: ReasoningEffort; maxOutputTokens: number };
/** Reserved for offline evaluations/feedback. Routing does not invent quality
 * measurements or run shadow calls. An evaluator can join these with usage IDs. */
export type ModelQualityEvidence = ModelReference & {
  evaluationId: string;
  taskFamily: string;
  sampleCount: number;
  assessedAt: string;
  source: "offline-evaluation" | "user-feedback" | "shadow-evaluation";
};
