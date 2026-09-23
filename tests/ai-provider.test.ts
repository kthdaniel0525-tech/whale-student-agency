import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AI_DEFAULTS, getAIConfig, type AIConfig } from "@/server/ai/config";
import { AIError } from "@/server/ai/errors";
import { getAIProvider } from "@/server/ai";
import { testGuards } from "./guard-fixture";
import { OpenAIProvider } from "@/server/ai/providers/openai";
import type {
  AIProvider,
  AIStreamEvent,
  AIStructuredRequest,
} from "@/server/ai/types";

const config: AIConfig = { ...AI_DEFAULTS, apiKey: "test-only-key" };
const messages = [
  { role: "user", content: "Explain induction briefly." },
] as const;
const request = { messages };
function response(text = "Start with a base case.") {
  return {
    id: "resp_test",
    object: "response",
    model: "test-chat",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
  };
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function fixture(data: unknown = response(), status = 200) {
  const fetcher = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(json(data, status));
  const provider: AIProvider = new OpenAIProvider(config, fetcher, { guards: testGuards() });
  return { provider, fetcher };
}
function sent(fetcher: ReturnType<typeof fixture>["fetcher"]) {
  return JSON.parse(String(fetcher.mock.calls[0][1]?.body));
}
function streamFixture(events: unknown[]) {
  const { provider, fetcher } = fixture();
  const stream = events
    .map(
      (event) =>
        `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
  fetcher.mockResolvedValue(
    new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
  );
  return { provider, fetcher };
}
async function collect(stream: AsyncIterable<AIStreamEvent>) {
  const events: AIStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
afterEach(() => vi.unstubAllEnvs());

describe("AIProvider through the real OpenAI SDK and a mocked HTTP boundary", () => {
  it("generates text using neutral requests, centralized defaults and normalized usage", async () => {
    const { provider, fetcher } = fixture();
    expect(await provider.generateText(request)).toEqual({
      id: "resp_test",
      model: "test-chat",
      text: "Start with a base case.",
      usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    });
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(sent(fetcher)).toMatchObject({
      model: AI_DEFAULTS.chatModel,
      input: messages,
      max_output_tokens: AI_DEFAULTS.maxOutputTokens,
      store: false,
    });
    expect(sent(fetcher)).not.toHaveProperty("temperature");
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe("Bearer test-only-key");
  });
  it("passes per-request generation settings and preserves zero temperature", async () => {
    const { provider, fetcher } = fixture();
    await provider.generateText({
      ...request,
      model: "configured-model",
      temperature: 0,
      maxOutputTokens: 100,
    });
    expect(sent(fetcher)).toMatchObject({
      model: "configured-model",
      temperature: 0,
      max_output_tokens: 100,
    });
  });
  it("uses JSON Schema on the API boundary and validates typed structured results", async () => {
    const schema = z
      .object({ title: z.string(), count: z.number().int() })
      .strict();
    const typed: AIStructuredRequest<z.infer<typeof schema>> = {
      ...request,
      schemaName: "summary",
      schema,
    };
    const { provider, fetcher } = fixture(
      response('{"title":"Induction","count":2}'),
    );
    const result = await provider.generateStructuredOutput(typed);
    const count: number = result.data.count;
    expect(count).toBe(2);
    expect(result.data.title).toBe("Induction");
    expect(sent(fetcher).text.format).toMatchObject({
      type: "json_schema",
      name: "summary",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "count"],
      },
    });
  });
  it.each(['{"count":"wrong"}', "not JSON", '{"count":1,"extra":true}'])(
    "rejects invalid structured content: %s",
    async (text) => {
      const { provider } = fixture(response(text));
      await expect(
        provider.generateStructuredOutput({
          ...request,
          schemaName: "value",
          schema: z.object({ count: z.number() }).strict(),
        }),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    },
  );
  it("rejects invalid schemas and requests before making an API call", async () => {
    const { provider, fetcher } = fixture();
    await expect(
      provider.generateStructuredOutput({
        ...request,
        schemaName: "bad name!",
        schema: z.object({ value: z.string() }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      provider.generateStructuredOutput({
        ...request,
        schemaName: "value",
        schema: z.string(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(provider.generateText({ messages: [] })).rejects.toMatchObject(
      { code: "INVALID_REQUEST" },
    );
    await expect(
      provider.generateText({ ...request, temperature: NaN }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      provider.generateEmbedding({ input: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { ...response(), status: "incomplete" },
    {
      ...response(),
      output: [
        {
          type: "message",
          content: [{ type: "refusal", refusal: "private refusal content" }],
        },
      ],
    },
    response(""),
    { output: [] },
  ])(
    "rejects incomplete, refused or malformed responses without returning partial text",
    async (body) => {
      const { provider } = fixture(body);
      await expect(provider.generateText(request)).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    },
  );
  it("rejects malformed HTTP JSON as an invalid provider response", async () => {
    const { provider, fetcher } = fixture();
    fetcher.mockResolvedValue(
      new Response("{broken", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(provider.generateText(request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("distinguishes a failed generation from an invalid response", async () => {
    const { provider } = fixture({ ...response(), status: "failed" });
    await expect(provider.generateText(request)).rejects.toMatchObject({
      code: "PROVIDER_FAILURE",
    });
  });
  it("generates float embeddings with explicit dimensions and a neutral response", async () => {
    const vector = [0.6, 0.8, 0];
    const { provider, fetcher } = fixture({
      model: "test-embedding",
      data: [{ index: 0, embedding: vector }],
    });
    expect(
      await provider.generateEmbedding({
        input: "Induction",
        model: "test-embedding",
        dimensions: 3,
      }),
    ).toEqual({ model: "test-embedding", vector });
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://api.openai.com/v1/embeddings",
    );
    expect(sent(fetcher)).toEqual({
      input: "Induction",
      model: "test-embedding",
      dimensions: 3,
      encoding_format: "float",
    });
  });
  it("uses embedding configuration when request overrides are absent", async () => {
    const vector = Array(AI_DEFAULTS.embeddingDimensions).fill(0.1);
    const { provider, fetcher } = fixture({
      model: AI_DEFAULTS.embeddingModel,
      data: [{ index: 0, embedding: vector }],
    });
    expect(
      (await provider.generateEmbedding({ input: "proof" })).vector,
    ).toHaveLength(AI_DEFAULTS.embeddingDimensions);
    expect(sent(fetcher)).toMatchObject({
      model: AI_DEFAULTS.embeddingModel,
      dimensions: AI_DEFAULTS.embeddingDimensions,
    });
  });
  it.each([
    [1, 2],
    [0, 0, 0],
    [1, Infinity, 1],
    [1, "bad", 1],
  ])(
    "rejects wrong-sized, zero or non-finite embedding vectors: %j",
    async (...vector) => {
      const { provider } = fixture({
        model: "test-embedding",
        data: [{ index: 0, embedding: vector }],
      });
      await expect(
        provider.generateEmbedding({ input: "proof", dimensions: 3 }),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    },
  );
  it.each([
    [401, "AUTHENTICATION"],
    [403, "AUTHENTICATION"],
    [429, "RATE_LIMIT"],
    [500, "PROVIDER_FAILURE"],
    [400, "INVALID_REQUEST"],
    [404, "INVALID_REQUEST"],
  ] as const)(
    "normalizes HTTP %i without exposing the raw error",
    async (status, code) => {
      const { provider, fetcher } = fixture(
        {
          error: {
            message: "SECRET upstream credential and prompt",
            type: "api_error",
            code: "internal",
          },
        },
        status,
      );
      const error = await provider
        .generateText(request)
        .catch((error) => error);
      expect(error).toBeInstanceOf(AIError);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("SECRET");
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("headers");
      expect(error.retryable).toBe(
        code === "RATE_LIMIT" || code === "PROVIDER_FAILURE",
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [429, "rate_limit_exceeded", "RATE_LIMIT", "rate-limit"],
    [503, "server_is_overloaded", "PROVIDER_FAILURE", "overloaded"],
    [400, "context_length_exceeded", "CONTEXT_TOO_LARGE", "context-too-large"],
    [400, "unsupported_parameter", "UNSUPPORTED_CAPABILITY", "unsupported-capability"],
  ])("normalizes recovery metadata for HTTP %i %s", async (status, code, expected, kind) => {
    const { provider, fetcher } = fixture();
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { code, message: "SECRET" } }), { status: Number(status), headers: { "content-type": "application/json", "retry-after": "120" } }));
    const error = await provider.generateText(request).catch(e => e);
    expect(error.code).toBe(expected);
    if (Number(status) !== 400) expect(error.failure).toMatchObject({ kind, retryAfterMs: 120000 });
    expect(error.message).not.toContain("SECRET"); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("normalizes network errors", async () => {
    const { provider, fetcher } = fixture();
    fetcher.mockRejectedValue(Error("SECRET network details"));
    await expect(
      provider.generateEmbedding({ input: "proof" }),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
  });
  it("streams normalized deltas and a completed response", async () => {
    const { provider, fetcher } = streamFixture([
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Base " },
      { type: "response.output_text.delta", delta: "case" },
      { type: "response.completed", response: response("Base case") },
    ]);
    const events = await collect(provider.streamText(request));
    expect(events).toEqual([
      { type: "text-delta", text: "Base " },
      { type: "text-delta", text: "case" },
      {
        type: "complete",
        response: expect.objectContaining({ text: "Base case" }),
      },
    ]);
    expect(sent(fetcher)).toMatchObject({ stream: true, store: false });
  });
  it.each([
    [
      [{ type: "response.output_text.delta", delta: "Partial" }],
      "INVALID_RESPONSE",
    ],
    [[{ type: "response.incomplete" }], "INVALID_RESPONSE"],
    [
      [{ type: "response.refusal.delta", delta: "private refusal" }],
      "INVALID_RESPONSE",
    ],
    [[{ type: "response.failed" }], "PROVIDER_FAILURE"],
    [
      [{ type: "error", message: "SECRET upstream failure" }],
      "PROVIDER_FAILURE",
    ],
  ] as const)(
    "surfaces terminal stream errors rather than silently completing",
    async (events, code) => {
      const { provider } = streamFixture([...events]);
      await expect(collect(provider.streamText(request))).rejects.toMatchObject(
        { code },
      );
    },
  );
  it("rejects truncated streams whose final response disagrees with deltas", async () => {
    const { provider } = streamFixture([
      { type: "response.output_text.delta", delta: "Missing " },
      { type: "response.completed", response: response("Missing words") },
    ]);
    await expect(collect(provider.streamText(request))).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("normalizes a rate-limit error received in the event stream", async () => {
    const { provider } = streamFixture([
      {
        type: "error",
        code: "rate_limit_exceeded",
        message: "SECRET upstream details",
      },
    ]);
    await expect(collect(provider.streamText(request))).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });
  });
  it("cancels a stream when its consumer stops early", async () => {
    const { provider, fetcher } = streamFixture([
      { type: "response.output_text.delta", delta: "First" },
      { type: "response.output_text.delta", delta: "Second" },
    ]);
    for await (const event of provider.streamText(request)) {
      expect(event.type).toBe("text-delta");
      break;
    }
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("respects cancellation before making a request and during streaming", async () => {
    const signal = AbortSignal.abort();
    const { provider, fetcher } = fixture();
    await expect(
      provider.generateText({ ...request, signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      provider.generateEmbedding({ input: "proof", signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      collect(provider.streamText({ ...request, signal })),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const active = streamFixture([
      { type: "response.output_text.delta", delta: "First" },
      { type: "response.output_text.delta", delta: "Second" },
    ]);
    const iterator = active.provider
      .streamText({ ...request, signal: controller.signal })
      [Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("central AI configuration", () => {
  it("constructs the registry lazily but rejects a missing key when the adapter is requested", () => {
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(() => getAIConfig()).not.toThrow();
    expect(() => getAIProvider()).not.toThrow();
    expect(() => new OpenAIProvider()).toThrow(
      expect.objectContaining({ code: "CONFIGURATION" }),
    );
  });
  it("loads validated server-side overrides", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("AI_CHAT_MODEL", "custom-chat");
    vi.stubEnv("AI_EMBEDDING_MODEL", "custom-embedding");
    vi.stubEnv("AI_EMBEDDING_DIMENSIONS", "384");
    vi.stubEnv("AI_TEMPERATURE", "0");
    vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "500");
    expect(getAIConfig()).toMatchObject({
      apiKey: "test-key",
      chatModel: "custom-chat",
      embeddingModel: "custom-embedding",
      embeddingDimensions: 384,
      temperature: 0,
      maxOutputTokens: 500,
    });
  });
  it.each([
    ["AI_TEMPERATURE", "3"],
    ["AI_EMBEDDING_DIMENSIONS", "-1"],
    ["AI_MAX_OUTPUT_TOKENS", "bad"],
    ["AI_TIMEOUT_MS", "0"],
  ])("rejects invalid %s without leaking env values", (key, value) => {
    vi.stubEnv("OPENAI_API_KEY", "SECRET-key");
    vi.stubEnv(key, value);
    expect(() => getAIConfig()).toThrow(
      expect.objectContaining({ code: "CONFIGURATION" }),
    );
    try {
      getAIConfig();
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-key");
    }
  });
});
