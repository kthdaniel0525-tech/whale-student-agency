# Agent Executor

A server-only pipeline for one selected registered agent:
registry → declared context requirements → authenticated Context Builder → prompt
→ one AIProvider text request → result with retrieved sources. No routing, tools,
academic queries, vector search, data writes, agent-specific behavior, or UI.

```ts
import { AgentRegistry, getStudentAgentDefinitions } from "@/server/agents";
import { AgentExecutor } from "@/server/agents/executor";

const registry = new AgentRegistry();
for (const agent of getStudentAgentDefinitions()) registry.register(agent);
const executor = new AgentExecutor(registry);

// Server route/service: pass the actual incoming request headers, never a userId.
const result = await executor.execute(
  { agentId: "tutor", request: "Explain induction", courseId },
  request.headers,
);
```

## Input and identity

`AgentExecutionRequest` is the public server input; `AgentExecutionInput` remains
the internal prepared-context contract used by the prompt builder. Requests accept
agentId, request, optional courseId/documentIds and optional conversation/turn IDs.
Input is strict: userId, prepared context, context options, execution instructions,
messages and other unknown fields are rejected. Conversation IDs are bounded to
100 characters, not resolved or forwarded to AI. No history is loaded or summarized.

Context Builder verifies the Better Auth session from the supplied server headers,
derives identity, and authorizes all supplied scopes, even if their categories are
disabled. The executor cannot substitute another user or broaden scope after a
failure. Context is built before provider initialization, even for agents declaring
no categories. No public HTTP endpoint or client entry point is added.

The existing Context Builder request constraints and category limits apply,
including its 3–1000-character query limit when documents are enabled. Requirements
are copied by the registry and passed unchanged, including memory keys and limits.
The executor never automatically adds categories or fetches data itself.

## Prompt and extensibility

`buildExecutionPrompt` reuses `formatContextForAI`. Trusted system instructions and
short agent metadata are separate from the user-role reference data and the final
user request. Empty context adds no reference message. This separation helps avoid
promoting retrieved text to system instructions; it is not a guarantee against
prompt injection. No full context is placed in result metadata.

`AgentExecutorOptions.instructions` is an optional server-owned map of agent IDs
to short execution instructions (1–1000 trimmed characters). It is copied at
construction and kept separate from the registry's routing descriptions. No
default student instructions are supplied. Future agents and custom registry IDs
need no executor conditionals. The standalone prompt helper expects prepared
context and trusted, bounded instructions; it is not an authenticated entry point.

The provider comes lazily from the existing factory or an injected `getProvider`.
Only `generateText()` is called once, with existing central model/temperature/token
configuration. No provider-specific types, SDK calls, streaming, retries, or answer
generation outside AIProvider are introduced.

## Results and failures

The existing `AgentExecutionResult` contains selected agentId, content, sources,
model, optional usage, elapsed milliseconds, and categories with nonempty context.
The only shared contract addition is optional `metadata.contextCategories`.

Sources are copied exclusively from Context Builder's document metadata. Repeated
document/chunk/page-span references are deduplicated in retrieval order; distinct
chunks and page ranges remain distinguishable. Source output excludes passage text
and similarity scores. These are references supplied to the model, not a claim
that every source was cited or that the generated prose has been verified.

`AgentExecutionError` covers invalid input/configuration, unknown agents,
unauthenticated requests and context failures. AI errors retain existing safe
`AIError` codes (including authentication/configuration, rate limits, invalid
responses and cancellation). Unknown provider exceptions become `PROVIDER_FAILURE`.
Blank or malformed provider responses become `INVALID_RESPONSE`. Raw database,
provider messages, causes, headers, identity, and raw context are not returned.

Focused validation mocks only Context Builder and AIProvider boundaries, using the
real registry, executor, source handling, prompt formatter and shared validators:

```sh
npm run test -- tests/agent-executor.test.ts tests/agents.test.ts tests/agent-router.test.ts
npm run check -- --incremental false
```
