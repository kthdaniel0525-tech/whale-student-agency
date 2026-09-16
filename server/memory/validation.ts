import { z } from "zod";
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryValue } from "./types";

export const memoryCategorySchema = z.enum(MEMORY_CATEGORIES);
export const memoryStatusSchema = z.enum(["candidate", "active", "archived"]);
const boundedString = z.string().trim().min(1).max(500);
const boundedScalar = z.union([boundedString, z.number().finite(), z.boolean()]);
const boundedValue = z.union([
  boundedScalar,
  z.array(boundedScalar).min(1).max(20),
  z.record(z.string().min(1).max(40), z.union([boundedScalar, z.array(boundedScalar).min(1).max(20)])).refine((value) => Object.keys(value).length <= 12),
]);

const aliases = new Map<string, string>([
  ["explanationstyle", "explanationStyle"],
  ["preferredexplanationstyle", "explanationStyle"],
  ["answerlength", "answerLength"],
  ["preferredanswerlength", "answerLength"],
  ["studysessionminutes", "studySessionMinutes"],
  ["preferredstudysessionminutes", "studySessionMinutes"],
  ["quizdifficulty", "quizDifficulty"],
  ["preferredquizdifficulty", "quizDifficulty"],
  ["questiontype", "questionType"],
  ["preferredquestiontype", "questionType"],
  ["notestyle", "noteStyle"],
  ["preferrednotestyle", "noteStyle"],
  ["planningintensity", "planningIntensity"],
  ["preferredstudytime", "preferredStudyTime"],
  ["academicgoal", "academicGoal"],
  ["targetgrade", "targetGrade"],
  ["coursegoal", "courseGoal"],
  ["examgoal", "examGoal"],
  ["targetrole", "targetRole"],
  ["targetindustry", "targetIndustry"],
  ["targetcompanies", "targetCompanies"],
  ["internshiptimeline", "internshipTimeline"],
  ["portfoliogoal", "portfolioGoal"],
]);

const preferenceKeys = new Set([
  "explanationStyle", "answerLength", "studySessionMinutes", "quizDifficulty",
  "questionType", "noteStyle", "planningIntensity", "preferredStudyTime",
]);
const academicGoalKeys = new Set(["academicGoal", "targetGrade", "courseGoal", "examGoal"]);
const careerGoalKeys = new Set(["targetRole", "targetIndustry", "targetCompanies", "internshipTimeline", "portfolioGoal"]);
const sensitiveKey = /(?:password|passcode|secret|token|api[-_ ]?key|social[-_ ]?security|credit[-_ ]?card|medical|diagnos|health)/i;

export function normalizeMemoryKey(category: MemoryCategory, raw: string): string {
  const trimmed = raw.normalize("NFKC").trim();
  if (!trimmed || trimmed.length > 80 || sensitiveKey.test(trimmed)) throw new Error("INVALID_MEMORY");
  const token = trimmed.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const known = aliases.get(token);
  if (known) return known;
  const custom = trimmed.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  if (!custom) throw new Error("INVALID_MEMORY");
  if (category === "preference") throw new Error("INVALID_MEMORY");
  return custom;
}

function enumValue(value: unknown, values: readonly string[]): string {
  if (typeof value !== "string") throw new Error("INVALID_MEMORY");
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[ _]+/g, "-");
  if (!values.includes(normalized)) throw new Error("INVALID_MEMORY");
  return normalized;
}

export function validateMemoryValue(category: MemoryCategory, key: string, raw: unknown): MemoryValue {
  if (category === "preference" && !preferenceKeys.has(key)) throw new Error("INVALID_MEMORY");
  if (category === "academic-goal" && !academicGoalKeys.has(key) && !/^(?:course|exam)-goal-/.test(key)) throw new Error("INVALID_MEMORY");
  if (category === "career-goal" && !careerGoalKeys.has(key)) throw new Error("INVALID_MEMORY");
  if (key === "studySessionMinutes") {
    const value = typeof raw === "string" && /^\d{1,3}$/.test(raw.trim()) ? Number(raw) : raw;
    const parsed = z.number().int().min(15).max(180).safeParse(value);
    if (!parsed.success) throw new Error("INVALID_MEMORY");
    return parsed.data;
  }
  if (key === "explanationStyle") return enumValue(raw, ["concise", "detailed", "step-by-step", "socratic", "concise-with-examples", "examples-first", "visual-examples"]);
  if (key === "answerLength") return enumValue(raw, ["concise", "standard", "detailed"]);
  if (key === "quizDifficulty") return enumValue(raw, ["easy", "medium", "hard"]);
  if (key === "questionType") return enumValue(raw, ["multiple-choice", "true-false", "short-answer", "long-answer", "mixed"]);
  if (key === "noteStyle") return enumValue(raw, ["outline", "structured", "concise", "detailed", "flashcards"]);
  if (key === "planningIntensity") return enumValue(raw, ["light", "balanced", "intensive"]);
  if (key === "preferredStudyTime") return enumValue(raw, ["morning", "afternoon", "evening", "late-night", "flexible"]);
  if (key === "targetCompanies") {
    const parsed = z.array(z.string().trim().min(1).max(120)).min(1).max(10).safeParse(raw);
    if (!parsed.success) throw new Error("INVALID_MEMORY");
    return [...new Set(parsed.data)];
  }
  const parsed = boundedValue.safeParse(raw);
  if (!parsed.success) throw new Error("INVALID_MEMORY");
  return parsed.data;
}

export function serializeMemoryValue(value: MemoryValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function deserializeMemoryValue(category: MemoryCategory, key: string, raw: string): MemoryValue {
  let value: unknown = raw;
  if (/^(?:\[|\{|true$|false$|-?\d)/.test(raw.trim())) {
    try { value = JSON.parse(raw); } catch { value = raw; }
  }
  return validateMemoryValue(category, normalizeMemoryKey(category, key), value);
}

