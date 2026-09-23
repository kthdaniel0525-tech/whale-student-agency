import "server-only";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { z } from "zod";
import { AI_DEFAULTS, getAIConfig, type AIConfig } from "../config";
import { AIError } from "../errors";
import { trackAIProvider, markTrackedProvider, type UsageTrackingOptions } from "../usage/tracking";
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
  reasoningEffort: z.enum(["none", "low", "medium", "high"]).optional(),
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
      input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).nullish(),
      output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).nullish(),
    })
    .nullish(),
});

function responseUsage(value: unknown) {
  const data = z.object({ model: z.string().optional(), usage: responseSchema.shape.usage }).safeParse(value);
  if (!data.success || !data.data.usage) return undefined;
  const usage = data.data.usage;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined ? { cachedInputTokens: usage.input_tokens_details.cached_tokens } : {}),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens } : {}),
  };
}
function readResponse(value: unknown): AITextResponse {
  try { return validateResponse(value); }
  catch (error) {
    const model = z.object({ model: z.string() }).safeParse(value);
    throw new AIError(error instanceof AIError ? error.code : "INVALID_RESPONSE", responseUsage(value), model.success ? model.data.model : undefined);
  }
}
function validateResponse(value: unknown): AITextResponse {
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
          usage: responseUsage(value),
        }
      : {}),
  };
}

function providerError(error: unknown, signal?: AbortSignal): AIError {
  if (signal?.aborted) return signal.reason instanceof AIError ? signal.reason : new AIError("CANCELLED");
  if (error instanceof AIError) return error;
  if (error instanceof OpenAI.APIUserAbortError) return new AIError("CANCELLED");
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new AIError("TIMEOUT");
  if (error instanceof SyntaxError) return new AIError("INVALID_RESPONSE");
  if (error instanceof OpenAI.APIError) {
    const raw = error.headers?.get("retry-after");
    const retryAfterMs = raw ? (/^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : undefined;
    const delay = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {};
    if (error.code === "invalid_api_key" || error.status === 401 || error.status === 403) return new AIError("AUTHENTICATION");
    if (error.code === "context_length_exceeded") return new AIError("CONTEXT_TOO_LARGE");
    if (error.code === "unsupported_parameter" || error.code === "unsupported_value") return new AIError("UNSUPPORTED_CAPABILITY");
    if (error.status === 429 || ["rate_limit_exceeded", "insufficient_quota"].includes(error.code ?? ""))
      return new AIError("RATE_LIMIT", undefined, undefined, { kind: "rate-limit", scope: "provider", ...delay });
    if (error.status === 503 || error.code === "server_is_overloaded")
      return new AIError("PROVIDER_FAILURE", undefined, undefined, { kind: "overloaded", scope: "model", ...delay });
    if ([400, 404, 422].includes(error.status || 0)) return new AIError("INVALID_REQUEST");
  }
  return new AIError("PROVIDER_FAILURE");
}

/** JSON Schema cannot express custom refinements. Send its underlying shape;
 * the original Zod schema still validates every result below. Transform effects
 * remain unsupported so the wire shape cannot silently differ from its input. */
function wireSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodString) return new z.ZodString({ ...schema._def, checks: schema._def.checks.filter(check => !["trim", "toLowerCase", "toUpperCase"].includes(check.kind)) });
  if (schema instanceof z.ZodEffects && schema._def.effect.type === "refinement") return wireSchema(schema.innerType());
  if (schema instanceof z.ZodObject) return schema.extend(Object.fromEntries(Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(([key, value]) => [key, wireSchema(value)])));
  if (schema instanceof z.ZodArray) return new z.ZodArray({ ...schema._def, type: wireSchema(schema.element) });
  if (schema instanceof z.ZodNullable) return new z.ZodNullable({ ...schema._def, innerType: wireSchema(schema.unwrap()) });
  if (schema instanceof z.ZodOptional) return new z.ZodOptional({ ...schema._def, innerType: wireSchema(schema.unwrap()) });
  if (schema instanceof z.ZodUnion) return new z.ZodUnion({ ...schema._def, options: schema.options.map(wireSchema) });
  return schema;
}

