# Workflow Engine Foundation

This server-only module adds explicit, user-initiated orchestration. The production workflows are `exam-preparation`, `weak-topic-recovery`, `lecture-study`, `assignment-support`, and `career-preparation`. Single-agent requests continue through the existing Agent Core; no universal workflow router, scheduler, background worker or external tool execution is added.

## Entry points

```ts
import { WorkflowService } from "@/server/workflows";

const workflows = new WorkflowService();
const result = await workflows.runWorkflow({
  workflowId: "exam-preparation",
  goal: "Help me prepare for my MATH midterm.",
  examId, // Recommended. Otherwise one unambiguous upcoming exam is required.
  courseId, // Optional; must match the exam when supplied.
  conversationId, // Optional owned ongoing conversation.
  availability: [{ date: "2026-09-14", availableMinutes: 120 }], // Optional.
}, request.headers);

const status = await workflows.getRun(result.runId, request.headers);
await workflows.cancelRun(result.runId, request.headers);
```

The public service derives identity from the authenticated session. It rejects frontend userId, prepared context, dynamic steps and unknown workflow IDs. Optional `studyPlanId`, `quizId` and `documentIds` are checked for ownership and scope before generation. Requests are limited to upcoming exams within 90 days; ambiguous exam selection produces a safe error instead of guessing. Goals are bounded to 1,000 characters, selected documents to 10, and availability to 91 dates. Planning dates use the profile timezone.

## Coordination and decisions

The registered definition contains metadata, typed agent IDs, input mappings, code-based conditions, output keys and failure policies. Its frozen steps cannot be dynamically extended by a model response. The engine is the only coordinator; agents do not call each other.

1. **Academic Manager** uses the existing structured execution handler to analyze current academic state. The workflow reuses Learning Context to retain exact exam-topic evidence, including mastery, confidence, recent accuracy and trends. The model does not choose workflow steps.
2. **Study Planner** creates a missing plan or updates a stale relevant plan through its existing persistence service. It skips generation when the active plan still matches the exam date, has remaining sessions, has no missed work, fits supplied availability and has no newer practice evidence or material mastery/confidence change. Exam-scoped updates preserve completed work and other exams' future sessions, reserving their time.
3. **Diagnostic Quiz** runs before Tutor when an exam topic is unpracticed, has fewer than three answers or confidence below 40. It generates five mixed questions, without assuming low mastery.
4. **Tutor** explains a demonstrated weak topic when mastery is below 70, confidence is at least 60 and at least three answers exist. Declining topics receive extra priority. A diagnostic for an unknown topic does not suppress useful explanation of a different, well-established weakness.
5. **Practice Quiz** runs instead of the diagnostic when evidence supports practice. It uses adaptive difficulty, targeting weak topics or exam coverage with retention checks.

Only one Quiz generation branch runs. A matching recent unfinished quiz is reused, including a partially answered quiz whose own answers account for the latest learning evidence. A completed or irrelevant quiz does not suppress useful new practice. Generated questions must cover the selected target topics.

Manager and Tutor use Agent Core; Planner and Quiz use their existing domain services. Every generation still runs through AgentExecutor and AIProvider. The engine never calls OpenAI directly. Academic deadlines and planning signals are not reimplemented.

## Context and outputs

`WorkflowContext` holds the bounded goal, selected exam/course, availability, ranked learning evidence, plan/quiz IDs and short prior-step summaries. It does not forward complete agent responses between steps. Tutor explanation is retained in the result up to 6,000 characters with an explicit truncation flag; later steps receive the selected topic rather than a copy of that explanation. Plan output contains an ID and at most five next tasks. Quiz output contains an ID, target topics and question count; answers remain in the existing Quiz service.

An optional owned `conversationId` is persisted in `WorkflowContext` and passed to
the shared AgentExecutor for continuity. `WorkflowRun.context` remains authoritative
for current step, status, quiz/plan references and pending input. Drafts and quiz
answers submitted after a wait are appended as visible conversation input, while
resume decisions never infer state from a conversation summary.

