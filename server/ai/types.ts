import type { z } from "zod";

export type AIMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AITextRequest = {
  messages: readonly AIMessage[];
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export type AIUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AITextResponse = {
  id: string;
  model: string;
  text: string;
  usage?: AIUsage;
};

export type AIStructuredRequest<T> = AITextRequest & {
  schemaName: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
};
export type AIStructuredResponse<T> = AITextResponse & { data: T };
export type AIStreamRequest = AITextRequest;
export type AIStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "complete"; response: AITextResponse };

export type AIEmbeddingRequest = {
  input: string;
  model?: string;
  dimensions?: number;
  signal?: AbortSignal;
};
export type AIEmbeddingResponse = { model: string; vector: number[] };

export interface AIProvider {
  generateText(request: AITextRequest): Promise<AITextResponse>;
  generateStructuredOutput<T>(
    request: AIStructuredRequest<T>,
  ): Promise<AIStructuredResponse<T>>;
  streamText(request: AIStreamRequest): AsyncIterable<AIStreamEvent>;
  generateEmbedding(request: AIEmbeddingRequest): Promise<AIEmbeddingResponse>;
}

// Existing embedding-only integrations need not implement unsupported chat methods.
export type AIEmbeddingProvider = Pick<AIProvider, "generateEmbedding">;
