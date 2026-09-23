import type { ModelRoutingRequest, RoutingSignals, TaskComplexity } from "./types";

/** Extract only coarse features from the original request, never system prompts
 * or retrieved documents. Text stays in memory; the router accepts features only. */
export function requestSignals(text: string): RoutingSignals {
  const proof = /\b(proof|prove|inductiv\w*|theorem|contradiction)\b|증명|귀납/i.test(text);
  const reschedule = text.length < 250 && /\b(move|reschedule|shift)\b|옮겨|이동|변경/.test(text.toLowerCase()) && /session|tomorrow|today|세션|내일|오늘/i.test(text)
    && !/\b(weekly|semester|plan|exams|rebalance|create)\b|주간|학기|계획|시험/i.test(text);
  const extraction = /\b(extract|list)\b.{0,35}\b(key terms?|keywords?|fields?)\b|핵심\s*용어.*추출/i.test(text);
  const career = /skill.?gap|portfolio.{0,30}(analysis|strategy|review)|career.{0,20}(strategy|plan)|진로\s*전략|역량\s*격차/i.test(text);
  return {
    requestCharacters: text.length,
    actionCount: Math.max(1, (text.match(/\b(and then|then|also|compare|explain|evaluate|analyze|create|plan)\b|그리고|분석|비교/gim) ?? []).length),
    proof,
    reasoningSteps: /multi.?step|rigorous|formal proof|복잡한.*증명/i.test(text) ? 5 : proof ? 3 : 0,
    repeatedMisunderstanding: /still.{0,20}(don't|do not|confused|understand)|different (way|approach)|아직.*모르|다른.*방식/i.test(text),
    crossDomain: /cross.?domain|across.{0,20}(courses|disciplines)|여러.*과목/i.test(text),
    semesterStrategy: /semester|학기/i.test(text) && /prioriti|strategy|recover|plan|우선순위|전략|회복|계획/i.test(text),
    ...(reschedule ? { task: "reschedule" as const } : extraction ? { task: "extraction" as const } : career ? { task: "career-strategy" as const } : {}),
  };
}

/** Ordinal thresholds are policy heuristics, not probability/quality estimates.
 * Length alone adds at most one point; independent semantic/workload evidence
 * is needed for escalation. Workflow membership alone never escalates a step. */
export function analyzeComplexity(request: ModelRoutingRequest): { level: TaskComplexity; signals: string[] } {
  const s = request.signals ?? {}, reasons: string[] = [];
  let score = 0;
  const add = (condition: boolean, points: number, name: string) => { if (condition) { score += points; reasons.push(name); } };
  add((s.requestCharacters ?? 0) > 4000, 1, "long-request");
  add((s.actionCount ?? 0) >= 3, 2, "multiple-actions");
  add((s.sourceCount ?? 0) > 0 || (s.ragChunkCount ?? 0) > 0, 2, "source-grounding");
  add(request.contextTokens >= 16_000, 2, "large-context");
  add(request.contextTokens >= 64_000, 3, "very-large-context");
  add((s.sourceCount ?? 0) >= 3, 3, "multi-source");
  add((s.ragChunkCount ?? 0) >= 8, 1, "large-rag");
  add((s.structuredFieldCount ?? 0) > 30, 1, "complex-structure");
  add((s.reasoningSteps ?? 0) >= 3, 2, "multi-step");
  add(!!s.proof || s.grading === "proof", 5, "proof");
  add(s.grading === "long", 5, "long-answer-grading");
  add(!!s.crossDomain, 2, "cross-domain");
  add(!!s.ambiguity, 1, "ambiguity");
  add(!!s.repeatedMisunderstanding, 5, "repeated-misunderstanding");
  add(!!s.planning && s.task !== "reschedule", 3, "planning");
  add(!!s.planning && (s.deadlineCount ?? 0) >= 3, 2, "competing-deadlines");
  add(!!s.planning && (s.courseCount ?? 0) >= 3, 2, "multiple-courses");
  add(!!s.calendarConflicts, 3, "calendar-conflicts");
  add(!!s.semesterStrategy, 5, "semester-strategy");
  add(s.task === "career-strategy", 5, "career-strategy");
  const inferred: TaskComplexity = score >= 10 ? "VERY_HIGH" : score >= 5 ? "HIGH" : score >= 2 ? "MEDIUM" : "LOW";
  const levels: TaskComplexity[] = ["LOW", "MEDIUM", "HIGH", "VERY_HIGH"];
  return { level: levels[Math.max(levels.indexOf(inferred), levels.indexOf(request.requestComplexity ?? "LOW"))], signals: reasons };
}
