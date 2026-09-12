import "server-only";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { z } from "zod";
import { getAIConfig, type AIConfig } from "../config";
import { AIError } from "../errors";
import type {
  AIProvider,
  AITextRequest,
  AITextResponse,
  AIStructuredRequest,
  AIStructuredResponse,
  AIStreamRequest,
  AIStreamEvent,
  AIEmbeddingRequest,
  AIEmbeddingResponse,
} from "../types";

const textInput = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().refine((value) => value.trim().length > 0),
      }),
    )
    .min(1),
  model: z.string().trim().min(1).max(200).optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(16).optional(),
});
const embeddingInput = z.object({
  input: z.string().refine((value) => value.trim().length > 0),
  model: z.string().trim().min(1).max(200).optional(),
  dimensions: z.number().int().min(1).max(3072).optional(),
});
const responseSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  status: z.string(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .optional(),
    }),
  ),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
    })
    .nullish(),
});

function readResponse(value: unknown): AITextResponse {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new AIError("INVALID_RESPONSE");
  const response = parsed.data;
  if (response.status === "failed") throw new AIError("PROVIDER_FAILURE");
  if (response.status !== "completed") throw new AIError("INVALID_RESPONSE");
  const content = response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || []);
  if (
    content.some(
      (item) =>
        item.type === "refusal" ||
        (item.type === "output_text" && item.text === undefined),
    )
  )
    throw new AIError("INVALID_RESPONSE");
  const text = content
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
  if (!text.trim()) throw new AIError("INVALID_RESPONSE");
  return {
    id: response.id,
    model: response.model,
    text,
    ...(response.usage
      ? {
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
          },
        }
      : {}),
  };
}

function providerError(error: unknown, signal?: AbortSignal): AIError {
  if (error instanceof AIError) return error;
  if (signal?.aborted || error instanceof OpenAI.APIUserAbortError)
    return new AIError("CANCELLED");
  if (error instanceof SyntaxError) return new AIError("INVALID_RESPONSE");
  if (error instanceof OpenAI.APIError) {
    if (error.code === "invalid_api_key") return new AIError("AUTHENTICATION");
    if (
      error.code === "rate_limit_exceeded" ||
      error.code === "insufficient_quota"
    )
      return new AIError("RATE_LIMIT");
    if (error.status === 401 || error.status === 403)
      return new AIError("AUTHENTICATION");
    if (error.status === 429) return new AIError("RATE_LIMIT");
    if ([400, 404, 422].includes(error.status || 0))
      return new AIError("INVALID_REQUEST");
  }
  return new AIError("PROVIDER_FAILURE");
}

