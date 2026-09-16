# Notes Agent

The existing Student setup now supplies Notes metadata and short execution
instructions alongside Tutor. No separate executor, RAG pipeline or registry.

```ts
import { createStudentAgentService } from "@/server/agents/student-service";

const service = createStudentAgentService();
const result = await service.handleAgentRequest(
  {
    request: "Make exam review notes from this lecture.",
    preferredAgentId: "notes", // Optional for explicit selection.
    courseId,
    documentIds: [selectedDocumentId],
  },
  request.headers,
);
```

`getStudentAgentDefinitions()` registers the same `notes` ID and minimal
course/documents requirements. The shared capability catalog adds only
extract-key-concepts, extract-definitions and create-review-notes. Profile,
assignments, exams, learning and memory remain disabled. Tutor configuration and
behavior are unchanged. Other Student agents still have metadata only.

## Modes

`NOTES_MODES` defines five short format instructions: summary, structured-notes,
key-concepts, definitions and exam-review (including cheat sheets). The existing
generation call interprets the requested format from the user's text; no extra
classification call, template engine or new public input field is introduced.
An unspecified format defaults to structured-notes. It uses relevant headings for
topic, key idea, concepts, definitions, steps and takeaway, omitting empty sections.

Notes compress material and preserve course terminology, formulas, notation and
important steps. They do not invent exam predictions. Source-specific notes stay
within retrieved passages and must not claim to summarize every page of a document.
If requested lecture/file material is unavailable, instructions require a clear
notice and request for the material rather than fabricated notes. General-topic
notes may use clearly labeled general knowledge.

## Existing pipeline

Student AgentService → existing Router → Executor → authenticated Context Builder
→ existing RAG → AIProvider. The Notes phrase list in the existing Router adds
small hints for key concepts, definitions, review notes, summary and cheat sheets;
conflicting intents retain the existing fallback behavior.

Document IDs and course scope pass unchanged through the core service to Context
Builder. Existing ownership filters, top-k and context limits apply. Notes never
fetches document chunks or embeddings itself. Only retrieved source titles/pages
may be cited; Executor preserves and deduplicates source metadata. Source records
describe the context supplied to the model, not independently verified citations.

Instructions remain below the Executor's 1000-character limit. Generic callers
constructing AgentService or AgentExecutor directly can supply NOTES_INSTRUCTIONS
under the existing `executor.instructions.notes` configuration. No UI, persistent
notes storage, conversation history or additional model settings are added.

## Verification

`tests/notes.test.ts` uses real authentication, PostgreSQL, Context Builder, RAG and
the agent framework; only external model responses are mocked. It checks format
instructions and wiring rather than treating mocked prose as proof of model quality.
Test accounts and document rows are cleaned up; no uploaded files are created.

```sh
npm run test -- tests/notes.test.ts tests/tutor.test.ts tests/agent-router.test.ts tests/agents.test.ts
npm run check -- --incremental false
```


`structured.ts` provides optional `executeStructuredNotes` for guided study workflows. It executes the same Notes agent once through AgentExecutor, returning topics and structured concepts with validated retrieved-source indices. Regular Notes behavior is unchanged; no separate summarizer or topic-extraction call exists.
