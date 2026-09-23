import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { runEvals, reportSchema } from "../server/ai/evaluation/runner";
import { MODES } from "../server/ai/evaluation/datasets";
import { compareEvaluations } from "../server/ai/evaluation/comparison";
import { MODEL_TIERS } from "../server/ai/routing/types";
const args = process.argv.slice(2);
const get = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const mode = z.enum(MODES).parse(get("--mode") ?? "FAST_SMOKE"), live = args.includes("--live");
if ((get("--model") || get("--compare-model") || get("--tier") || args.includes("--judge")) && !live) throw new Error("Model execution requires explicit --live (paid synthetic calls).");
const provider = live ? (await import("../server/ai")).getAIProvider() : undefined;
const options = { mode, suite: get("--suite"), modelOverride: get("--model"), routingOverride: z.enum(MODEL_TIERS).optional().parse(get("--tier")), allowLive: live, provider, providerId: "openai", judge: args.includes("--judge") ? provider : undefined, judgeProviderId: "openai" };
const report = await runEvals(options);
const output = get("--out");
if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
const baseline = get("--baseline");
const comparison = baseline ? compareEvaluations(reportSchema.parse(JSON.parse(await readFile(baseline, "utf8"))), report) : undefined;
let failed = report.failedChecks > 0 || !!comparison?.some(c => !["stable", "improved"].includes(c.status));
console.log(JSON.stringify({ mode, cases: new Set(report.rows.map(r => r.caseId)).size, failedChecks: report.failedChecks, evidence: [...new Set(report.rows.map(r => r.evidence))], ...(comparison ? { comparison } : {}), ...(output ? { report: output } : {}) }, null, 2));
if (get("--compare-model")) {
  const candidate = await runEvals({ ...options, modelOverride: get("--compare-model") });
  const modelComparison = compareEvaluations(report, candidate);
  console.log(JSON.stringify({ modelComparison }, null, 2));
  failed ||= candidate.failedChecks > 0 || modelComparison.some(c => !["stable", "improved"].includes(c.status));
  if (output) await writeFile(`${output}.comparison.json`, JSON.stringify(candidate, null, 2) + "\n");
}
if (failed) process.exitCode = 1;