class OpenAITransport implements AIProvider {
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
    const reasoning = input.reasoningEffort && input.reasoningEffort !== "none" ? input.reasoningEffort : undefined;
    const temperature = reasoning ? undefined : input.temperature ?? this.#config.temperature;
    return {
      model: input.model ?? this.#config.chatModel,
      input: input.messages,
      max_output_tokens: input.maxOutputTokens ?? this.#config.maxOutputTokens,
      ...(temperature === undefined ? {} : { temperature }),
      ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
      store: false,
    };
  }

  private callOptions(request: AITextRequest) {
    return { signal: request.signal, ...(request.timeoutMs ? { timeout: request.timeoutMs } : request.reasoningEffort && request.reasoningEffort !== "none"
      ? { timeout: this.#config.reasoningTimeoutMs ?? AI_DEFAULTS.reasoningTimeoutMs } : {}) };
  }

  async generateText(request: AITextRequest): Promise<AITextResponse> {
    try {
      const response = await this.#client.responses.create(
        this.parameters(request),
        this.callOptions(request),
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
        format = zodTextFormat(wireSchema(request.schema), request.schemaName);
        if (format.schema.type !== "object")
          throw new AIError("INVALID_REQUEST");
      } catch {
        throw new AIError("INVALID_REQUEST");
      }
      const raw = await this.#client.responses.create(
        { ...params, text: { format } },
        this.callOptions(request),
      );
      const response = readResponse(raw);
      // JSON Schema is sent to the provider; Zod still validates the returned data locally.
      try {
        const data = await request.schema.parseAsync(JSON.parse(response.text));
        return { ...response, data };
      } catch {
        throw new AIError("INVALID_RESPONSE", response.usage, response.model);
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
        this.callOptions(request),
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
          if (response.text !== text) throw new AIError("INVALID_RESPONSE", response.usage, response.model);
          yield { type: "complete", response };
          return;
        } else if (event.type === "error" || event.type === "response.failed") {
          throw new AIError("PROVIDER_FAILURE", event.type === "response.failed" ? responseUsage(event.response) : undefined, event.type === "response.failed" ? event.response?.model : undefined);
        } else if (
          event.type === "response.incomplete" ||
          event.type === "response.refusal.delta" ||
          event.type === "response.refusal.done"
        ) {
          throw new AIError("INVALID_RESPONSE", event.type === "response.incomplete" ? responseUsage(event.response) : undefined, event.type === "response.incomplete" ? event.response?.model : undefined);
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
    let reportedUsage: AIEmbeddingResponse["usage"];
    let reportedModel: string | undefined;
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
        { signal: request.signal, ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}) },
      );
      reportedModel = response.model;
      const tokens = z.object({ prompt_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }).safeParse(response.usage);
      if (tokens.success) reportedUsage = { inputTokens: tokens.data.prompt_tokens, outputTokens: 0, totalTokens: tokens.data.total_tokens };
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
      return { model: valid.data.model, vector, ...(reportedUsage ? { usage: reportedUsage } : {}) };
    } catch (error) {
      const failure = providerError(error, request.signal);
      throw new AIError(failure.code, reportedUsage, reportedModel, failure.failure);
    }
  }
}

/** All construction paths, including direct SDK-boundary tests, use accounting. */
export class OpenAIProvider implements AIProvider {
  readonly #provider: AIProvider;
  constructor(config: AIConfig = getAIConfig(), fetcher?: typeof globalThis.fetch,
    tracking: Pick<UsageTrackingOptions, "write" | "clock" | "pricing" | "guards" | "allowances"> = {}) {
    markTrackedProvider(this);
    this.#provider = trackAIProvider(new OpenAITransport(config, fetcher), { ...tracking, provider: "openai", chatModel: config.chatModel, embeddingModel: config.embeddingModel, maxOutputTokens: config.maxOutputTokens });
  }
  generateText(request: AITextRequest) { return this.#provider.generateText(request); }
  generateStructuredOutput<T>(request: AIStructuredRequest<T>) { return this.#provider.generateStructuredOutput(request); }
  streamText(request: AIStreamRequest) { return this.#provider.streamText(request); }
  generateEmbedding(request: AIEmbeddingRequest) { return this.#provider.generateEmbedding(request); }
}
