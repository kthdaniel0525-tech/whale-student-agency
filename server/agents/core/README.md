# Agent Core Integration

`AgentService.handleAgentRequest(input, requestHeaders)` is the single application
entry point for routing and executing one request. It uses the existing registry,
router and executor, without agent-specific branches or a new UI/API endpoint.

```ts
import { AgentRegistry, getStudentAgentDefinitions } from "@/server/agents";
import { AgentService } from "@/server/agents/core";

const registry = new AgentRegistry();
for (const agent of getStudentAgentDefinitions()) registry.register(agent);
const service = new AgentService(registry);

// In a server route/service, pass the actual incoming request's headers.
const result = await service.handleAgentRequest(
  { request: "Explain mathematical induction", courseId },
  request.headers,
);
if (result.ok) {
  // result.agent, result.routing, result.response, result.metadata
} else {
  // result.error contains only code, safe message, and retryable.
}
```

The service verifies the existing Better Auth session before routing, including
before any routing fallback can call AI. It checks the authenticated session's
user ID and captures a copy of the server headers. No client userId is accepted.
The same headers reach Executor/Context Builder, which retain their own session
and ownership checks. This entails two session checks but only one context build;
the entry point does not query profiles, academic records or document content.
Neither check refreshes the session.

Input validation composes the existing router and executor schemas. Input permits
request, preferredAgentId, courseId, documentIds and bounded conversation/turn IDs.
Requests retain the router's 4000-character limit and the Context Builder's narrower
3–1000-character limit when the selected agent retrieves documents. Client context,
options, identity, instructions and message history are rejected. Conversation IDs
are forwarded to the executor without introducing history or persistent storage.

The router receives only the request and optional explicit selection. It remains
responsible for ID validation, allowed-agent filtering, confidence and fallback.
The executor receives the selected ID, request and scope. It alone builds context,
constructs prompts and generates the answer. This layer never calls AIProvider,
loads extra context, appends prompts or retrieves sources separately.

Successful results contain agent ID/name, routing ID/confidence/method, response
content/sources, and the existing executor metadata plus totalDurationMs. Executor
durationMs still measures execution alone; totalDurationMs includes authentication
and routing. Sources are preserved from the executor. No raw prompt/context,
credentials, session IDs, stack traces or provider request IDs are included.

Failures return `{ ok: false, error: { code, message, retryable } }`. Existing
AIError and AgentExecutionError codes are retained; unavailable/default routing
failures become ROUTING_FAILURE. Unknown explicit IDs remain UNKNOWN_AGENT.
Authentication infrastructure failures become AUTHENTICATION_FAILURE, and
unexpected execution errors become INTERNAL_ERROR. Messages are reconstructed
from the existing safe error types or fixed text; raw Error objects are never
returned. Trusted constructor configuration keeps the component constructors'
existing typed errors.

`AgentServiceOptions.router` and `.executor` pass server configuration to the
existing components, including their provider factories. Custom registry IDs work
without service changes. No new logging framework is added; this area has no
shared logging convention and the service logs no user content.

`AgentServiceOptions.handlers` permits trusted per-agent structured handlers.
Each receives the already selected request, captured headers, existing Executor
and Registry. The default remains ordinary Executor execution. A handler must use
that Executor; the core does not run more than one handler or execute recommended
agents. The Student factory registers Academic Manager this way. Successful
responses include optional `response.structuredData` when the handler supplies it.

Focused integration tests use actual authentication, PostgreSQL, Context Builder,
local RAG, Router and Executor. Only AIProvider calls are mocked. Disposable test
accounts and their document rows are removed afterward; no document files are
created. Tests require the existing local DB and prepared embedding cache.

```sh
npm run test -- tests/agent-core.test.ts tests/agent-router.test.ts tests/agent-executor.test.ts
npm run check -- --incremental false
```

Compatibility changes: existing Router/Executor input schemas are exported from
their implementation modules for composition. Their rules, execution behavior and
limits are unchanged. No Context Builder, RAG, auth, database, or AIProvider changes.
