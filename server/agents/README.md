# Agent contract and registry

This server module describes planned agents. It contains no prompts, executable
agents, routing, context loading, AI calls, persistence, or automatic registration.

```ts
import { AgentRegistry, getStudentAgentDefinitions } from "@/server/agents";

const registry = new AgentRegistry(); // Starts empty.
for (const agent of getStudentAgentDefinitions()) registry.register(agent);

const tutor = registry.get("tutor");
const requirements = tutor.contextRequirements; // Assignable to existing ContextOptions.
```

- `register(agent)` stores a detached metadata snapshot; duplicate IDs throw
  `AgentRegistryError` with code `DUPLICATE_AGENT` and the conflicting `agentId`.
- `get(id)` returns a snapshot or throws `AGENT_NOT_FOUND`.
- `has(id)` checks membership.
- `list()` returns snapshots in registration order, including an empty list for
  a new registry.
- `getByCapability(capability)` returns all matching metadata in registration
  order. It does not select an agent for a request.

Metadata fields and capabilities are read-only and frozen. Nested context arrays
and limits remain compatible with `ContextOptions`, but are copied on every
registration and read. Changing those copies cannot change stored definitions.
Caller-owned input objects are never frozen or modified.

`AgentId` defaults to the six `STUDENT_AGENT_IDS`. Extend it explicitly with
`AgentId<"custom-agent">`, `Agent<"custom-agent">`, and
`new AgentRegistry<"custom-agent">()` without changing registry code. The default
registry rejects undeclared IDs at compile time. These are internal TypeScript
contracts, not validators for arbitrary JSON from clients.

`getStudentAgentDefinitions()` provides metadata for academic-manager, tutor,
notes, quiz, study-planner, and career. Nothing is registered at import time.
Requirements use the existing `memories` option name and explicit allowlisted
`memoryKeys`. `learning: true` only declares a need; availability and ownership
remain the Context Builder's responsibility.

`AgentExecutionInput` carries the request, existing `UserContext`, and optional
conversation/turn IDs. `AgentExecutionResult<T>` carries content, the agent ID,
optional typed structured data, source references derived from `DocumentContext`,
and optional usage/model/duration metadata. The usage type is reused via a
type-only import. No AIProvider or Context Builder implementation is imported.

Validation: `npm run test -- tests/agents.test.ts` and
`npm run check -- --incremental false`.
