export const MEMORY_CATEGORIES = [
  "preference",
  "academic-goal",
  "career-goal",
  "learning-pattern",
  "successful-strategy",
  "user-defined",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemorySourceType = "explicit" | "inferred" | "system-derived";
export type MemoryStatus = "candidate" | "active" | "archived";
export type MemoryEvidenceType =
  | "declaration"
  | "behavior"
  | "outcome"
  | "confirmation"
  | "correction";

export type MemoryScalar = string | number | boolean;
export type MemoryValue =
  | MemoryScalar
  | readonly MemoryScalar[]
  | Readonly<Record<string, MemoryScalar | readonly MemoryScalar[]>>;

export type MemoryRecord = {
  readonly id: string;
  readonly category: MemoryCategory;
  readonly key: string;
  readonly value: MemoryValue;
  readonly sourceType: MemorySourceType;
  readonly confidence: number;
  readonly importance: number;
  readonly status: MemoryStatus;
  readonly explanation: string;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly lastUsedAt: string | null;
  readonly stale: boolean;
};

export type ExplicitMemoryInput = {
  readonly category: MemoryCategory;
  readonly key: string;
  readonly value: unknown;
  readonly importance?: number;
  readonly source?: string;
};

/** Trusted server observation. evidenceKey must identify one real event so retries
 * cannot manufacture repeated evidence. */
export type MemoryObservationInput = {
  readonly userId: string;
  readonly category: Exclude<MemoryCategory, "user-defined">;
  readonly key: string;
  readonly observedValue: unknown;
  readonly source: string;
  readonly evidenceKey: string;
  readonly evidenceType: Exclude<MemoryEvidenceType, "declaration">;
  readonly sourceType?: Exclude<MemorySourceType, "explicit">;
  readonly importance?: number;
  readonly observedAt?: Date;
};

export type MemoryRetrievalInput = {
  readonly userId: string;
  readonly request: string;
  readonly categories?: readonly MemoryCategory[];
  readonly keys?: readonly string[];
  readonly limit?: number;
  readonly now?: Date;
  /** Free-text categories use the existing embedding provider when available. */
  readonly semantic?: boolean;
};

export type MemoryEmbeddingOptions = {
  /** null disables semantic work; omitted reuses the existing local RAG provider. */
  readonly embeddingProvider?: import("../ai/types").AIEmbeddingProvider | null;
};

export type MemoryListOptions = {
  readonly category?: MemoryCategory;
  readonly status?: MemoryStatus;
  readonly limit?: number;
};

export type MemoryUpdateInput = {
  readonly value?: unknown;
  readonly importance?: number;
};