The optional server-only `ContextReadCache` reuses compatible category reads during one short workflow. Every cache hit still passes authentication and scope checks; keys include the authenticated owner and relevant scope. Entries expire after 60 seconds, are cloned before use, and are limited to 64 entries. Learning context can reuse a larger already-loaded summary. Planner operations invalidate academic-overview state. Quiz operations invalidate learning and overview state even when an operation fails after a possible write. Subsequent reads therefore refresh changed aggregates. No cache or raw prepared context is accepted from the frontend.

Document retrieval remains optional: Manager/Planner do not require it, and Tutor/Quiz use their normal authorized retrieval when useful. Explicit selected documents are passed only to those content steps. RAG implementation and embeddings are unchanged.

## Persistence, limits and failures

`WorkflowRun` stores owner, workflow ID, status, current step, bounded input/context, warnings and timestamps. `WorkflowStepRun` stores agent/step ID, position, status, attempt count, input/output summaries, bounded structured output and a safe error code. A composite ownership foreign key protects step runs. No system prompts, provider credentials or internal error stacks are persisted in workflow outputs.

A database-unique active key prevents simultaneous runs for the same user's exam. Missing plan/quiz candidates are checked again after the run claims its key, avoiding creation based on an earlier empty preflight read. Completed artifacts remain independently available if a later step fails.

Definitions allow at most eight steps, three calls per agent, one retry and five minutes. The exam definition uses five conditional steps and at most two calls per agent, including retries. The engine checks limits at step/attempt boundaries and after calls. There is no recursive scheduling or model-created loop.

Only rate limits and temporary provider failures receive one retry. Authorization, configuration, invalid input/response and persistence failures are not retried. Persistence failures are deliberately not replayed because the outcome of a write can be uncertain. Optional Tutor failure uses `continue-with-warning`; required planning/quiz failures stop the workflow. The engine also supports explicit `skip-step` and `fail-workflow` policies. Security failures always stop, even for optional steps.

Cancellation and the duration limit are cooperative: an in-flight provider/domain operation is allowed to settle, its audit outcome is retained, and no subsequent step begins. The active key is held until that operation returns. This foundation has no crash recovery, automatic replay or durable background continuation. An interrupted server process can leave an active run requiring operator inspection; do not replay uncertain writes or clear its key while its worker may still be running.

## Verification

`tests/workflows.test.ts` uses actual authentication, PostgreSQL, Context Builder, existing agent execution and persistence with deterministic AIProvider responses. It covers conditional plans/Tutor/diagnostics, multiple learning states, output passing, availability, plan and quiz reuse, preserved history, changed exam dates, learning refresh, foreign references, concurrent starts, cancellation, failure policies, retries, limits and single-agent compatibility. Additional directly affected agent, learning, context and planning tests run alongside it.


## Weak Topic Recovery

`weak-topic-recovery` is an explicit workflow ID that future Manager recommendations can reference. It does not intercept normal agent requests or rewrite study plans.

```ts
const run = await workflows.runWorkflow({
  workflowId: "weak-topic-recovery",
  goal: "Help me improve my weakest topic.",
  courseId, // Optional for automatic selection.
  // topicId or topicName: optional exact topic selection.
  // review: true explicitly requests review even when mastery is already high.
}, request.headers);

// A generated quiz pauses the run with status "waiting-for-input".
// Display outputs["explanation-1"] when present and load the saved public quiz
// via QuizAgentService.getQuiz(run.waitingFor.referenceId, request.headers).
const answer = await workflows.submitRecoveryAnswer({
  runId: run.runId, questionId, userAnswer,
  quizAttemptId, // Reuse the ID returned for the first answer.
}, request.headers);
// After ALL questions in that attempt have been graded, explicitly continue:
const next = await workflows.resumeWorkflow({
  runId: run.runId, quizAttemptId: answer.quizAttemptId,
}, request.headers);
// The existing QuizAgentService.evaluateAnswer flow can also grade the quiz.
// No fabricated answer, automatic grading loop or background continuation exists.
```

