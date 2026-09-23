import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assessReleaseQuality, CORE_RELEASE_PROFILES } from "@/server/ai/evaluation/release-gate";
import { QUALITY_PROFILES } from "@/server/ai/evaluation/profiles";
import { runEvals, type EvalReport, type EvalRow } from "@/server/ai/evaluation/runner";
import type { ProfileId } from "@/server/ai/evaluation/types";

afterEach(() => vi.unstubAllEnvs());
// These fabricated reports test the gate only; they are never launch evidence.
function report(profiles: readonly ProfileId[] = CORE_RELEASE_PROFILES): EvalReport {
  const rows: EvalRow[] = profiles.flatMap(profile => Array.from({ length: 5 }, (_, index) => {
    const semantic = QUALITY_PROFILES[profile].semantic;
    return { caseId: `${profile}-${index}`, datasetVersion: "synthetic-gate-test", promptVersion: "prompt", routingVersion: "routing", contextVersion: "context",
      evidence: semantic.length ? "generated" : "system", model: semantic.length ? "fixture-generator" : null, provider: semantic.length ? "fixture-provider" : null,
      judgeModel: semantic.length ? "fixture-judge" : null, tier: "STRONG", fallbackUsed: false, latencyMs: 1, costUsd: null, judgeCostUsd: null,
      result: { profile, evaluationType: semantic.length ? "model-based" : "deterministic", evaluatorVersion: "quality-v1", score: 1, passed: true,
        dimensions: Object.fromEntries(semantic.map(d => [d, 1])), unmeasured: [], failures: [], metrics: {}, checks: [] } } satisfies EvalRow;
  }));
  return { version: 1, mode: "FULL", createdAt: "2026-09-23T00:00:00Z", failedChecks: 0, rows };
}
describe("release quality evidence gate", () => {
  it("accepts sufficiently paired complete observations without altering thresholds", () => {
    expect(assessReleaseQuality(report(), report()).passed).toBe(true);
    expect(QUALITY_PROFILES["study-planner"].minimum).toBe(.99);
  });
  it("does not accept the real passing offline suite as generated quality evidence", async () => {
    const offline = await runEvals({ mode: "FULL" });
    expect(offline.failedChecks).toBe(0);
    expect(assessReleaseQuality(offline, offline).passed).toBe(false);
  });
  it.each(["evaluator-fixture", "missing-model", "missing-provider", "missing-judge", "missing-dimension", "unmeasured", "null-score"])("rejects %s despite a perfect aggregate", condition => {
    const candidate = report(), row = candidate.rows[0];
    if (condition === "evaluator-fixture") row.evidence = "evaluator-fixture";
    if (condition === "missing-model") row.model = null;
    if (condition === "missing-provider") row.provider = "unknown";
    if (condition === "missing-judge") row.judgeModel = null;
    if (condition === "missing-dimension") delete row.result.dimensions.correctness;
    if (condition === "unmeasured") row.result.unmeasured = ["sourceFaithfulness"];
    if (condition === "null-score") row.result.score = null;
    expect(assessReleaseQuality(report(), candidate).passed).toBe(false);
  });
  it("rejects missing profiles and insufficient/removed or incompatible paired samples", () => {
    for (const alter of [
      (r: EvalReport) => { r.rows = r.rows.filter(row => row.result.profile !== "quiz"); },
      (r: EvalReport) => { r.rows.shift(); },
      (r: EvalReport) => { r.rows[0].datasetVersion = "different"; },
      (r: EvalReport) => { r.rows[0].judgeModel = "different"; },
    ]) { const candidate = report(); alter(candidate); expect(assessReleaseQuality(report(), candidate).passed).toBe(false); }
  });
  it("does not hide failed observations behind a forged zero failedChecks count", () => {
    const candidate = report(); candidate.rows[0].result.passed = false;
    expect(assessReleaseQuality(report(), candidate).failures).toContainEqual({ profile: "release", code: "FAILED_OBSERVATIONS" });
  });
  it("rejects unjudged executions and a below-floor or regressed candidate", () => {
    const candidate = report(); candidate.rows.push({ ...candidate.rows[0], caseId: "unjudged", result: { ...candidate.rows[0].result, evaluationType: "deterministic" } });
    expect(assessReleaseQuality(report(), candidate).failures).toContainEqual({ profile: "tutor", code: "CANDIDATE_MISSING_JUDGMENTS" });
    const low = report(); low.rows.filter(row => row.result.profile === "tutor").forEach(row => { row.result.score = .7; });
    expect(assessReleaseQuality(report(), low).passed).toBe(false);
  });
  it("requires real measured RAG faithfulness independently of retrieval", () => {
    const candidate = report(); candidate.rows.filter(row => row.result.profile === "rag-generation").forEach(row => { row.result.unmeasured = ["sourceFaithfulness"]; });
    expect(assessReleaseQuality(report(), candidate).passed).toBe(false);
  });
  it("gates Career when included and rejects duplicate evidence and partial reports", () => {
    expect(assessReleaseQuality(report(), report(), [...CORE_RELEASE_PROFILES, "career"]).passed).toBe(false);
    const duplicate = report(); duplicate.rows.push(duplicate.rows[0]); expect(() => assessReleaseQuality(report(), duplicate)).toThrow();
    expect(assessReleaseQuality(report(), { ...report(), mode: "FAST_SMOKE" }).passed).toBe(false);
  });
  it("command fails closed without reports and rejects an insufficient baseline comparison", async () => {
    const folder = await mkdtemp(join(tmpdir(), "quality-gate-"));
    try {
      const args = ["--conditions=react-server", "--import", "tsx"];
      const missing = spawnSync(process.execPath, [...args, "scripts/check-release-quality.ts"], { encoding: "utf8" });
      expect(missing.status).toBe(1); expect(missing.stderr).toContain("evidence is missing");
      const baseline = join(folder, "baseline.json");
      await writeFile(baseline, JSON.stringify(await runEvals({ mode: "FULL" })));
      const checked = spawnSync(process.execPath, [...args, "scripts/check-release-quality.ts", "--baseline", baseline, "--report", baseline], { encoding: "utf8" });
      expect(checked.status).toBe(1); expect(JSON.parse(checked.stdout).passed).toBe(false);
      const comparison = spawnSync(process.execPath, [...args, "scripts/run-evals.ts", "--mode", "FULL", "--baseline", baseline], { encoding: "utf8" });
      expect(comparison.status).toBe(1); expect(comparison.stdout).toContain("insufficient-data");
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
});
