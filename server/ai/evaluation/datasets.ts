import "server-only";
import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PROFILE_IDS, type EvaluationContext } from "./types";
import { versionHash } from "./versions";
export const MODES = ["FAST_SMOKE", "STANDARD", "FULL"] as const;
export type EvalMode = typeof MODES[number];
const caseSchema = z.object({ id: z.string().regex(/^[a-z0-9-]+$/), profile: z.enum(PROFILE_IDS), request: z.string(), engine: z.enum(["fixture", "dispatcher", "model-router", "grading", "personalization", "adaptive", "continuity"]), input: z.record(z.unknown()).default({}), context: z.record(z.unknown()), modes: z.array(z.enum(MODES)).min(1) }).strict();
const datasetSchema = z.object({ version: z.string().regex(/^[a-z0-9-]+$/), synthetic: z.literal(true), cases: z.array(caseSchema).min(1) }).strict();
export type EvaluationCase = Omit<z.infer<typeof caseSchema>, "context"> & { context: Omit<EvaluationContext, "profile" | "request">; datasetVersion: string };
export async function loadCases(mode: EvalMode, suite?: string, directory = path.join(process.cwd(), "evals")): Promise<EvaluationCase[]> {
  const dirs = (await readdir(directory, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort();
  const cases: EvaluationCase[] = [];
  for (const dir of dirs) {
    const file = path.join(directory, dir, "cases.json");
    let raw: string; try { raw = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const dataset = datasetSchema.parse(JSON.parse(raw));
    for (const c of dataset.cases) if (c.modes.includes(mode) && (!suite || suite === "all" || c.profile === suite || dir === suite)) cases.push({ ...c, context: c.context as EvaluationCase["context"], datasetVersion: `${dataset.version}:${versionHash(dataset)}` });
  }
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("EVAL_DUPLICATE_CASE");
  if (!cases.length) throw new Error("EVAL_EMPTY_SUITE");
  return cases;
}
