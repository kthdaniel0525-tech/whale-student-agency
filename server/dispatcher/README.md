# Intelligent Dispatcher

`handleUserAIRequest` is the authenticated server entry point for natural AI requests. It returns either one clarification question or a unified Agent/Workflow result with safe target metadata, confidence, method, and the downstream result. It accepts resource IDs as selection hints but never accepts a user ID or prebuilt context.

Dispatch is layered:

1. A valid explicit Agent or Workflow selection wins with no classification call.
2. A small set of high-signal rules recognizes existing end-to-end Workflows.
3. Selected assignment, document, exam, or topic IDs resolve short contextual requests without loading domain data.
4. Existing `AgentRouter` rules and capability matching select clear single-Agent actions.
5. One structured AIProvider call compares concise registered Agent and Workflow metadata when the intent remains ambiguous.
6. Invalid or low-confidence output never starts a complex Workflow. The dispatcher asks one focused question or falls back to Career Agent for career requests and Academic Manager for other broad requests.

When an Agent is selected, the decision is passed to Agent Core as `preferredAgentId`; Agent Router validates it without making a second model call. Workflow decisions are converted to the existing bounded input contract and passed to `WorkflowService`. Clear career-role wording such as “software engineering internships” is forwarded as a bounded role hint; otherwise the Career workflow reuses its saved role or the dispatcher asks for one. Missing assignment/lecture selections and ambiguous exam/topic selection also produce one focused question. Every downstream service repeats its normal ownership checks. Dispatcher classification receives no profile, deadlines, learning state, RAG passages, conversation history, credentials, raw resource IDs, or raw context.

Thresholds live in `config.ts`. Workflow metadata comes from `createStudentWorkflowRegistry`, which registers the five existing frozen definitions. `tests/intelligent-dispatcher.test.ts` covers the representative Agent/Workflow requests, explicit and contextual routing, structured fallback, hallucinated targets, low confidence, clarification, authentication, unified results, and actual Agent/Workflow execution.

Completed requests also return bounded operational metrics: dispatch, execution and total duration; AI, RAG and attempted workflow-step counts; accumulated prepared-context size; safe success state; and aggregate provider token usage when available. Metrics are isolated per async request and never retain prompts, responses, credentials or provider secrets. A request-local provider instance is reused so Dispatcher fallback and downstream execution cannot create redundant provider clients.
