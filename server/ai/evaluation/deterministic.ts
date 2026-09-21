import "server-only";
import { quizOutputSchema } from "../../agents/quiz/schemas";
import { generatedStudyPlanSchema } from "../../agents/study-planner/schemas";
import { MODEL_TIERS } from "../routing/types";
import { qualityProfile } from "./profiles";
import { resultSchema, type EvaluationContext, type EvaluationResult, type Dimension, type FailureCode } from "./types";
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : NaN;
const text = (v: unknown) => typeof v === "string" ? v : "";
const normalize = (s: string) => s.normalize("NFKC").toLowerCase();
/** Scores are observable checks, not invented semantic judgments. Unmeasured
 * dimensions remain explicit until references or a capable judge are available. */
export function evaluateDeterministic(c: EvaluationContext): EvaluationResult {
  const p = qualityProfile(c.profile), checks: EvaluationResult["checks"] = [], metrics: Record<string, number> = {};
  const check = (id: string, dimension: Dimension, valid: boolean | number, failure: FailureCode) => {
    const score = typeof valid === "boolean" ? Number(valid) : valid;
    checks.push({ id, dimension, score, ...(score < 1 ? { failure } : {}) });
  };
  const o = object(c.output), e = c.expected ?? {}, outputText = c.text ?? (typeof c.output === "string" ? c.output : text(o.content) || text(o.text));
  if (["tutor", "notes", "career", "rag-generation", "continuity"].includes(c.profile)) check("nonempty", "structuralValidity", !!outputText.trim(), "INVALID_STRUCTURE");
  if (e.format === "bullets") check("requested-bullets", "structuralValidity", /^\s*(?:[-*•]|\d+\.)\s+\S/m.test(outputText), "INVALID_STRUCTURE");
  if (e.format === "json") { let valid = true; try { JSON.parse(outputText); } catch { valid = false; } check("requested-json", "structuralValidity", valid, "INVALID_STRUCTURE"); }
  if (e.maxWords !== undefined) check("explicit-length-limit", "structuralValidity", outputText.trim().split(/\s+/).length <= e.maxWords, "OVERLY_VERBOSE");
  if (c.profile !== "workflow" && e.requiredTerms?.length) check("reference-concept-coverage", "completeness", e.requiredTerms.filter(t => normalize(outputText).includes(normalize(t))).length / e.requiredTerms.length, "INCOMPLETE");
  if (e.forbiddenTerms?.length) check("reference-contradictions", "correctness", !e.forbiddenTerms.some(t => normalize(outputText).includes(normalize(t))), "INCORRECT");
  if (c.sources || c.requiresGrounding || c.citedSourceIds) {
    const retrieved = new Set((c.sources ?? []).map(s => s.id)), cites = c.citedSourceIds ?? [];
    check("citation-provenance", "structuralValidity", cites.every(id => retrieved.has(id)), "WRONG_SOURCE");
    if (c.requiresGrounding) check("requested-sources-available", "structuralValidity", retrieved.size > 0 && (c.requestedSourceIds ?? []).every(id => (c.sources ?? []).some(s => s.documentId === id)), "UNGROUNDED");
    // Provenance validates IDs only; sourceFaithfulness remains a semantic dimension.
  }
  if (c.profile === "dispatcher" && e.acceptableTargets?.length) {
    const type = o.needsClarification === true ? "clarification" : o.targetType, id = o.targetId;
    check("acceptable-route", "routingAccuracy", e.acceptableTargets.some(t => t.type === type && (t.id === undefined || t.id === id)), "BAD_ROUTING");
  }
  if (c.profile === "model-router" && e.minimumTier) check("quality-floor", "routingAccuracy", MODEL_TIERS.includes(o.tier as typeof MODEL_TIERS[number]) && MODEL_TIERS.indexOf(o.tier as typeof MODEL_TIERS[number]) >= MODEL_TIERS.indexOf(e.minimumTier), "BAD_ROUTING");
  if (c.profile === "quiz") {
    const questions = array(o.questions);
    check("quiz-schema-and-answer-integrity", "structuralValidity", quizOutputSchema(e.questionCount ?? questions.length, e.questionType ?? "mixed").safeParse(c.output).success, "INVALID_STRUCTURE");
    check("distinct-questions", "structuralValidity", questions.length > 0 && new Set(questions.map(q => normalize(text(object(q).prompt)))).size === questions.length, "INVALID_STRUCTURE");
    if (e.difficulty) check("requested-difficulty-label", "structuralValidity", o.difficulty === e.difficulty, "WRONG_DIFFICULTY");
  }
  if (c.profile === "grading") {
    if (e.correct !== undefined) check("reference-grade", "gradingReliability", o.correct === e.correct, "INCORRECT");
    if (e.scoreRange) { const score = num(o.score); check("reference-score", "gradingReliability", score >= e.scoreRange[0] && score <= e.scoreRange[1], "INCORRECT"); }
    if (checks.length) metrics.disagreement = checks.some(c => c.score < 1) ? 1 : 0;
  }
  if (c.profile === "rag-retrieval" && e.relevantChunkIds?.length) {
    const k = e.k ?? 5, ids = [...new Set(array(o.chunkIds).map(String).slice(0, k))], relevant = new Set(e.relevantChunkIds);
    const hits = ids.filter(id => relevant.has(id)).length;
    metrics.recallAtK = hits / relevant.size; metrics.hitAtK = Number(hits > 0); metrics.precisionAtK = ids.length ? hits / ids.length : 0;
    check("retrieval-recall", "relevance", metrics.recallAtK, "IRRELEVANT");
  }
  if (c.profile === "study-planner") {
    const parsed = generatedStudyPlanSchema.safeParse(o.plan ?? c.output);
    check("plan-schema-and-totals", "structuralValidity", parsed.success, "INVALID_STRUCTURE");
    if (parsed.success) {
      const tasks = parsed.data.days.flatMap(d => d.sessions.map(s => ({ ...s, date: d.date })));
      if (e.availability) check("available-time", "planningQuality", parsed.data.days.every(d => d.totalMinutes <= (e.availability!.find(a => a.date === d.date)?.availableMinutes ?? 0)), "UNREALISTIC_PLAN");
      check("date-range", "planningQuality", tasks.every(t => t.date >= parsed.data.startDate && t.date <= parsed.data.endDate), "UNREALISTIC_PLAN");
      check("session-duration", "planningQuality", tasks.every(t => t.durationMinutes <= (e.maxSessionMinutes ?? 90)), "UNREALISTIC_PLAN");
      if (e.deadlines) check("deadlines", "planningQuality", tasks.every(t => !e.deadlines![t.signalId] || t.date <= e.deadlines![t.signalId].slice(0, 10)), "UNREALISTIC_PLAN");
      if (e.weakSignalIds?.length && e.strongSignalIds?.length) {
        const minutes = (ids: string[]) => tasks.filter(t => ids.includes(t.signalId)).reduce((n, t) => n + t.durationMinutes, 0);
        check("evidenced-weakness-priority", "planningQuality", minutes(e.weakSignalIds) >= minutes(e.strongSignalIds), "UNREALISTIC_PLAN");
      }
    }
    // Existing task snapshots can carry exact times and completed IDs alongside the generated plan.
    const observed = o;
    if (e.completedTaskIds) check("completed-work-preserved", "planningQuality", e.completedTaskIds.every(id => array(observed.preservedCompletedIds).includes(id)), "INCOMPLETE");
    if (e.busyIntervals) {
      const slots = array(observed.scheduledSessions).map(object);
      const validDate = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
      if (slots.length) check("calendar-conflicts", "planningQuality", slots.every((s, i) => validDate(s.start) && validDate(s.end) && Date.parse(String(s.end)) > Date.parse(String(s.start)) && ![...e.busyIntervals!, ...slots.slice(0, i)].some(b => Date.parse(String(s.start)) < Date.parse(String(b.end)) && Date.parse(String(b.start)) < Date.parse(String(s.end)))), "UNREALISTIC_PLAN");
      else metrics.calendarCoverage = 0; // Date-only plans cannot prove calendar availability.
    }
  }
  if (c.profile === "academic-manager") {
    const ids = array(o.priorityIds).map(String);
    if (e.urgentIds) check("urgent-work-covered", "planningQuality", e.urgentIds.every(id => ids.includes(id)), "INCOMPLETE");
    if (e.allowedIds) check("owned-priorities-only", "correctness", ids.every(id => e.allowedIds!.includes(id)), "FABRICATED_DATA");
  }
  if (c.profile === "career" && e.allowedNumbers) {
    const numbers = outputText.match(/\b\d+(?:\.\d+)?%?/g) ?? [];
    check("evidence-backed-metrics", "correctness", numbers.every(n => e.allowedNumbers!.includes(n)), "FABRICATED_DATA");
  }
  if (c.profile === "workflow") {
    if (e.expectedStatus) check("workflow-status", "structuralValidity", o.status === e.expectedStatus, "INCOMPLETE");
    for (const [key, max] of [["totalCalls", e.maximumCalls], ["tutorCalls", e.maximumTutorCalls], ["quizCalls", e.maximumQuizCalls]] as const)
      if (max !== undefined) check(`${key.replace(/[A-Z]/g, s => `-${s.toLowerCase()}`)}-bounded`, "structuralValidity", num(o[key]) >= 0 && num(o[key]) <= max, "INVALID_STRUCTURE");
    if (e.requiredTerms) check("useful-artifacts", "completeness", e.requiredTerms.every(id => array(o.artifactIds).includes(id)), "INCOMPLETE");
    for (const key of ["startingMastery", "endingMastery", "confidence", "tutorCalls", "quizCalls"]) if (Number.isFinite(num(o[key]))) metrics[key] = num(o[key]);
  }
  if (["continuity", "personalization", "adaptive"].includes(c.profile) && e.facts) {
    for (const [key, expected] of Object.entries(e.facts)) check(`behavior-${key.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`, c.profile === "continuity" ? "correctness" : "personalization", JSON.stringify(o[key]) === JSON.stringify(expected), "INCORRECT");
  }
  const dimensions: Partial<Record<Dimension, number>> = {};
  for (const dim of new Set(checks.map(c => c.dimension))) { const values = checks.filter(c => c.dimension === dim); dimensions[dim] = values.reduce((n, c) => n + c.score, 0) / values.length; }
  const score = checks.length ? checks.reduce((n, c) => n + c.score, 0) / checks.length : null;
  return resultSchema.parse({ profile: c.profile, evaluationType: e.correct !== undefined || e.requiredTerms || e.relevantChunkIds ? "reference-based" : "deterministic", evaluatorVersion: p.version,
    score, passed: score === null ? null : score >= p.minimum && !checks.some(c => ["WRONG_SOURCE", "UNGROUNDED", "INVALID_STRUCTURE", "UNREALISTIC_PLAN", "FABRICATED_DATA"].includes(c.failure ?? "")),
    dimensions, failures: [...new Set(checks.flatMap(c => c.failure ? [c.failure] : []))], checks, metrics, unmeasured: p.semantic });
}
