import "server-only";
import { z } from "zod";
import { AIError } from "./errors";
import { MODEL_IDS } from "./routing/catalog";

export const AI_DEFAULTS = {
  chatModel: MODEL_IDS.baseline,
  embeddingModel: MODEL_IDS.embedding,
  embeddingDimensions: 1536,
  maxOutputTokens: 2048,
  timeoutMs: 30000,
  reasoningTimeoutMs: 180000,
} as const;

// Persisted RAG vectors depend on this exact model, dimension and preprocessing ID.
const revision = "751bff37182d3f1213fa05d7196b954e230abad9";
export const RAG_EMBEDDING = {
  model: "Xenova/all-MiniLM-L6-v2",
  revision,
  dimensions: 384,
  id: `minilm-l6-v2:${revision}:q8:token200-weighted-mean:v1`,
} as const;

export type AIConfig = {
  apiKey?: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  temperature?: number;
  maxOutputTokens: number;
  timeoutMs: number;
  reasoningTimeoutMs?: number;
};

const schema = z.object({
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  AI_CHAT_MODEL: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .default(AI_DEFAULTS.chatModel),
  AI_EMBEDDING_MODEL: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .default(AI_DEFAULTS.embeddingModel),
  AI_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3072)
    .default(AI_DEFAULTS.embeddingDimensions),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
  AI_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(16)
    .default(AI_DEFAULTS.maxOutputTokens),
  AI_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300000)
    .default(AI_DEFAULTS.timeoutMs),
  AI_REASONING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(AI_DEFAULTS.reasoningTimeoutMs),
});

// Lazy and separate from auth/DB configuration: RAG does not require an OpenAI key.
export function getAIConfig(): AIConfig {
  const result = schema.safeParse(process.env);
  if (!result.success) throw new AIError("CONFIGURATION");
  const env = result.data;
  return {
    apiKey: env.OPENAI_API_KEY,
    chatModel: env.AI_CHAT_MODEL,
    embeddingModel: env.AI_EMBEDDING_MODEL,
    embeddingDimensions: env.AI_EMBEDDING_DIMENSIONS,
    temperature: env.AI_TEMPERATURE,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    timeoutMs: env.AI_TIMEOUT_MS,
    reasoningTimeoutMs: env.AI_REASONING_TIMEOUT_MS,
  };
}
