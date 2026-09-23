import "dotenv/config";
import { readFile } from "node:fs/promises";
import { reportSchema } from "../server/ai/evaluation/runner";
import { assessReleaseQuality, CORE_RELEASE_PROFILES } from "../server/ai/evaluation/release-gate";

const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
try {
  const baseline = value("--baseline"), report = value("--report");
  if (!baseline || !report) throw new Error("RELEASE_REPORTS_REQUIRED");
  const load = async (file: string) => reportSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const result = assessReleaseQuality(await load(baseline), await load(report), args.includes("--include-career") ? [...CORE_RELEASE_PROFILES, "career"] : CORE_RELEASE_PROFILES);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch {
  console.error("Release quality evidence is missing or invalid. Supply reviewed FULL baseline and candidate reports; no provider calls were made.");
  process.exitCode = 1;
}