Topic IDs and normalized exact names are resolved within owned learning data. Exact names in the goal also work; ambiguous names require course/topic selection rather than fuzzy concept merging. Automatic selection prefers demonstrated weakness, with ranking based on mastery gap (45%), recent mistakes (20%), confidence (15%), declining trend (10 points) and practice recency (up to 10 points). If only low-evidence topics exist, the entry is explicitly diagnostic. Strong-only data produces `NO_LEARNING_DATA`; an explicitly selected strong topic skips remediation unless review was requested.

`recovery-policy.ts` centralizes thresholds and quiz/call limits. Confidence >=60 with at least three attempts supports a reliable decision. Mastery below 55, declining trends or recent accuracy below 70 selects Tutor first; other sub-threshold topics start with practice. Low confidence always starts with a five-question medium diagnostic. The engine waits for one complete, owned QuizAttempt before refreshing the selected topic's Learning aggregate. A diagnostic with insufficient evidence stops for later practice rather than triggering unjustified tutoring.

Very weak topics can start with six easy practice questions, followed by five medium/hard verification questions; easy-only results never confirm recovery. Otherwise practice is medium, and verification becomes hard at mastery >=70. A second explanation uses a different approach only if the refreshed evidence supports it. Tutor and Quiz receive the selected topic's exact numeric state as well as normal Context Builder learning/course/RAG context. There is no manual RAG retrieval.

Evaluation uses current minus starting mastery, with confidence evaluated separately: mastery >=70 and confidence >=60 with challenging completed evidence is `recovered`; a gain >=8 is `improving`; persistent supported weakness is `needs-more-practice`; remaining low confidence is `insufficient-evidence`. Recovered/improving results stop for independent practice, except an easy warm-up still requires challenging verification. The full run contains six static conditional steps, at most two Tutor calls and two Quiz generations, with no generation retry. The second evaluation always ends the run. Quiz answer grading is user initiated through the existing service and is not an autonomous agent loop.

Run context stores snapshots, topic/course IDs, counters and up to two quiz/attempt references, never full quizzes or Tutor prose. Bounded Tutor output is retained separately for display. `result.recovery` exposes the topic, starting/ending state, evaluation, user-facing summary, completed steps and next action. `getLearningTopicStates({userId, courseId, topicId})` reuses the existing freshness rules and indexed aggregate read; it does not replay history or introduce another score store. Future Planner requests see the same updated LearningProgress through Context Builder.

The generic engine persists `WAITING_FOR_INPUT` and cumulative `activeDurationMs`; human waiting time is excluded. Step audit counts enforce cumulative call limits across restarts. The unique active key remains held while paused. An atomic resume claim includes the expected wait checkpoint and row version, preventing simultaneous or late continuations from consuming the next quiz. Repeated continuation of an already-consumed attempt is idempotent. Cancellation releases a paused run's key and skips pending work. In-flight operations still settle before their key is released.

All course/topic/quiz/question/attempt/run references are owned and scoped. Incomplete, foreign, deleted or mismatched attempts cannot advance the run. Tutor/generation/learning-refresh failures stop without claiming recovery. Failed answer grading leaves a bounded warning and keeps the run paused for retry. No full recovery is reported merely because questions were generated. As with the foundation, interrupted in-flight writes are not automatically replayed; operator inspection is still needed for a process crash during an agent call.

`tests/recovery-policy.test.ts` and `tests/weak-topic-recovery.test.ts` cover deterministic decisions, actual grading/learning updates, canonical quiz history, bounded remediation, output/state persistence, retrieval compatibility, concurrency, cancellation, deletion, ownership and failures. Existing exam preparation and directly affected agent/context/learning/planner suites remain regression coverage.


## Lecture Study

`lecture-study` turns explicitly selected materials into a bounded study session:
Notes → optional targeted Tutor → Quiz → waiting for answers → deterministic learning summary.
There are four static steps and at most one generation per agent, with no automatic retry/chaining. It reuses the existing engine, owned WorkflowRun/WorkflowStepRun records, Quiz persistence/grading, and LearningProgress. No new tables or migrations are needed.

