import { MEMORY_CONFIG } from "./config";
import type { MemoryCategory, MemoryRecord, MemoryRetrievalInput } from "./types";

const DAY = 86_400_000;

function words(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
}

export function inferMemoryCategories(request: string): MemoryCategory[] {
  const categories = new Set<MemoryCategory>();
  if (/\b(?:career|resume|portfolio|internship|job|role|industry)\b|취업|인턴|커리어/i.test(request)) categories.add("career-goal");
  if (/\b(?:study|exam|course|grade|academic|semester|plan)\b|공부|시험|학업|성적|계획/i.test(request)) categories.add("academic-goal");
  if (/\b(?:explain|learn|understand|quiz|practice|notes?|review|study)\b|설명|학습|퀴즈|연습|노트|복습/i.test(request)) {
    categories.add("learning-pattern");
    categories.add("successful-strategy");
  }
  if (/\b(?:prefer|preferences?|style|length|difficulty|session|schedule|quiz|notes?|explain)\b|선호|스타일|길이|난이도|세션/i.test(request)) categories.add("preference");
  if (/\b(?:remember|memory|goal)\b|기억|목표/i.test(request)) categories.add("user-defined");
  if (!categories.size) categories.add("preference");
  return [...categories];
}

export function memoryIsStale(memory: Pick<MemoryRecord, "category" | "lastObservedAt">, now: Date): boolean {
  const age = Math.max(0, now.getTime() - new Date(memory.lastObservedAt).getTime()) / DAY;
  return age > MEMORY_CONFIG.staleAfterDays[memory.category];
}

export function rankMemory(
  memory: MemoryRecord,
  input: MemoryRetrievalInput,
  requestedCategories: readonly MemoryCategory[],
  requestedKeys: ReadonlySet<string>,
  semanticSimilarity = 0,
): number {
  const requestWords = words(input.request);
  const searchable = words(`${memory.key} ${typeof memory.value === "string" ? memory.value : JSON.stringify(memory.value)}`);
  const overlap = [...requestWords].filter((word) => searchable.has(word)).length;
  const lexical = requestWords.size ? Math.min(25, (overlap / requestWords.size) * 50) : 0;
  const category = requestedCategories.includes(memory.category) ? 32 : 0;
  const key = requestedKeys.has(memory.key) ? 42 : 0;
  const confidence = memory.confidence * 0.18;
  const importance = memory.importance * 0.16;
  const source = memory.sourceType === "explicit" ? 5 : 0;
  const stalePenalty = memory.stale ? 18 : 0;
  const semantic = Math.max(0, Math.min(1, semanticSimilarity)) * 35;
  return category + key + lexical + semantic + confidence + importance + source - stalePenalty;
}
