import { z } from "zod";
export const EVALUATION_TYPES = ["deterministic", "rule-based", "reference-based", "model-based", "user-feedback", "regression"] as const;
export const PROFILE_IDS = ["tutor", "notes", "quiz", "grading", "study-planner", "academic-manager", "career", "dispatcher", "model-router", "rag-retrieval", "rag-generation", "workflow", "continuity", "personalization", "adaptive"] as const;
export const DIMENSIONS = ["correctness", "relevance", "groundedness", "completeness", "clarity", "personalization", "actionability", "structuralValidity", "routingAccuracy", "planningQuality", "gradingReliability", "sourceFaithfulness"] as const;
export const FAILURE_CODES = ["INCORRECT", "UNGROUNDED", "WRONG_SOURCE", "INCOMPLETE", "IRRELEVANT", "OVERLY_VERBOSE", "TOO_SHALLOW", "WRONG_DIFFICULTY", "INVALID_STRUCTURE", "BAD_ROUTING", "UNREALISTIC_PLAN", "FABRICATED_DATA"] as const;
export type Dimension = typeof DIMENSIONS[number];
export type ProfileId = typeof PROFILE_IDS[number];
export type FailureCode = typeof FAILURE_CODES[number];
export const scoreSchema = z.number().finite().min(0).max(1);
export const dimensionsSchema = z.record(z.enum(DIMENSIONS), scoreSchema);
export const resultSchema = z.object({
  profile: z.enum(PROFILE_IDS), evaluationType: z.enum(EVALUATION_TYPES), evaluatorVersion: z.string().min(1).max(100),
  score: scoreSchema.nullable(), passed: z.boolean().nullable(), dimensions: dimensionsSchema,
  failures: z.array(z.enum(FAILURE_CODES)).max(20), unmeasured: z.array(z.enum(DIMENSIONS)).max(20),
  metrics: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,70}$/), z.number().finite()).default({}),
  checks: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,100}$/), dimension: z.enum(DIMENSIONS), score: scoreSchema, failure: z.enum(FAILURE_CODES).optional() }).strict()).max(100),
}).strict();
export type EvaluationResult = z.infer<typeof resultSchema>;
export type Source = { id: string; documentId: string; chunkIndex: number; content: string; courseId?: string | null };
/** Ephemeral evaluator input. Text/references never enter evaluation records.
 * Expected properties are trusted fixtures/server facts, never output claims. */
export type EvaluationContext = {
  profile: ProfileId; request: string; output: unknown; text?: string;
  sources?: Source[]; citedSourceIds?: string[]; requestedSourceIds?: string[]; requiresGrounding?: boolean;
  expected?: {
    format?: "bullets" | "json"; maxWords?: number; requiredTerms?: string[]; forbiddenTerms?: string[];
    acceptableTargets?: Array<{ type: "agent" | "workflow" | "clarification"; id?: string }>;
    relevantChunkIds?: string[]; k?: number; correct?: boolean; scoreRange?: [number, number];
    minimumTier?: "FAST" | "BALANCED" | "STRONG" | "REASONING"; questionType?: "multiple-choice" | "true-false" | "short-answer" | "long-answer" | "mixed"; questionCount?: number; difficulty?: "easy" | "medium" | "hard";
    availability?: Array<{ date: string; availableMinutes: number }>;
    deadlines?: Record<string, string>; busyIntervals?: Array<{ start: string; end: string }>;
    completedTaskIds?: string[]; maxSessionMinutes?: number; weakSignalIds?: string[]; strongSignalIds?: string[];
    urgentIds?: string[]; allowedIds?: string[]; allowedNumbers?: string[]; facts?: Record<string, unknown>;
    maximumCalls?: number; maximumTutorCalls?: number; maximumQuizCalls?: number; expectedStatus?: string;
  };
};
export type EvaluationVersions = { datasetVersion: string; promptVersion: string; routingVersion: string; contextVersion: string };