export class OpenAIProvider implements AIProvider {
  readonly #client: OpenAI;
  readonly #config: AIConfig;
  constructor(
    config: AIConfig = getAIConfig(),
    fetcher?: typeof globalThis.fetch,
  ) {
    if (!config.apiKey?.trim()) throw new AIError("CONFIGURATION");
    this.#config = { ...config };
    try {
      this.#client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: "https://api.openai.com/v1",
        timeout: config.timeoutMs,
        maxRetries: 0,
        fetch: fetcher,
      });
    } catch {
      throw new AIError("CONFIGURATION");
    }
  }

  private parameters(request: AITextRequest): ResponseCreateParamsNonStreaming {
    if (request.signal?.aborted) throw new AIError("CANCELLED");
    const parsed = textInput.safeParse(request);
    if (!parsed.success) throw new AIError("INVALID_REQUEST");
    const input = parsed.data;
    const temperature = input.temperature ?? this.#config.temperature;
    return {
      model: input.model ?? this.#config.chatModel,
      input: input.messages,
      max_output_tokens: input.maxOutputTokens ?? this.#config.maxOutputTokens,
      ...(temperature === undefined ? {} : { temperature }),
      store: false,
    };
  }

  async generateText(request: AITextRequest): Promise<AITextResponse> {
    try {
      const response = await this.#client.responses.create(
        this.parameters(request),
        { signal: request.signal },
      );
      return readResponse(response);
    } catch (error) {
      throw providerError(error, request.signal);
    }
  }

  async generateStructuredOutput<T>(
    request: AIStructuredRequest<T>,
  ): Promise<AIStructuredResponse<T>> {
    try {
      const params = this.parameters(request);
      let format;
      try {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.schemaName))
          throw new AIError("INVALID_REQUEST");
        format = zodTextFormat(request.schema, request.schemaName);
        if (format.schema.type !== "object")
          throw new AIError("INVALID_REQUEST");
      } catch {
        throw new AIError("INVALID_REQUEST");
      }
      const raw = await this.#client.responses.create(
        { ...params, text: { format } },
        { signal: request.signal },
      );
      const response = readResponse(raw);
      // JSON Schema is sent to the provider; Zod still validates the returned data locally.
      try {
        const data = await request.schema.parseAsync(JSON.parse(response.text));
        return { ...response, data };
      } catch {
        throw new AIError("INVALID_RESPONSE");
      }
    } catch (error) {
      throw providerError(error, request.signal);
    }
  }

  async *streamText(request: AIStreamRequest): AsyncGenerator<AIStreamEvent> {
    let abort: (() => void) | undefined;
    try {
      const stream = await this.#client.responses.create(
        { ...this.parameters(request), stream: true },
        { signal: request.signal },
      );
      abort = () => stream.controller.abort();
      let text = "";
      for await (const event of stream) {
        if (request.signal?.aborted) throw new AIError("CANCELLED");
        if (event.type === "response.output_text.delta") {
          if (typeof event.delta !== "string")
            throw new AIError("INVALID_RESPONSE");
          text += event.delta;
          yield { type: "text-delta", text: event.delta };
        } else if (event.type === "response.completed") {
          const response = readResponse(event.response);
          if (response.text !== text) throw new AIError("INVALID_RESPONSE");
          yield { type: "complete", response };
          return;
        } else if (event.type === "error" || event.type === "response.failed") {
          throw new AIError("PROVIDER_FAILURE");
        } else if (
          event.type === "response.incomplete" ||
          event.type === "response.refusal.delta" ||
          event.type === "response.refusal.done"
        ) {
          throw new AIError("INVALID_RESPONSE");
        }
      }
      throw new AIError(
        request.signal?.aborted ? "CANCELLED" : "INVALID_RESPONSE",
      );
    } catch (error) {
      throw providerError(error, request.signal);
    } finally {
      abort?.();
    }
  }

  async generateEmbedding(
    request: AIEmbeddingRequest,
  ): Promise<AIEmbeddingResponse> {
    try {
      if (request.signal?.aborted) throw new AIError("CANCELLED");
      const parsed = embeddingInput.safeParse(request);
      if (!parsed.success) throw new AIError("INVALID_REQUEST");
      const input = parsed.data;
      const dimensions = input.dimensions ?? this.#config.embeddingDimensions;
      const response = await this.#client.embeddings.create(
        {
          input: input.input,
          model: input.model ?? this.#config.embeddingModel,
          dimensions,
          encoding_format: "float",
        },
        { signal: request.signal },
      );
      const valid = z
        .object({
          model: z.string().min(1),
          data: z
            .array(
              z.object({
                index: z.literal(0),
                embedding: z.array(z.number().finite()).length(dimensions),
              }),
            )
            .length(1),
        })
        .safeParse(response);
      if (!valid.success) throw new AIError("INVALID_RESPONSE");
      const vector = valid.data.data[0].embedding;
      const norm = Math.hypot(...vector);
      if (!Number.isFinite(norm) || norm < 1e-8)
        throw new AIError("INVALID_RESPONSE");
      return { model: valid.data.model, vector };
    } catch (error) {
      throw providerError(error, request.signal);
    }
  }
}