```ts
const run = await workflows.runWorkflow({
  workflowId: "lecture-study",
  goal: "Help me study this lecture.",
  courseId, // May be inferred when every document belongs to the same owned course.
  documentIds, // Or documentId for one file; do not supply both.
  mode: "standard-study", // Optional: quick-review | standard-study | deep-study.
  topicFocus: "Mathematical Induction", // Optional.
  availableMinutes: 60, // Optional, rough total student effort.
  // difficulty: "easy" | "medium" | "hard" // Optional explicit preference.
}, request.headers);

// Display outputs.notes and optional outputs.explanation. Their sourceRefs
// resolve through the single outputs.sources catalog of actual retrieved metadata.
// Load the public Quiz by run.waitingFor.referenceId.
const answer = await workflows.submitWorkflowAnswer({
  runId: run.runId, questionId, userAnswer, quizAttemptId,
}, request.headers);
// Reuse the first answer's quizAttemptId for every remaining question.
const finished = await workflows.resumeWorkflow({
  runId: run.runId, quizAttemptId: answer.quizAttemptId,
}, request.headers);
// Resume only after every question has been graded in this one attempt.
```

The generic `submitWorkflowAnswer`/`resumeWorkflow` path now accepts both interactive workflows. `submitRecoveryAnswer` remains a compatibility alias. Domain-specific reference checks plug into the existing atomic resume claim. The lecture lock incorporates selected document versions and requested goal/mode/focus/difficulty/time so identical starts deduplicate while an explicitly different workload is respected. Concurrent/repeated resumes do not repeat generation; waiting time stays excluded from the persisted execution budget.

Modes are deterministic. Quick review normally uses concise Notes and four questions without Tutor; standard uses structured Notes, up to two targeted explanations and six questions; deep uses detailed Notes, up to three explanations and ten meaningful questions. Tight supported budgets reduce counts to three/five/eight respectively. Default estimates are 14/43/85 minutes. Available time adapts mode (e.g. 20/60/120 minutes), counts and stage estimates; an explicit mode always wins. An impossible budget produces `INSUFFICIENT_STUDY_TIME` before generation. Estimates are rough reading/learning/practice effort, not calendar scheduling or provider latency.

The existing Notes agent has an optional structured-output helper that extracts topics, key ideas, complexity, definitions, formulas/procedures and source indices in the same generation. Ordinary Notes requests still return text as before. The helper uses existing Notes instructions, AgentExecutor and AIProvider. Tutor consumes compact key ideas and exact matching learning estimates, plus normal targeted RAG retrieval; it does not re-summarize the entire lecture. Demonstrated weaknesses/declining trends, unknown complex concepts and an explicit focus receive priority. Quick review skips Tutor; well-understood basic concepts may also skip it. Optional Tutor failure retains Notes, records a warning and permits grounded practice.

All grounded steps receive only the selected document IDs. Documents must be owned, in one owned course, READY, and unchanged when steps/resume execute. Context Builder's opt-in `selectedDocumentCoverage` reserves retrieval slots per selected document through the existing RAG service so a large file cannot crowd out other selections. Default retrieval remains unchanged. Notes/Quiz reserve up to ten passages; Tutor can still retrieve targeted exact passages. Missing usable sources stop generation. Notes coverage is explicitly limited to retrieved passages, never claimed as complete lecture coverage.

Structured Notes and Tutor citations can only index the real retrieved source catalog; invalid indices are rejected. Output source references map to a deduplicated catalog containing actual document titles and pages. Neither raw RAG chunks nor full notes are copied into workflow context. Detailed Notes/explanations remain in step outputs; this definition opts into the engine's bounded 48,000-character output limit, while the default for existing definitions remains 14,000 and context remains capped at 24,000. Executor's optional bounded `referenceData` travels as user reference information, separate from system instructions and the focused retrieval query. Quiz's trusted optional generation support forwards this context and mode-appropriate output budgets without changing ordinary Quiz calls.

Quiz includes recall, applied work and written reasoning. The workflow verifies topic coverage, actual selected-document sources and at least one written question. Default difficulty is medium, with scaffolding for weakness and diagnostic questions for uncertainty; high mastery with sufficient confidence or an explicit preference may select hard. Deep mode alone does not make every question hard. Answer explanations retain existing Quiz feedback and evaluation behavior.

