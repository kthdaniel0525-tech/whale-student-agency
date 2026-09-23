# Tutor Agent

Tutor is the first specialized Student agent. Its short routing metadata is part
of the existing `getStudentAgentDefinitions()` setup. Its execution instructions
remain separate and are wired through the existing Executor configuration:

```ts
import { createStudentAgentService } from "@/server/agents/student-service";

const service = createStudentAgentService();
const result = await service.handleAgentRequest(
  {
    request: "Explain mathematical induction using my lecture notes.",
    courseId,
    documentIds,
    // Optional: preferredAgentId: "tutor"
  },
  request.headers,
);
```

The factory configures one existing AgentRegistry and returns the existing
AgentService. The complete path remains authentication → Router → Executor →
Context Builder → AIProvider. It introduces no separate Tutor service, retrieval
pipeline or registry implementation. Generic callers constructing AgentService
or AgentExecutor directly can pass `{ instructions: { tutor: TUTOR_INSTRUCTIONS } }`
as their executor configuration. Server-owned factory options retain provider,
routing, and instruction overrides. Client-supplied instructions remain rejected.

## Teaching behavior

The instruction stays under 1000 characters and favors accurate, proportionate explanations, useful
steps and small examples, and guidance through mistakes. It adapts to the profile's
explanation difficulty: simpler language/examples for BEGINNER and concise rigor
for ADVANCED. Program/year and available learning context are used only when useful;
the model is instructed not to repeat the profile or invent weak topics. The
explanation/example/takeaway structure is a suggestion, not a fixed response form.
Vague questions without a concept or attempted answer call for clarification;
when an owned conversation ID is supplied, shared recent/summary/retrieval context
can resolve follow-up references without Tutor-specific storage.

Course-specific requests prioritize the retrieved course framing and distinguish
it from general knowledge, including where those accounts differ. If requested
lecture/document context is missing or ambiguous, the instructions require an
honest notice and a clarification, with clearly labeled general guidance if useful.
General academic questions do not require a course selection. Ordinary homework
can receive reasoning, hints or appropriate solutions. No separate assessment
policy engine or unnecessary homework restrictions are added.

## Context and sources

The exact requirements remain profile, course, documents and learning. Assignments,
exams and memories are disabled. Learning is still optional/unavailable under the
existing Context Builder; there is no progress engine. A request without selected
scope may retrieve relevant material from the authenticated user's library under
the existing RAG behavior; selecting course/document IDs narrows that scope.

Existing top-k, query and context size limits apply unchanged. Only Context Builder
retrieves data. Each passage appears through the existing formatter once, and
Executor preserves document/chunk/page provenance and deduplicates source records.
Sources describe the material supplied to the model; they do not independently
verify every generated claim. Tutor instructions permit only supplied source titles
and pages and never contain fabricated document/page examples.

Other agents are configured separately through the same Student setup. Conversation
continuity is provided by the shared Executor layer; this Tutor module adds no
agent-specific history store, chat UI, workflows, or model configuration.

## Verification

```sh
npm run test -- tests/tutor.test.ts
npm run check -- --incremental false
```

Tutor tests use the real framework, authenticated Context Builder, local DB and RAG,
mocking only external AIProvider responses. They verify the teaching instruction
contract, actual selected context, source handling and end-to-end wiring. They do
not claim to measure live model explanation quality or guarantee perfect citation
behavior. Disposable fixtures are removed; no document files are created.
