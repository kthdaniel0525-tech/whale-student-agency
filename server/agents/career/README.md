# Career Agent

`createStudentAgentService().handleAgentRequest({ request, courseId?, documentIds?, preferredAgentId?: "career" }, requestHeaders)` uses the existing Router, Executor, Context Builder and AIProvider structured-output path. It returns a validated `CareerResponse` in `response.structuredData` and readable `content`. There is no new UI, HTTP execution pipeline, job search or automatic agent handoff.

Supply an optional target role in the request (for example, “Improve my resume for a Museum Educator role”) or explicitly save it in CareerProfile. Requested roles take precedence in the instructions. Roles are unrestricted strings; no CS-specific role catalog or assumed hiring requirements is built in. Gaps mean gaps in supplied evidence, not objective inability. Responses identify their scope as general role guidance, without live job-market verification.

## Focused context

Profile and career references are enabled. CareerProfile stores career goals directly because the existing memory allowlist only supports academic preferences; it is not duplicated in UserMemory. Projects and skills are bounded and include user-reported evidence. Course scope is optional and filters projects. Learning Context is enabled only for explicit learning/weakness requests and is used for constructive practice advice, without unnecessary raw scores in responses. Assignments, exams and the academic overview are excluded.

Documents are excluded by default. Explicit `documentIds` reuse authorized RAG passages and existing citations; unavailable selected passages fail safely. Links in career records are reference text only and are never fetched. No RAG internals were changed.

Career context keeps up to 10 projects and 30 skills with separate character budgets, clips long text, and reports omissions. Profile resume text is bounded to 8,000 characters in the prompt; the stored resume can contain 12,000. Request a specific course when appropriate. Context metadata signals clipping, so the agent is instructed to seek missing evidence instead of declaring unsupported gaps.

## Explicit persistence

`CareerDataService` is a server-only authenticated service. All methods accept incoming request headers and derive the owner from the session; no request-body userId is accepted.

```ts
const career = new CareerDataService();
await career.saveProfile({ targetRoles: ["Museum Educator"] }, requestHeaders);
await career.saveProject({
  name: "Student exhibit",
  description: "Organized a student exhibit with visitor guides.",
  technologies: [],
  role: "Student curator",
  outcomes: [], // Only actual outcomes supplied by the user.
}, requestHeaders);
await career.saveSkill({
  name: "Exhibit design",
  proficiency: "Self-described beginner",
  evidence: ["Designed the student exhibit's visitor guides."],
}, requestHeaders);
```

Profile saves update only supplied fields; `null` or `[]` explicitly clears fields. Project/skill saves create a record or replace it when a third `id` argument is supplied. Read/list/delete operations are owner-scoped too. Course links are authorized in a transaction and enforced by a composite ownership foreign key. Deleting a course deletes projects explicitly linked to it; deleting an account cascades all career records. Textual skill evidence is user-authored, not a pointer that loads another user's records. Analysis never writes career information or infers saved proficiency.

## Grounding boundary

Resume bullets cite a supplied evidence ID and an exact original excerpt. Unknown or foreign evidence/project references are rejected. A conservative deterministic quantity guard rejects new digits, spelled English counts and multipliers, or transferred units in a bullet unless present in its quoted original. Summary/strength numbers must also occur in the supplied evidence. Proposed future numeric goals belong in recommendations, not achieved-result statements.

This guard does not prove semantic truth or verify self-reported achievements. Instructions prohibit unsupported outcomes, exaggerated ownership and fabricated metrics; source matching and quantity checks provide additional runtime enforcement. Numeric paraphrases may be rejected conservatively; keep supported quantities verbatim. No extra classification or fact-checking LLM call is made. Missing evidence should produce a request for details, not an invented bullet.

Focused tests use real session authentication, PostgreSQL, Context Builder and selected-document RAG, mocking only AI generation. They cover ownership, career persistence, course-project evidence, target roles across programs, missing data, prompts, structured validation, numeric grounding, routing, and lack of unrelated context queries.
