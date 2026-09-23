import "server-only";
import { compareEvaluations } from "./comparison";
import { qualityProfile } from "./profiles";
import { reportSchema, type EvalReport, type EvalRow } from "./runner";
import type { ProfileId } from "./types";

export const CORE_RELEASE_PROFILES: ProfileId[] = ["tutor", "notes", "quiz", "grading", "study-planner", "academic-manager", "dispatcher", "model-router", "rag-retrieval", "rag-generation", "workflow"];

/** Release evidence must be observed, measured and paired. Offline fixture
 * scores remain useful tests, but cannot certify generated learning quality.
 * This checks report contents, not the operator's provenance/review process. */
export function assessReleaseQuality(rawBaseline: EvalReport, rawCurrent: EvalReport, profiles: readonly ProfileId[] = CORE_RELEASE_PROFILES) {
  const baseline = reportSchema.parse(rawBaseline), current = reportSchema.parse(rawCurrent);
  const failures: Array<{ profile: ProfileId | "release"; code: string }> = [];
  if (baseline.mode !== "FULL" || current.mode !== "FULL") failures.push({ profile: "release", code: "FULL_REPORT_REQUIRED" });
  const failed = (r: EvalRow) => r.result.passed === false || r.result.failures.length > 0 || r.result.metrics.judgeFailure === 1 || r.result.metrics.executionFailure === 1;
  if ([baseline, current].some(report => report.failedChecks > 0 || report.rows.some(failed))) failures.push({ profile: "release", code: "FAILED_OBSERVATIONS" });
  const comparisons = compareEvaluations(baseline, current);
  for (const profile of profiles) {
    const policy = qualityProfile(profile), semantic = policy.semantic.length > 0;
    const relevant = (row: EvalRow) => row.result.profile === profile && (semantic ? row.result.evaluationType === "model-based" : row.result.evaluationType === "deterministic");
    const valid = (row: EvalRow) => row.evidence !== "evaluator-fixture" && row.result.passed === true && row.result.score !== null && row.result.score >= policy.minimum &&
      (!semantic || !!row.model && !!row.provider && row.provider !== "unknown" && !!row.judgeModel &&
        policy.semantic.every(d => row.result.dimensions[d] !== undefined && !row.result.unmeasured.includes(d)));
    for (const [name, report] of [["BASELINE", baseline], ["CANDIDATE", current]] as const) {
      const rows = report.rows.filter(relevant);
      if (rows.length < policy.minimumSamples || rows.some(row => !valid(row))) failures.push({ profile, code: `${name}_INSUFFICIENT_MEASURED_EVIDENCE` });
      // A subset of successful judge calls cannot hide unjudged executions.
      if (semantic && report.rows.some(row => row.result.profile === profile && row.result.evaluationType === "deterministic" && !rows.some(judge => judge.caseId === row.caseId && judge.datasetVersion === row.datasetVersion && judge.evidence === row.evidence))) failures.push({ profile, code: `${name}_MISSING_JUDGMENTS` });
    }
    const paired = comparisons.filter(c => c.profile === profile && c.type === (semantic ? "model-based" : "deterministic"));
    if (!paired.length || paired.some(c => !["stable", "improved"].includes(c.status))) failures.push({ profile, code: "UNPROVEN_OR_REGRESSED_BASELINE_COMPARISON" });
  }
  return { passed: failures.length === 0, failures, comparisons };
}
