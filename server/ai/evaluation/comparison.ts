import "server-only";
import { qualityProfile } from "./profiles";
import { reportSchema, type EvalReport, type EvalRow } from "./runner";
import type { ProfileId } from "./types";
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const key = (r: EvalRow) => `${r.caseId}:${r.datasetVersion}:${r.result.evaluationType}:${r.result.evaluatorVersion}:${r.evidence}:${r.judgeModel ?? "none"}`;
/** Paired, comparable cases only. Never equate fixture schema scores with generated quality. */
export function compareEvaluations(rawBaseline: EvalReport, rawCurrent: EvalReport) {
  const baseline = reportSchema.parse(rawBaseline), current = reportSchema.parse(rawCurrent), before = new Map(baseline.rows.map(r => [key(r), r]));
  return [...new Set([...baseline.rows, ...current.rows].map(r => `${r.result.profile}|${r.result.evaluationType}|${r.evidence}`))].map(group => {
    const [profile, type, evidence] = group.split("|"), policy = qualityProfile(profile as ProfileId);
    const rows = current.rows.filter(r => `${r.result.profile}|${r.result.evaluationType}|${r.evidence}` === group);
    const pairs = rows.flatMap(r => { const b = before.get(key(r)); return b && r.result.score !== null && b.result.score !== null && JSON.stringify(Object.keys(r.result.dimensions).sort()) === JSON.stringify(Object.keys(b.result.dimensions).sort()) ? [{ current: r, baseline: b }] : []; });
    const hardFailures = rows.filter(r => r.result.passed === false && r.result.evaluationType !== "model-based").length;
    const delta = mean(pairs.map(p => p.current.result.score! - p.baseline.result.score!));
    const dimensions = Object.fromEntries([...new Set(pairs.flatMap(p => Object.keys(p.current.result.dimensions)))].map(d => [d, mean(pairs.flatMap(p => { const a = p.current.result.dimensions[d as keyof typeof p.current.result.dimensions], b = p.baseline.result.dimensions[d as keyof typeof p.baseline.result.dimensions]; return a !== undefined && b !== undefined ? [a - b] : []; }))]));
    const baselineRows = baseline.rows.filter(r => `${r.result.profile}|${r.result.evaluationType}|${r.evidence}` === group);
    const sufficient = pairs.length >= policy.minimumSamples && pairs.length === rows.length && pairs.length === baselineRows.length;
    const currentMean = mean(pairs.map(p => p.current.result.score!));
    const status = hardFailures ? "regressed" : !sufficient ? "insufficient-data" : currentMean! < policy.minimum || delta! < -policy.allowedDrop || Object.values(dimensions).some(d => d !== null && d < -policy.allowedDrop) ? "regressed" : delta! > policy.allowedDrop ? "improved" : "stable";
    return { profile, type, evidence, status, pairedSamples: pairs.length, unmatchedCases: rows.length - pairs.length, removedCases: baseline.rows.filter(r => `${r.result.profile}|${r.result.evaluationType}|${r.evidence}` === group && !rows.some(c => key(c) === key(r))).length, hardFailures, quality: currentMean, delta, dimensions,
      costDeltaUsd: mean(pairs.flatMap(p => p.current.costUsd !== null && p.baseline.costUsd !== null ? [p.current.costUsd - p.baseline.costUsd] : [])), latencyDeltaMs: mean(pairs.map(p => p.current.latencyMs - p.baseline.latencyMs)),
      routingRecommendation: sufficient && evidence !== "evaluator-fixture" && status === "regressed" ? "review-quality-floor-or-fallback-chain" : "no-automatic-change" };
  });
}
