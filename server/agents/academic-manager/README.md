# Academic Manager

Use the existing Student entry point from an authenticated server route:

```ts
import { createStudentAgentService } from "@/server/agents/student-service";

const result = await createStudentAgentService().handleAgentRequest(
  { request: "What should I focus on this week?" },
  request.headers,
);
// On success: response.content and response.structuredData.
```

The shared Router selects `academic-manager`. A generic, server-configured Core
handler uses the existing Executor's structured-output support and AIProvider.
No additional execution pipeline or database writes are introduced. The factory
installs the handler; applications constructing `AgentService` themselves can
register `executeAcademicManager` in `handlers["academic-manager"]`.

Context Builder prepares `academicOverview` from its existing deadline and
learning readers, exact aggregate queries, and existing StudyPlan/StudyTask data.
It defaults to the profile's current semester; an explicit owned course overrides
semester scope. Without a profile semester, all owned courses are considered and
the snapshot records that limitation. Snapshot-only requests load their required
dependencies internally without exposing unrequested categories.

Bounds: 20 course details, 20 assignments, 10 exams, 3 active plan summaries,
8 upcoming sessions, 8 priorities/risks, and 5 action candidates. Counts include
all matching rows, even when detail lists are limited. Missing/truncated evidence
is explicitly marked. No full question-attempt history is read. Exact exam-topic
summaries are selected from the same Learning Intelligence read, then consumed by
readiness rather than duplicated in the final context. Documents are disabled
unless the request selects them or explicitly needs lecture/material coverage.

Numeric metrics are deterministic:

- Priorities reuse Study Planner's urgency and confidence-aware learning ranking.
  Overdue work, missed plan sessions and clustered deadlines add coordination
  concerns. Course attention is the highest relevant concern/workload signal.
- Risks are academic workload/readiness signals: overdue high-priority work,
  imminent exams with reliable weakness, declining exam-topic evidence, repeated
  missed sessions, or at least three assignments due in seven days.
- Readiness combines 80% mastery, 15% recent quiz accuracy and 5% linked plan
  completion. With no linked plan the first two weights are renormalized. The
  score is shrunk toward 50 using coverage-adjusted confidence; stale practice
  reduces readiness confidence. Learning mastery/confidence are never rewritten.
  Coverage below 60% or readiness confidence below 40 means insufficient data;
  high readiness also requires score 80, confidence 65 and coverage 80%.
- Plan completion counts completed tasks over completed plus remaining tasks.
  Skipped tasks are reported separately. Missed means unfinished and before the
  student's local date. Progress is scoped to the listed active plans; the missed
  count covers all matching active plans.

AI generates only interpretation prose and selects candidate references. All
numbers, action reasons and priorities come from the snapshot. Candidate IDs and
specialist IDs are checked against both evidence and AgentRegistry. The highest
deterministic action is retained. `now` mode returns up to two actions and omits
the semester snapshot; overview mode returns up to three actions and the bounded
snapshot. Agents are only recommended, never invoked automatically.

Tests use actual authentication, PostgreSQL, Context Builder and learning/plan
records, with only model output replaced. This validates computation and
integration; it does not measure live-model prose quality.

```sh
npm test -- tests/academic-snapshot.test.ts tests/academic-manager.test.ts
npm run check -- --incremental false
```