No mastery changes are inferred on generation. The final code step requires a complete owned attempt, calculates quiz percentage from real scores (including partial credit), and refreshes only actually practiced topic aggregates. `lectureStudy.summary` returns selected lectures, concepts studied, topics practiced, score, supported weak topics, supported improvements and next action. New/unpracticed topics are not called improved from the default score; limited evidence and untested concepts are identified. Weakness requires confidence >=60 and at least three attempts; improvement requires prior evidence, additional attempts, a mastery gain >=5 and confidence >=60. Suggested recovery/practice/planning remains a recommendation. Future Planner reads use the same updated LearningProgress through Context Builder.

Required Notes/Quiz/learning failures stop without a fabricated final summary; already completed work stays accessible. Failed grading leaves the run waiting and retryable. Deleted quizzes, changed/not-ready documents, foreign/mismatched attempts and frontend userId/context injection are rejected. A server crash during an in-flight write still follows the foundation's operator-inspection policy rather than unsafe automatic replay.

`tests/lecture-policy.test.ts` and `tests/lecture-study.test.ts` exercise mode/time decisions, real selected-document retrieval, structured Notes/Tutor grounding, actual Quiz grading/Learning updates, accurate summaries, source preservation, pause/restart/concurrency, failures and ownership. Existing workflow, Notes, Tutor, Quiz, executor, context, learning and planning tests provide directly affected regression coverage.

## Assignment Support

`assignment-support` reuses WorkflowEngine, Tutor, optional Notes, Context Builder and the existing RAG service. It adds no tables, assignment status values, agents or submission system.

```ts
const run = await workflows.runWorkflow({
  workflowId: "assignment-support",
  assignmentId,
  goal: "Help me with this assignment.",
  // courseId, documentIds, specificQuestion, userWork are optional.
  availableMinutes: 90,
}, request.headers);

// Render run.assignmentSupport and its bounded outputs. A student-work checkpoint
// references the assignment, not a quiz. The same generic resume API claims it.
if (run.waitingFor?.kind === "student-work") {
  const reviewed = await workflows.resumeWorkflow({
    runId: run.runId,
    userWork: draft, // 1–6,000 characters; separate from official instructions.
  }, request.headers);
}
```

Six static steps are conditional: understand → assignment-local plan → optional Notes → targeted Tutor → draft checkpoint → review. Understanding-only requests end after analysis; requests to start or break down the assignment use analysis and planning. Concept/problem requests receive targeted help, with a draft checkpoint for subsequent feedback. Checking an answer runs review when work exists, or waits for the student's draft. Notes runs only for requested condensed concepts, definitions or formula review; merely mentioning a formula in a problem does not invoke Notes. Short generic sessions omit an additional Tutor call. There are at most three Tutor calls, one Notes call and no automatic retries or agent chaining.

The analysis contains an objective, deliverables, constraints, required concepts, ordered subtasks with provisional effort estimates and a next action. Every objective/requirement carries a verbatim quote checked against the official description; subtask indices must cover all analyzed deliverables. Interpretation remains a semantic AI task, so source excerpts stay available for verification. Suggested concepts/subtasks are distinguished from graded requirements. The analysis runs once. General concept help reuses its compact essentials; particular problem assistance and review retain exact official wording when quantifiers, constraints or code can affect correctness. Student work is separate user-role reference data and never becomes an assignment instruction or grading rubric.

The deterministic plan reuses the same `calculatePlanningSignals` used by Academic Manager/Study Planner and adds exact hours remaining, not-started and estimated-work indicators. Close/overdue deadlines favor essential progress with shorter checkpoints. Plans reserve preparation and review time, keep work blocks at most 60 minutes (30 for urgent work), expose provisional estimates and deferred minutes, and do not advance beyond an unfinished dependency. No availability means an explicit 60-minute session assumption. This is a work session for one assignment, not a replacement StudyPlan or a promise to finish all work.

