import { randomUUID } from "node:crypto";
// Explicit synthetic staging fixtures only; this creates one assistant turn and
// consumes provider quota. Never run in production or on a real student's data.
if (process.env.APP_ENV !== "staging" || process.env.BILLING_MODE !== "test" || process.env.STAGING_SYNTHETIC_FIXTURE_CONFIRMED !== "true") throw new Error("Synthetic staging confirmation and test billing mode required");
const origin = new URL(process.env.SMOKE_ORIGIN);
if (origin.protocol !== "https:" || origin.origin !== process.env.APP_URL) throw new Error("Canonical staging origin required");
if (!process.env.SMOKE_COOKIE || !process.env.SMOKE_COURSE_ID || !process.env.SMOKE_DOCUMENT_ID) throw new Error("Synthetic authenticated course/document fixture required");
async function post(path, body) {
  const response = await fetch(new URL(path, origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(120000),
    headers: { cookie: process.env.SMOKE_COOKIE, origin: origin.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("Staging functional smoke failed");
  return response.json();
}
try {
  const rag = await post("/api/student/rag/search", { query: "What is mathematical induction?", courseId: process.env.SMOKE_COURSE_ID, documentIds: [process.env.SMOKE_DOCUMENT_ID], maxResults: 2 });
  if (!rag.results?.length) throw new Error("Synthetic document retrieval returned no evidence");
  const answer = await post("/api/student/assistant/requests", { request: "Explain mathematical induction in two short sentences.", turnId: `release-smoke-${randomUUID()}`, courseId: process.env.SMOKE_COURSE_ID, preferredAgentId: "tutor" });
  if (!answer.assistantMessage?.content?.trim()) throw new Error("Synthetic assistant response missing");
  console.info(JSON.stringify({ event: "staging-functional-smoke", rag: true, ai: true }));
} catch { console.error("Staging AI/RAG smoke failed; inspect correlated safe telemetry."); process.exitCode = 1; }
