# Core AI provider foundation

Server-side code imports `AIProvider` and request/response types from `server/ai`, then calls `getAIProvider()`. The only full provider implementation is `OpenAIProvider`. SDK imports and wire-format mappings stay inside `providers/openai.ts`. This module adds no routes, UI, agents, workflow execution or memory.

```ts
import { getAIProvider } from "@/server/ai";
import { z } from "zod";

const ai = getAIProvider();
const messages = [
  { role: "user" as const, content: "Explain mathematical induction." },
];
const answer = await ai.generateText({ messages });
const structured = await ai.generateStructuredOutput({
  messages,
  schemaName: "explanation",
  schema: z.object({ explanation: z.string() }).strict(),
});
for await (const event of ai.streamText({ messages })) {
  // text-delta carries incremental text; complete carries the final response and usage.
}
const embedding = await ai.generateEmbedding({
  input: "mathematical induction",
});
```

All requests accept an optional `AbortSignal`. Text requests accept optional model, temperature and output-token overrides. Structured output uses a Zod object schema: it is converted to strict JSON Schema, then returned JSON is independently parsed and validated with the original Zod schema. Use the provider's supported JSON Schema subset; unsupported root schemas are rejected before the API request. Refusals, incomplete text, malformed JSON and invalid vectors do not return successful data.

`streamText` emits provider-neutral `text-delta` and `complete` events. It reports failed/truncated streams, validates final text, and aborts the underlying stream when a consumer stops early. Partial deltas may already have been consumed before a later error; consumers should regard `complete` as the success marker.

`AIError` exposes a safe message, category and retryable flag. Categories are CONFIGURATION, AUTHENTICATION, RATE_LIMIT, PROVIDER_FAILURE, INVALID_REQUEST, INVALID_RESPONSE and CANCELLED. Raw SDK errors, headers, provider messages and causes are not forwarded. Responses use `store: false`; the SDK uses a configured request timeout and no automatic retries. Callers decide whether to retry. The SDK timeout is not a total wall-clock deadline for consuming a stream; callers can supply a deadline via `AbortSignal.timeout(...)`.

## Configuration

`config.ts` reads validated server environment variables lazily, separately from existing authentication/database configuration. No client component imports configuration or credentials.

- `OPENAI_API_KEY`: required when `getAIProvider()` or `OpenAIProvider` is used. Existing local RAG does not require it.
- `AI_CHAT_MODEL`: defaults to `gpt-4.1-mini`.
- `AI_EMBEDDING_MODEL`: defaults to `text-embedding-3-small`.
- `AI_EMBEDDING_DIMENSIONS`: defaults to 1536.
- `AI_TEMPERATURE`: omitted unless configured; leave unset for models that do not support it.
- `AI_MAX_OUTPUT_TOKENS`: defaults to 2048.
- `AI_TIMEOUT_MS`: defaults to 30000.

The provider is initialized on first use and reused. Restart the server after changing configuration. `.env.example` documents optional settings; real secrets are never written by this change.

## RAG compatibility

`server/documents/embeddings/index.ts` now implements the embedding capability of `AIProvider` (`Pick<AIProvider, "generateEmbedding">`). Its existing `embeddingProvider.generateEmbedding(text)` entry point is a thin adapter to that method; there is exactly one local inference implementation.

The local MiniLM model, pinned revision, 384 dimensions, 200-token windows, normalization and persisted model ID are unchanged. Their identifiers are centralized in `RAG_EMBEDDING` in `config.ts`. Existing retrieval, processor, database schema, vectors and caller signatures are unchanged. No reindex or migration is needed. The local capability does not implement unsupported chat methods and never initializes OpenAI or reads its configuration.

OpenAI embedding configuration does **not** switch existing document search to OpenAI. Its default 1536-dimensional vectors are a different model space and must not be inserted into the current 384-dimensional RAG store. A future model migration must explicitly reindex even if dimensions match.

## Focused verification

```sh
npm run check
npm run test -- tests/ai-provider.test.ts tests/ai-rag-compatibility.test.ts
```

Provider tests use the actual OpenAI SDK and implementation, mocking only HTTP fetch. They exercise neutral interface usage, text/structured output, schema validation, streaming, cancellation, embeddings, configuration and sanitized errors. No live OpenAI calls or paid generation are made. The compatibility test uses the already-prepared local model and compares both entry points' actual vectors; it requires the existing model cache (`npm run embeddings:prepare` if not previously prepared). No database or running web server is required, and unrelated application suites are not run.

Changed files: `server/ai/{types,config,errors,index}.ts`, `server/ai/providers/openai.ts`, this README, `server/documents/embeddings/index.ts`, `.env.example`, `package.json`, `package-lock.json`, `tests/ai-provider.test.ts`, and `tests/ai-rag-compatibility.test.ts`. The only new dependency is the official `openai@7.15.0` SDK.

API behavior was checked against official OpenAI documentation for [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses) and [embeddings](https://developers.openai.com/api/docs/guides/embeddings), together with the installed SDK types.
