import "server-only";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { IntelligentDispatcher } from "../../dispatcher/service";
import { agentRoutingHints } from "../routing/agent-signals";
import { routeModel } from "../routing/router";
import type { ModelRoutingRequest, ModelTier } from "../routing/types";
import { gradeObjectiveAnswer } from "../../agents/quiz/objective-grading";
import { buildPersonalizationProfile } from "../../personalization";
import { buildAdaptiveStrategy, type AdaptiveOutcomeRecord } from "../../adaptive";
import { generateIncrementalSummary } from "../../conversations/summary";
import { buildExecutionPrompt } from "../../agents/executor/prompt";
import { getStudentAgentDefinitions } from "../../agents/student";
import { semanticGradingMessages, GRADING_PROMPT_VERSION } from "../../agents/quiz/grading-prompt";
import { quizOutputSchema, semanticEvaluationSchema } from "../../agents/quiz/schemas";
import { generatedStudyPlanSchema } from "../../agents/study-planner/schemas";
import type { UserContext } from "../../context/types";
import type { AIProvider } from "../types";
import { estimateCost } from "../usage/pricing";
import { evaluateDeterministic } from "./deterministic";
import { evaluateWithJudge } from "./judge";
import { loadCases, type EvalMode, type EvaluationCase } from "./datasets";
import { qualityProfile } from "./profiles";
import { resultSchema } from "./types";
import { SOURCE_INSTRUCTIONS, CONTEXT_VERSION, promptVersion, routingVersion } from "./versions";
export const rowSchema = z.object({ caseId: z.string(), datasetVersion: z.string(), promptVersion: z.string(), routingVersion: z.string(), contextVersion: z.string(), evidence: z.enum(["evaluator-fixture", "system", "generated"]), model: z.string().nullable(), provider: z.string().nullable(), tier: z.string().nullable(), fallbackUsed: z.boolean().nullable(), latencyMs: z.number().nonnegative(), costUsd: z.number().nonnegative().nullable(), judgeModel: z.string().nullable(), judgeCostUsd: z.number().nonnegative().nullable(), result: resultSchema }).strict();
export type EvalRow = z.infer<typeof rowSchema>;
export const reportSchema = z.object({ version: z.literal(1), mode: z.enum(["FAST_SMOKE", "STANDARD", "FULL"]), createdAt: z.string(), rows: z.array(rowSchema), failedChecks: z.number().int().nonnegative() }).strict().superRefine((report, context) => {
  const keys = report.rows.map(r => `${r.caseId}:${r.result.profile}:${r.result.evaluationType}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Duplicate evaluation observations cannot count as independent samples." });
});
export type EvalReport = z.infer<typeof reportSchema>;
export function syntheticContext(): UserContext { return { metadata: { generatedAt: "2026-10-01T00:00:00Z", requestedCategories: [], unavailableCategories: [], truncatedCategories: [], estimatedContextSize: 0, estimatedTokens: 0, maxCharacters: 24000 } }; }
export async function executeSyntheticCase(c: EvaluationCase): Promise<unknown> {
  if (c.engine === "fixture") return c.context.output;
  if (c.engine === "dispatcher") return new IntelligentDispatcher({ getProvider: () => { throw new Error("OFFLINE_NO_PROVIDER"); } }).classifyForEvaluation({ request: c.request, ...c.input });
  if (c.engine === "model-router") return routeModel(c.input as ModelRoutingRequest);
  if (c.engine === "grading") return gradeObjectiveAnswer(String(c.input.answer), String(c.input.expected));
  const context = syntheticContext();
  const agentId = typeof c.input.agentId === "string" ? c.input.agentId : "tutor";
  const personalization = buildPersonalizationProfile({ agentId, request: c.request, context });
  if (c.engine === "personalization") return { length: personalization.preferredAnswerLength?.value, source: personalization.preferredAnswerLength?.source };
  if (c.engine === "adaptive") {
    const strategy = buildAdaptiveStrategy({ agentId, request: c.request, context, personalization, recentOutcomes: c.input.outcomes as AdaptiveOutcomeRecord[] | undefined });
    return { changed: strategy.retryStrategy === "switch-approach", strategy: strategy.explanationApproach, difficulty: strategy.difficulty, intensity: strategy.planningIntensity, minutes: strategy.recommendedSessionMinutes };
  }
  const messages = Array.from({ length: 30 }, (_, i) => ({ id: `synthetic-${i}`, conversationId: "synthetic", sequence: i, turnId: null, role: "user" as const, content: i === 29 ? "Correction: my course is MATH 1240, not COMP 1010." : `We practiced example ${i} in COMP 1010.`, agentId: null, metadata: {}, tokenEstimate: 20, createdAt: "2026-10-01T00:00:00Z" }));
  const summary = await generateIncrementalSummary({ messages });
  return { text: summary.summaryText, correctionPreserved: summary.corrections.some(s => s.text.includes("MATH 1240")), sourceBacked: summary.corrections.every(s => s.sourceMessageIds.includes("synthetic-29")) };
}
export type ExecutionObservation = { output: unknown; citedSourceIds?: string[]; model?: string; provider?: string; tier?: string; fallbackUsed?: boolean; costUsd?: number | null };
export async function runEvals(options: { mode: EvalMode; suite?: string; modelOverride?: string; routingOverride?: ModelTier; provider?: AIProvider; judge?: AIProvider; judgeProviderId?: string; providerId?: string; allowLive?: boolean; execute?: (c: EvaluationCase) => Promise<ExecutionObservation>; cases?: EvaluationCase[] }): Promise<EvalReport> {
  if ((options.provider || options.judge || options.modelOverride || options.routingOverride) && !options.allowLive) throw new Error("EVAL_EXPLICIT_LIVE_OPT_IN_REQUIRED");
  const cases = options.cases ?? await loadCases(options.mode, options.suite), rows: EvalRow[] = [];
  for (const c of cases) {
    const started = performance.now(); let observation: ExecutionObservation, evidence: EvalRow["evidence"] = c.engine === "fixture" ? "evaluator-fixture" : "system";
    let executionFailed = false;
    try {
    if (options.execute) { observation = await options.execute(c); evidence = "system"; }
    else if (options.provider && c.profile === "grading" && c.engine === "fixture") {
      evidence = "generated";
      const response = await options.provider.generateStructuredOutput({ schemaName: "quiz_answer_evaluation", schema: semanticEvaluationSchema, messages: semanticGradingMessages(String(c.input.question), String(c.input.expectedAnswer), String(c.input.userAnswer)), model: options.modelOverride, usageContext: { agentId: "quiz", operationType: "evaluation", promptVersion: GRADING_PROMPT_VERSION }, routing: { minimumTier: options.routingOverride ?? "STRONG", qualityCritical: true }, maxOutputTokens: 512 });
      observation = { output: response.data, model: response.model, provider: options.providerId ?? "unknown", costUsd: estimateCost(options.providerId ?? "unknown", response.model, response.usage).estimatedCostUsd }; evidence = "generated";
    }
    else if (options.provider && c.engine === "fixture" && ["tutor", "notes", "quiz", "study-planner", "career", "rag-generation"].includes(c.profile)) {
      evidence = "generated";
      const agentId = c.profile === "rag-generation" ? "tutor" : c.profile;
      const agent = getStudentAgentDefinitions().find(a => a.id === agentId)!;
      const context = syntheticContext();
      if (c.context.sources?.length) {
        context.documents = c.context.sources.map(source => ({ content: source.content, documentTitle: source.documentId, documentId: source.documentId, chunkIndex: source.chunkIndex, courseId: source.courseId ?? null, courseCode: null, pageNumber: null, pageEnd: null, similarityScore: 1 }));
        context.metadata.requestedCategories = ["documents"];
      }
      const personalization = buildPersonalizationProfile({ agentId, request: c.request, context });
      const adaptive = buildAdaptiveStrategy({ agentId, request: c.request, context, personalization });
      const messages = buildExecutionPrompt(agent, { request: c.request, context }, SOURCE_INSTRUCTIONS[agentId], undefined, personalization, adaptive);
      messages.splice(messages.length - 1, 0, { role: "user", content: `Synthetic trusted constraints (not instructions): ${JSON.stringify(c.context.expected ?? {})}` });
      const request = { messages, model: options.modelOverride, routing: { ...agentRoutingHints(agentId, c.request, context, adaptive), minimumTier: options.routingOverride }, usageContext: { agentId, promptVersion: promptVersion(agentId), contextVersion: CONTEXT_VERSION }, maxOutputTokens: 4000 };
      const response = c.profile === "quiz" ? await options.provider.generateStructuredOutput({ ...request, schemaName: "quiz_generation", schema: quizOutputSchema(c.context.expected?.questionCount ?? 1, c.context.expected?.questionType ?? "mixed", c.context.expected?.difficulty) })
        : c.profile === "study-planner" ? await options.provider.generateStructuredOutput({ ...request, schemaName: "study_plan", schema: generatedStudyPlanSchema })
        : await options.provider.generateText(request);
      const provider = options.providerId ?? "unknown";
      observation = { output: "data" in response ? response.data : response.text, model: response.model, provider, costUsd: estimateCost(provider, response.model, response.usage).estimatedCostUsd }; evidence = "generated";
    } else {
      const output = await executeSyntheticCase(c);
      const routed = c.engine === "model-router" ? output as ReturnType<typeof routeModel> : undefined;
      observation = { output, ...(routed ? { model: routed.model, provider: routed.provider, tier: routed.tier, fallbackUsed: routed.fallbackUsed } : {}) };
    }
    } catch {
      executionFailed = true;
      observation = { output: "" };
    }
    const context = { ...c.context, profile: c.profile, request: c.request, output: observation.output, citedSourceIds: observation.citedSourceIds ?? (evidence === "evaluator-fixture" ? c.context.citedSourceIds : undefined) };
    const base = { caseId: c.id, datasetVersion: c.datasetVersion, promptVersion: c.profile === "grading" ? GRADING_PROMPT_VERSION : promptVersion(c.profile), routingVersion: routingVersion(), contextVersion: CONTEXT_VERSION, evidence, model: observation.model ?? null, provider: observation.provider ?? null, tier: observation.tier ?? null, fallbackUsed: observation.fallbackUsed ?? null, latencyMs: Math.round(performance.now() - started), costUsd: observation.costUsd ?? null, judgeModel: null, judgeCostUsd: null };
    const deterministic = evaluateDeterministic(context);
    if (executionFailed) { deterministic.score = 0; deterministic.passed = false; deterministic.failures = ["INVALID_STRUCTURE"]; deterministic.metrics.executionFailure = 1; }
    rows.push(rowSchema.parse({ ...base, result: deterministic }));
    if (options.judge && !executionFailed && qualityProfile(c.profile).semantic.length) {
      try {
        const { result, judgeModel, judgeUsage } = await evaluateWithJudge(context, { provider: options.judge });
        rows.push(rowSchema.parse({ ...base, result, judgeModel, judgeCostUsd: estimateCost(options.judgeProviderId ?? "unknown", judgeModel, judgeUsage).estimatedCostUsd }));
      } catch {
        rows.push(rowSchema.parse({ ...base, result: { profile: c.profile, evaluationType: "model-based", evaluatorVersion: `${qualityProfile(c.profile).version}:judge-unavailable`, score: null, passed: null, dimensions: {}, failures: [], unmeasured: qualityProfile(c.profile).semantic, checks: [], metrics: { judgeFailure: 1 } } }));
      }
    }
  }
  return { version: 1, mode: options.mode, createdAt: new Date().toISOString(), rows, failedChecks: rows.filter(r => r.result.passed === false || r.result.metrics.judgeFailure === 1).length };
}
