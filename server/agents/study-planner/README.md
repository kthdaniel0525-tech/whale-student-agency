# Study Planner Agent

The Study Planner uses the shared Router, Context Builder, Agent Executor, and
AIProvider structured-output path. The agent does not query academic or learning
tables directly. Context Builder supplies bounded profile, course, deadline,
preference, and learning summaries.

Before generation, `priority.ts` converts current deadlines and learning state
into deterministic 0–100 signals. Exam and assignment urgency, confidence-aware
mastery gaps, declining trends, stale practice, importance, and estimated effort
all contribute. Low-mastery/high-confidence topics favor repair and practice;
low-confidence topics favor diagnostic quizzes; strong/high-confidence topics
receive lower-priority maintenance.

The model may schedule only supplied signals, dates, activity types, and available
minutes. Zod validates the response, and service-level checks enforce the computed
horizon, daily capacity, 15–180 minute bounds, allowed activity types, and plan
totals. Academic IDs, priorities, snapshot metrics, and task reasons come from
the trusted signals rather than generated output.

An explicit saved session-length preference is used when the request does not
provide one. The profile preference remains ahead of inferred behavioral memory;
current availability and current instructions always win. Completed or skipped
tasks produce idempotent observations for later personalization without changing
the task update if optional memory recording fails.

`StudyPlan` owns persistent `StudyTask` records. Replanning preserves completed
tasks, marks replaced unfinished work as skipped, subtracts completed time from
availability, and sends only missed work, completed work, changed deadlines, and
material mastery changes as a compact delta. The `recommendNow` path reuses the
same priorities without creating a stored plan.
# Workflow compatibility

An optional `examId` on create/update requests selects the exact authorized exam through Context Builder. During an exam-scoped update, completed tasks and other exams' active sessions are preserved, their minutes are reserved, and their dates remain within the stored plan range. Calls without exam scope retain the existing behavior. Workflow orchestration uses the normal Planner service and may supply a request-scoped ContextReadCache through its executor options.
