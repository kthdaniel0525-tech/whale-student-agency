import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateDeterministic as evaluate } from "@/server/ai/evaluation/deterministic";
import { evaluateWithJudge, judgeSchema } from "@/server/ai/evaluation/judge";
import { QUALITY_PROFILES, qualityProfile } from "@/server/ai/evaluation/profiles";
import { loadCases } from "@/server/ai/evaluation/datasets";
import { executeSyntheticCase, runEvals, type EvalReport, type EvalRow } from "@/server/ai/evaluation/runner";
import { compareEvaluations } from "@/server/ai/evaluation/comparison";
import { promptVersion, routingVersion } from "@/server/ai/evaluation/versions";
import { selectedForSampling, samplingConfig } from "@/server/ai/evaluation/sampling";
import { evaluationJobPayload } from "@/server/jobs/evaluate-ai-response";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import { resultSchema, type EvaluationContext } from "@/server/ai/evaluation/types";
const source = { id: "doc:0", documentId: "doc", chunkIndex: 0, content: "Assume P(k) and prove P(k+1)." };
const tutor: EvaluationContext = { profile: "tutor", request: "Explain induction.", output: "Assume P(k), prove P(k+1).", sources: [source], citedSourceIds: [source.id], requiresGrounding: true };
function judge(data?: unknown) {
  const generateStructuredOutput = vi.fn(async <T>(request: AIStructuredRequest<T>) => ({ id: "judge-fixture", data: request.schema.parse(data ?? { judgments: QUALITY_PROFILES.tutor.semantic.map(d => ({ dimension: d, score: 1, failures: [], rationale: "Supported by the supplied evidence." })) }), model: "capable-judge", text: "", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }));
  return { provider: { generateStructuredOutput, generateText: vi.fn(), generateEmbedding: vi.fn(), streamText: vi.fn() } as AIProvider, call: generateStructuredOutput };
}
afterEach(() => vi.unstubAllEnvs());
describe("shared quality evaluators", () => {
  it("uses versioned per-feature thresholds and normalized, strict records", () => {
    expect(Object.keys(QUALITY_PROFILES)).toHaveLength(15);
    expect(qualityProfile("study-planner").minimum).toBe(.99);
    expect(resultSchema.safeParse({ ...evaluate(tutor), score: 80 }).success).toBe(false);
    expect(resultSchema.safeParse({ ...evaluate(tutor), chainOfThought: "private" }).success).toBe(false);
  });
  it("does not call citation presence semantic faithfulness", () => {
    const r = evaluate(tutor); expect(r.passed).toBe(true); expect(r.dimensions.sourceFaithfulness).toBeUndefined(); expect(r.unmeasured).toContain("sourceFaithfulness");
    expect(evaluate({ ...tutor, citedSourceIds: ["invented"] }).failures).toContain("WRONG_SOURCE");
    expect(evaluate({ ...tutor, sources: [], requestedSourceIds: ["doc"] }).passed).toBe(false);
  });
  it("checks empty Tutor output and requested format/length", () => {
    expect(evaluate({ ...tutor, output: "", expected: { format: "bullets" } }).passed).toBe(false);
    expect(evaluate({ ...tutor, expected: { maxWords: 1 } }).failures).toContain("OVERLY_VERBOSE");
  });
  it("checks Notes source coverage without claiming lexical overlap proves grounding", () => {
    const r = evaluate({ ...tutor, profile: "notes", expected: { requiredTerms: ["P(k)", "base case"] } });
    expect(r.dimensions.completeness).toBe(.5); expect(r.unmeasured).toContain("groundedness");
  });
  it("uses a capable structured judge and stores no rationale or chain of thought", async () => {
    const j = judge(), result = await evaluateWithJudge(tutor, { provider: j.provider });
    expect(result.result.score).toBe(1); expect(j.call.mock.calls[0][0].routing?.minimumTier).toBe("STRONG");
    expect(JSON.stringify(result)).not.toContain("Supported by"); expect(j.call.mock.calls[0][0].usageContext?.operationType).toBe("evaluation");
    expect(judgeSchema.safeParse({ judgments: [{ dimension: "correctness", score: .81, failures: [], rationale: "x" }] }).success).toBe(false);
  });
  it("leaves faithfulness unknown without source passages, even when judge says perfect", async () => {
    const r = await evaluateWithJudge({ ...tutor, sources: [] }, { provider: judge().provider });
    expect(r.result.dimensions.sourceFaithfulness).toBeUndefined(); expect(r.result.unmeasured).toContain("sourceFaithfulness");
  });
  it("rejects duplicated/missing judgments and oversized input instead of silently truncating", async () => {
    await expect(evaluateWithJudge(tutor, { provider: judge({ judgments: [{ dimension: "correctness", score: 1, failures: [], rationale: "x" }] }).provider })).rejects.toThrow("EVAL_INVALID_JUDGMENT");
    await expect(evaluateWithJudge({ ...tutor, request: "x".repeat(81000) }, { provider: judge().provider })).rejects.toThrow("TOO_LARGE");
  });
  it("detects source-unfaithful generated claims separately from retrieved IDs", async () => {
    const judgments = QUALITY_PROFILES["rag-generation"].semantic.map(d => ({ dimension: d, score: 0, failures: ["UNGROUNDED"], rationale: "The passage says P(k); the answer says only P(1)." }));
    const result = await evaluateWithJudge({ ...tutor, profile: "rag-generation", output: "The hypothesis only proves P(1)." }, { provider: judge({ judgments }).provider });
    expect(result.result.passed).toBe(false); expect(result.result.dimensions.sourceFaithfulness).toBe(0);
  });
  it("validates MCQ answers, true/false types, duplicate prompts and difficulty labels", async () => {
    const c = (await loadCases("FULL", "quiz")).find(c => c.profile === "quiz")!;
    const context = { ...c.context, profile: c.profile, request: c.request };
    expect(evaluate(context).passed).toBe(true);
    const output = structuredClone(context.output) as { questions: Array<{ correctAnswer: string; type: string; choices: string[] }>; difficulty: string };
    output.questions[0].correctAnswer = "not a choice";
    expect(evaluate({ ...context, output }).failures).toContain("INVALID_STRUCTURE");
    output.questions[0].type = "true-false"; output.questions[0].choices = ["True", "False"]; output.questions[0].correctAnswer = "Maybe";
    expect(evaluate({ ...context, output }).passed).toBe(false);
    expect(evaluate({ ...context, output: { ...context.output as object, difficulty: "hard" } }).failures).toContain("WRONG_DIFFICULTY");
  });
  it("runs objective golden grades through the production grading helper", async () => {
    for (const c of (await loadCases("FULL", "quiz")).filter(c => c.engine === "grading")) expect(evaluate({ ...c.context, profile: c.profile, request: c.request, output: await executeSyntheticCase(c) }).dimensions.gradingReliability).toBe(1);
    expect(evaluate({ profile: "grading", request: "grade", output: { correct: false, score: 0 }, expected: { correct: true, scoreRange: [.9, 1] } }).metrics.disagreement).toBe(1);
  });
  it("rejects planner availability/deadline violations and lost completed work", async () => {
    const c = (await loadCases("FULL", "planner"))[0], context = { ...c.context, profile: c.profile, request: c.request };
    expect(evaluate(context).passed).toBe(true);
    expect(evaluate({ ...context, expected: { ...context.expected, availability: [{ date: "2026-10-01", availableMinutes: 15 }] } }).failures).toContain("UNREALISTIC_PLAN");
    expect(evaluate({ ...context, expected: { ...context.expected, deadlines: { "weak-induction": "2026-09-30" } } }).passed).toBe(false);
    expect(evaluate({ ...context, expected: { ...context.expected, completedTaskIds: ["lost"] } }).passed).toBe(false);
  });
  it("detects calendar conflicts and reports missing exact-time coverage honestly", async () => {
    const c = (await loadCases("FULL", "planner"))[0], context = { ...c.context, profile: c.profile, request: c.request };
    expect(evaluate({ ...context, expected: { ...context.expected, busyIntervals: [{ start: "2026-10-01T15:15:00Z", end: "2026-10-01T16:00:00Z" }] } }).passed).toBe(false);
    const o = { ...context.output as object, scheduledSessions: [] };
    expect(evaluate({ ...context, output: o }).metrics.calendarCoverage).toBe(0);
  });
  it("checks Manager urgent priorities and Career metrics against trusted facts", () => {
    expect(evaluate({ profile: "academic-manager", request: "prioritize", output: { priorityIds: ["optional"] }, expected: { urgentIds: ["overdue"], allowedIds: ["overdue"] } }).failures).toEqual(expect.arrayContaining(["INCOMPLETE", "FABRICATED_DATA"]));
    expect(evaluate({ profile: "career", request: "resume", output: "Improved performance by 80%", expected: { allowedNumbers: [] } }).failures).toContain("FABRICATED_DATA");
  });
  it("measures recall/hit/precision separately from generation", () => {
    const r = evaluate({ profile: "rag-retrieval", request: "induction", output: { chunkIds: ["a", "a", "bad"] }, expected: { relevantChunkIds: ["a", "b"], k: 5 } });
    expect(r.metrics).toEqual({ recallAtK: .5, hitAtK: 1, precisionAtK: .5 }); expect(r.dimensions.sourceFaithfulness).toBeUndefined();
  });
  it("checks bounded recovery loops and artifacts rather than using mastery improvement as proof", () => {
    const r = evaluate({ profile: "workflow", request: "recover", output: { status: "completed", totalCalls: 10, startingMastery: 20, endingMastery: 95, artifactIds: [] }, expected: { maximumCalls: 4, requiredTerms: ["quiz"] } });
    expect(r.passed).toBe(false); expect(r.metrics.endingMastery).toBe(95); expect(r.unmeasured).toContain("actionability");
  });
});
describe("offline execution, versions, privacy and regression", () => {
  it.each(["FAST_SMOKE", "STANDARD", "FULL"] as const)("runs %s with real deterministic behavior and no provider calls", async mode => {
    const report = await runEvals({ mode }); expect(report.failedChecks).toBe(0);
    expect(report.rows.some(r => r.evidence === "system")).toBe(true);
    expect(report.rows.every(r => (r.result.profile === "model-router" || r.model === null) && r.judgeModel === null)).toBe(true);
  });
  it("covers all profiles; actual dispatcher routing allows multiple ambiguous labels", async () => {
    const cases = await loadCases("FULL"), profiles = new Set(cases.map(c => c.profile)); expect(profiles.size).toBe(15);
    const c = cases.find(c => c.id === "dispatcher-ambiguous")!; expect(c.context.expected!.acceptableTargets!.length).toBeGreaterThan(1);
    expect(evaluate({ ...c.context, profile: c.profile, request: c.request, output: { targetType: "agent", targetId: "tutor" } }).passed).toBe(true);
    expect(evaluate({ ...c.context, profile: c.profile, request: c.request, output: { targetType: "agent", targetId: "career" } }).passed).toBe(false);
  });
  it("executes long conversation correction, personalization precedence and adaptive response", async () => {
    const cases = await loadCases("FULL");
    for (const profile of ["continuity", "personalization", "adaptive"]) {
      const c = cases.find(c => c.profile === profile)!;
      expect(evaluate({ ...c.context, profile: c.profile, request: c.request, output: await executeSyntheticCase(c) }).passed).toBe(true);
    }
  });
  it("makes paid calls opt-in and accepts controlled execution observations", async () => {
    await expect(runEvals({ mode: "FAST_SMOKE", provider: judge().provider })).rejects.toThrow("OPT_IN");
    const c = (await loadCases("FULL", "tutor"))[0];
    const result = await runEvals({ mode: "FULL", cases: [c], execute: async () => ({ output: c.context.output, model: "fixture-boundary", provider: "test", tier: "STRONG", fallbackUsed: true, costUsd: .01 }) });
    expect(result.rows[0]).toMatchObject({ evidence: "system", model: "fixture-boundary", tier: "STRONG", fallbackUsed: true, costUsd: .01 });
  });
  it("executes opt-in generation at the provider boundary without treating reference output as generated output", async () => {
    const c = (await loadCases("STANDARD", "tutor"))[0];
    const generateText = vi.fn<AIProvider["generateText"]>().mockResolvedValue({ id: "generated-fixture", model: "model-under-test", text: String(c.context.output) });
    const provider = { ...judge().provider, generateText };
    const report = await runEvals({ mode: "STANDARD", cases: [c], provider, allowLive: true, providerId: "test" });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0][0].routing?.signals?.ragChunkCount).toBe(1);
    expect(report.rows[0]).toMatchObject({ evidence: "generated", model: "model-under-test", provider: "test", fallbackUsed: null });
    expect(report.rows[0].result.unmeasured).toContain("correctness");
    expect(report.rows[0].result.checks.find(c => c.id === "citation-provenance")?.score).toBe(1);
  });
  it("runs semantic grading references through the shared production structured boundary", async () => {
    const c = (await loadCases("FULL", "quiz")).find(c => c.id === "grading-semantic-reference")!;
    const generateStructuredOutput = vi.fn(async <T>(r: AIStructuredRequest<T>) => ({ id: "grade", model: "grader", text: "", data: r.schema.parse({ correct: true, score: 1, feedback: "Correct.", explanation: "Both obligations are present." }) }));
    const provider = { ...judge().provider, generateStructuredOutput } as AIProvider;
    const report = await runEvals({ mode: "FULL", cases: [c], provider, allowLive: true });
    expect(report.failedChecks).toBe(0);
    expect(generateStructuredOutput.mock.calls[0][0].schemaName).toBe("quiz_answer_evaluation");
    expect(generateStructuredOutput.mock.calls[0][0].messages[1].content).toContain(String(c.input.expectedAnswer));
  });
  it("does not count duplicated report rows as independent statistical evidence", () => {
    const b = report(1, 1), c = report(1, 1); c.rows.push(c.rows[0]);
    expect(() => compareEvaluations(b, c)).toThrow("independent samples");
  });
  it("reports generation/judge failures safely and continues the suite", async () => {
    const cases = (await loadCases("STANDARD", "tutor")).slice(0, 2);
    const generateText = vi.fn().mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_BODY")).mockResolvedValueOnce({ id: "generated", model: "test", text: "Base case and inductive step." });
    const report = await runEvals({ mode: "STANDARD", cases, allowLive: true, provider: { ...judge().provider, generateText }, judge: judge({ judgments: [] }).provider });
    expect(report.rows[0].result.metrics.executionFailure).toBe(1);
    expect(report.rows.some(r => r.result.metrics.judgeFailure === 1 && r.result.score === null)).toBe(true);
    expect(new Set(report.rows.map(r => r.caseId)).size).toBe(2);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(report.failedChecks).toBeGreaterThan(0);
  });
  it("changes trace versions with prompt/catalog modifications", () => {
    expect(promptVersion("tutor", "new")).not.toBe(promptVersion("tutor", "old"));
    expect(routingVersion([])).not.toBe(routingVersion());
  });
  it("disables sampling by default and rejects missing policy, high rates and private queue payloads", () => {
    vi.stubEnv("AI_EVAL_SAMPLING_ENABLED", undefined); expect(samplingConfig().enabled).toBe(false);
    vi.stubEnv("AI_EVAL_SAMPLING_ENABLED", "true"); expect(() => samplingConfig()).toThrow("POLICY");
    vi.stubEnv("AI_EVAL_SAMPLE_RATE", ".5"); expect(() => samplingConfig()).toThrow();
    expect(evaluationJobPayload.safeParse({ version: 1, trackingId: "job", userId: "u", messageId: "m", requestId: "r", usageRecordId: "x", policyVersion: "v1", prompt: "private" }).success).toBe(false);
    expect(selectedForSampling("same", 0)).toBe(false); expect(selectedForSampling("same", .01)).toBe(selectedForSampling("same", .01));
  });
  function report(score: number, n = 6, cost = .01): EvalReport {
    const rows: EvalRow[] = Array.from({ length: n }, (_, i) => ({ caseId: `case-${i}`, datasetVersion: "data-v1", promptVersion: "prompt-v1", routingVersion: "route-v1", contextVersion: "context-v1", evidence: "generated", model: "model-a", provider: "provider", tier: "STRONG", fallbackUsed: false, latencyMs: 100, costUsd: cost, judgeModel: "judge", judgeCostUsd: .001, result: { ...evaluate(tutor), evaluationType: "model-based", score, passed: score >= .8, dimensions: { correctness: score }, unmeasured: [] } }));
    return { version: 1, mode: "FULL", createdAt: "2026-10-01", rows, failedChecks: 0 };
  }
  it("does not call one noisy sample a regression", () => { expect(compareEvaluations(report(1, 1), report(.75, 1))[0].status).toBe("insufficient-data"); });
  it("detects paired quality regression even when a cheaper fallback is faster", () => {
    const b = report(.95), c = report(.75, 6, .001); c.rows.forEach(r => { r.fallbackUsed = true; r.model = "cheap"; r.latencyMs = 20; });
    expect(compareEvaluations(b, c)[0]).toMatchObject({ status: "regressed", pairedSamples: 6, routingRecommendation: "review-quality-floor-or-fallback-chain", latencyDeltaMs: -80 });
  });
  it("rejects unmatched dataset/evaluator/judge baselines", () => {
    const b = report(1), c = report(1); c.rows.forEach(r => r.datasetVersion = "new");
    expect(compareEvaluations(b, c)[0]).toMatchObject({ status: "insufficient-data", pairedSamples: 0 });
  });
  it("applies profile thresholds, tracks individual dimension drops and stable noise", () => {
    expect(compareEvaluations(report(.95), report(.93))[0].status).toBe("stable");
    vi.stubEnv("AI_EVAL_THRESHOLDS_JSON", JSON.stringify({ tutor: { allowedDrop: .01 } }));
    expect(compareEvaluations(report(.95), report(.93))[0].status).toBe("regressed");
  });
  it("fails a deterministic invalid plan without waiting for a statistical sample", () => {
    const b = report(1, 1), c = report(1, 1); c.rows[0].result = { ...c.rows[0].result, profile: "study-planner", evaluationType: "deterministic", passed: false, score: .95, failures: ["UNREALISTIC_PLAN"] };
    expect(compareEvaluations(b, c).find(r => r.profile === "study-planner")?.status).toBe("regressed");
  });
});
