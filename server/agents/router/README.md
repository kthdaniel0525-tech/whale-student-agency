# Agent Router

Selects a registered agent; no execution, personal context, RAG, user-data writes,
or UI. Import separately from the metadata-only registry:

```ts
import { AgentRegistry, getStudentAgentDefinitions } from "@/server/agents";
import { AgentRouter } from "@/server/agents/router";

const registry = new AgentRegistry();
for (const agent of getStudentAgentDefinitions()) registry.register(agent);
const router = new AgentRouter(registry);
const selection = await router.routeAgent({
  request: "Explain mathematical induction",
});
// { agentId: "tutor", confidence: 0.92, method: "rule", reason: ... }
```

1. A valid `preferredAgentId` wins with confidence 1 and method `rule`.
   Unknown or disallowed explicit selections throw typed errors; they never default.
2. One matching English intent rule scores 0.92. Multiple matching intents are
   ambiguous and go to fallback instead of being resolved by registry order.
3. Capability matching derives words from registered capability identifiers;
   no second capability catalog is maintained. All words matching scores 0.86,
   partial matching 0.55. Ties or a lead below 0.15 remain uncertain.
4. The deterministic threshold defaults to 0.8. A server caller can configure
   0.5–1 using `deterministicThreshold`; a unique partial match can then be accepted.
5. Uncertain requests use one structured-output call through `AIProvider`.
   Valid, available IDs with confidence at least 0.5 are accepted. Failed,
   malformed, out-of-range, unknown, or disallowed responses use the default.
6. The default is `academic-manager` (confidence 0.25), provided it is registered
   and allowed. Otherwise `DEFAULT_UNAVAILABLE` is thrown; an arbitrary specialist
   is never substituted. An empty allowed catalog throws `NO_AVAILABLE_AGENTS`.

Confidence values are simple heuristics, not calibrated probabilities. The compact
English rules and capability words do not attempt full semantic or negation
understanding. Other languages or unclear phrasing can use the LLM fallback.

`allowedAgentIds` is an optional server-owned allowlist applied to every layer.
Omitting it allows all registered agents; an empty list allows none. Unknown
allowlist entries or an invalid threshold throw `INVALID_CONFIGURATION`.
The router uses one registry snapshot per request and copies configuration lists.
Authorization policy belongs to the future caller, not to client-submitted options.
Registry extensions work with `new AgentRouter<"custom-agent">(extendedRegistry)`.

`AgentRoutingRequest` accepts only a nonblank request (at most 4000 trimmed
characters) and optional explicit ID. Unknown fields, including full context or
conversation history, are rejected. The fallback receives only the request, agent
IDs, descriptions capped at 160 characters, and up to eight capabilities per agent.
Metadata exceeding 6000 characters skips fallback and uses the same safe default;
agents are never silently removed to shorten the candidate list. Output is capped
at 128 tokens. The model and timeout remain the existing provider configuration.
There are no router-specific environment variables or model names.

The provider factory is imported and initialized lazily. Deterministic routes need
no API key. `getProvider` can inject any existing `AIProvider` implementation.
Fallback schema validation dynamically restricts IDs to the allowed registry
snapshot, checks confidence, and rejects extra fields. Provider errors are not
exposed in routing results. The router never generates the final user answer.

Focused checks:

```sh
npm run test -- tests/agent-router.test.ts tests/agents.test.ts
npm run check -- --incremental false
```