`ContextRequest.assignmentId` resolves ownership and course through existing academic/context services, returns the exact description and revision even for old/completed assignments, and excludes unrelated assignments. Missing official instructions produce `ASSIGNMENT_DESCRIPTION_REQUIRED`; instructions exceeding context capacity fail explicitly rather than being silently dropped. Selected documents must be owned, READY and in the assignment's course. Concept/Notes/review retrieval uses normal Context Builder scope; every explicitly selected document must provide usable passages. Sources are validated against actual retrieval metadata and retained with pages. General guidance can have no document source; it must not invent one.

`WorkflowRun.context.assignment` holds the compact analyzed state, student draft, assignment/document revisions, deterministic signals and next action. Full generated explanations and feedback remain in WorkflowStepRun outputs. `assignmentSupport` returns assignment ID, current stage, summary, completed/remaining workflow steps, optional feedback and next action. Task estimates/deferred work live in `outputs["assignment-plan"]`; completed workflow steps never mean completed assignment subtasks. Feedback includes strengths, issues, missing-requirement references, conceptual errors and improvements. Neither receiving feedback nor ending a run updates Assignment status or submits work.

The existing atomic pause/resume claim now accepts a `student-work` checkpoint as well as a quiz checkpoint. Invalid drafts leave the run paused; repeated/concurrent successful resumes do not repeat analysis/review. All references are owner-scoped, including the run on continuation. Assignment/document changes are checked before and after generation and again on resume. Changed requirements demand a new analysis; old analysis is retained as historical work and never used for a new review. Failed provider calls preserve completed outputs and the submitted draft; a terminal failed run is not silently retried. Existing cancellation, cumulative execution budgets and process-crash limitations remain unchanged.

`tests/assignment-support.test.ts` uses actual Better Auth sessions, PostgreSQL records and local vector retrieval, mocking only AI generation. It covers stage selection, original requirements, time/deadline behavior, conditional Notes/Tutor, grounded sources, typed feedback, persisted pause/resume, duplicate continuation, changes/deletion, cross-user access and failure preservation. Existing exam, recovery, lecture, context and affected agent tests provide regression coverage.

Files in the Assignment Support increment:

- `server/workflows/assignment-support.ts`, `assignment-policy.ts`, `assignment-service.ts` (new).
- `server/workflows/engine.ts`, `errors.ts`, `index.ts`, `registry.ts`, `service.ts`, `types.ts`, `README.md`.
- `server/context/builder.ts`, `categories.ts`, `cache.ts`, `types.ts`, `validation.ts`, `README.md`.
- `server/agents/executor/executor.ts`, `types.ts`; `server/agents/core/service.ts`.
- `tests/assignment-support.test.ts` (new).

## Career Preparation

`career-preparation` creates a compact evidence state and reuses Career Agent for one structured analysis covering strengths, prioritized gaps, selected projects, resume, portfolio, interview preparation, and concrete actions. Deterministic readiness levels describe available evidence for technical foundation, projects, resume, portfolio, interviews, and applications; they do not claim ability or hiring probability. Advice is general role guidance because live job data is outside this workflow.

Inputs include a target role, industry, company interests, application timeline, resume text, selected project IDs, and weekly available time. A single saved target role or industry is reused when omitted. Selected projects, profile, skills, concise course evidence, workflow runs, plans, and tasks remain scoped to the authenticated user. Career tasks persist separately from Study Planner tasks.

The validated Career Agent actions are scheduled in code. Short timelines break equal-priority ties toward resume, portfolio, and application work; longer timelines favor project and skill evidence. No week exceeds the supplied time. Essential missing evidence pauses with a `career-data` checkpoint. Resume accepts bounded resume, experience, or portfolio data, rejects stale saved evidence before claiming the checkpoint, and uses the engine's existing atomic resume behavior.

`tests/career-preparation.test.ts` covers registration, role resolution, compact state/readiness, grounded gap and asset advice, timeline and availability policy, pause/resume, plan persistence, separation from study plans, ownership, stale evidence, provider failure, structured validation, and fabricated metrics.
