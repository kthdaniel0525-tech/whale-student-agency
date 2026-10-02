import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  baselineProvenanceSchema,
  createFirstReleaseBaseline,
} from "@/server/ai/evaluation/baseline-bootstrap";
import {
  assessBaselineEligibility,
  assessReleaseQuality,
  CORE_RELEASE_PROFILES,
} from "@/server/ai/evaluation/release-gate";
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
  const review = {
    version: 1 as const,
    reviewStatus: "reviewed" as const,
    reviewedAt: "2026-10-02T20:00:00Z",
    reviewer: "release-reviewer",
    commitSha: "5c7880f0c31180a4b119e0ea51ab812fd02836e7",
    immutableImage: "ghcr.io/example/project@sha256:8141a8e7aca147cfc1ea5a1ea680a141524ef1088cd413cffdd79ae19d8979aa",
    environment: "staging" as const,
  };

  it("accepts sufficiently paired complete observations without altering thresholds", () => {
    expect(assessReleaseQuality(report(), report())).toMatchObject({
      status: "BASELINE_COMPARISON_PASS",
      passed: true,
    });
    expect(QUALITY_PROFILES["study-planner"].minimum).toBe(.99);
  });
  it("does not accept the real passing offline suite as generated quality evidence", async () => {
    const offline = await runEvals({ mode: "FULL" });
    expect(offline.failedChecks).toBe(0);
    expect(assessReleaseQuality(offline, offline).passed).toBe(false);
  });
  it("establishes an eligible first baseline without claiming a historical comparison", () => {
    const input = report();
    const result = createFirstReleaseBaseline(input, review);
    expect(result.assessment).toMatchObject({
      eligible: true,
      status: "BASELINE_ESTABLISHED",
    });
    expect(result.report).toEqual(input);
    expect(baselineProvenanceSchema.parse(result.provenance)).toMatchObject({
      baselineStatus: "BASELINE_ESTABLISHED",
      comparisonStatus: "NOT_PERFORMED_FIRST_RELEASE",
      reviewStatus: "reviewed",
      commitSha: review.commitSha,
      immutableImage: review.immutableImage,
    });
  });
  it("blocks baseline bootstrap when core reviewed evidence is incomplete", async () => {
    const incomplete = report(["quiz", "workflow"]);
    expect(assessBaselineEligibility(incomplete)).toMatchObject({
      eligible: false,
      status: "BASELINE_BOOTSTRAP_BLOCKED",
    });
    expect(assessBaselineEligibility(await runEvals({ mode: "FULL" })).eligible).toBe(false);
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
  it("writes a first baseline and review sidecar only for a complete eligible report", async () => {
    const folder = await mkdtemp(join(tmpdir(), "quality-bootstrap-"));
    try {
      const input = join(folder, "candidate.json");
      const reviewPath = join(folder, "review.json");
      const baseline = join(folder, "known-good.json");
      const provenance = join(folder, "known-good.provenance.json");
      await writeFile(input, JSON.stringify(report()));
      await writeFile(reviewPath, JSON.stringify(review));
      const command = spawnSync(process.execPath, [
        "--conditions=react-server",
        "--import",
        "tsx",
        "scripts/bootstrap-release-quality.ts",
        "--report",
        input,
        "--review",
        reviewPath,
        "--out-baseline",
        baseline,
        "--out-provenance",
        provenance,
      ], { encoding: "utf8" });
      expect(command.status).toBe(0);
      expect(JSON.parse(command.stdout)).toMatchObject({
        status: "BASELINE_ESTABLISHED",
        comparisonStatus: "NOT_PERFORMED_FIRST_RELEASE",
      });
      expect(report()).toEqual(JSON.parse(await readFile(baseline, "utf8")));
      expect(baselineProvenanceSchema.parse(
        JSON.parse(await readFile(provenance, "utf8")),
      ).reportSha256).toMatch(/^[0-9a-f]{64}$/);
      const repeated = spawnSync(process.execPath, [
        "--conditions=react-server",
        "--import",
        "tsx",
        "scripts/bootstrap-release-quality.ts",
        "--report",
        input,
        "--review",
        reviewPath,
        "--out-baseline",
        baseline,
        "--out-provenance",
        provenance,
      ], { encoding: "utf8" });
      expect(repeated.status).toBe(1);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
