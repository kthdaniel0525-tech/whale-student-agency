import "dotenv/config";
import { randomUUID } from "node:crypto";
import { access, link, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  baselineReviewSchema,
  createFirstReleaseBaseline,
  serializeBaselineReport,
} from "../server/ai/evaluation/baseline-bootstrap";
import { reportSchema } from "../server/ai/evaluation/runner";

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const reportPath = value("--report");
  const reviewPath = value("--review");
  const baselinePath = value("--out-baseline");
  const provenancePath = value("--out-provenance");
  if (!reportPath || !reviewPath || !baselinePath || !provenancePath) {
    throw new Error("BOOTSTRAP_ARGUMENTS_REQUIRED");
  }
  const baseline = resolve(baselinePath);
  const provenance = resolve(provenancePath);
  if (baseline === provenance || dirname(baseline) !== dirname(provenance)) {
    throw new Error("BOOTSTRAP_OUTPUT_PATHS_INVALID");
  }
  if (await exists(baseline) || await exists(provenance)) {
    throw new Error("BASELINE_ALREADY_EXISTS");
  }
  const report = reportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
  const review = baselineReviewSchema.parse(JSON.parse(await readFile(reviewPath, "utf8")));
  const result = createFirstReleaseBaseline(report, review);
  if (!result.assessment.eligible || !result.report || !result.provenance) {
    console.log(JSON.stringify(result.assessment, null, 2));
    process.exitCode = 1;
    return;
  }

  const suffix = `${process.pid}-${randomUUID()}`;
  const temporaryBaseline = `${baseline}.tmp-${suffix}`;
  const temporaryProvenance = `${provenance}.tmp-${suffix}`;
  let provenanceInstalled = false;
  let baselineInstalled = false;
  try {
    await writeFile(
      temporaryBaseline,
      serializeBaselineReport(result.report),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await writeFile(
      temporaryProvenance,
      `${JSON.stringify(result.provenance, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    // The gate-consumed baseline appears last, after its review sidecar exists.
    await link(temporaryProvenance, provenance);
    provenanceInstalled = true;
    await unlink(temporaryProvenance);
    await link(temporaryBaseline, baseline);
    baselineInstalled = true;
    await unlink(temporaryBaseline);
  } catch (error) {
    await Promise.allSettled([
      unlink(temporaryBaseline),
      unlink(temporaryProvenance),
      ...(provenanceInstalled ? [unlink(provenance)] : []),
      ...(baselineInstalled ? [unlink(baseline)] : []),
    ]);
    throw error;
  }
  console.log(JSON.stringify({
    status: "BASELINE_ESTABLISHED",
    comparisonStatus: "NOT_PERFORMED_FIRST_RELEASE",
    baseline,
    provenance,
    reportSha256: result.provenance.reportSha256,
    profiles: result.provenance.profiles,
  }, null, 2));
}

main().catch(() => {
  console.error("First-release baseline bootstrap was blocked; no baseline comparison was claimed and no output was written.");
  process.exitCode = 1;
});
