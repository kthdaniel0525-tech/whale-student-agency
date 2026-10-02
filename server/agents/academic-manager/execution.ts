import "server-only";
import { z } from "zod";
import { AIError } from "../../ai/errors";
import type { AcademicAction, AcademicSnapshot } from "../../academic/types";
import type { AgentExecutionHandler } from "../core/types";
import { AgentExecutionError } from "../executor";
import { ACADEMIC_MANAGER_INSTRUCTIONS } from "./instructions";
import { randomUUID } from "node:crypto";
import {
  recordOwnedAdaptiveOutcome,
  type AdaptiveStrategy,
} from "../../adaptive";
import {
  getOwnedTopRecommendations,
  type RecommendationRecord,
} from "../../recommendations";

export interface AcademicManagerResponse {
  summary: string;
  mode: "now" | "overview";
  overallStatus: AcademicSnapshot["overallStatus"];
  topPriorities: AcademicSnapshot["priorities"];
  recommendedActions: AcademicAction[];
  nextBestAction: AcademicAction;
  proactiveRecommendations: readonly RecommendationRecord[];
  nextBestRecommendation: RecommendationRecord | null;
  /** Full numeric evidence is omitted for short 'now' responses. */
  academicSnapshot?: AcademicSnapshot;
  risks?: AcademicSnapshot["risks"];
  examReadiness?: AcademicSnapshot["examReadiness"];
}

export function academicManagerMode(request: string): "now" | "overview" {
  return /\b(?:right now|today|do now|study next|next best action)\b/i.test(request) ? "now" : "overview";
}

/** One generic Executor call. Numeric evidence, priority ordering, and allowed
 * recommendations are server-owned; the provider generates interpretation text. */
export const executeAcademicManager: AgentExecutionHandler = async (
  input, headers, executor, registry,
) => {
  const mode = academicManagerMode(input.request);
  const maximumActions = mode === "now" ? 2 : 3;
  const registeredSpecialists = registry.list()
    .filter((agent) => ["tutor", "notes", "quiz", "study-planner", "career"].includes(agent.id))
    .map((agent) => agent.id);
  let proactiveRecommendations: RecommendationRecord[] = [];
  try {
    proactiveRecommendations = await getOwnedTopRecommendations(headers, 5);
  } catch {
    // The existing academic snapshot remains a safe fallback if optional
    // proactive storage is temporarily unavailable.
  }
  let snapshot: AcademicSnapshot | undefined;
  let candidates: AcademicAction[] = [];
  let adaptive: AdaptiveStrategy | undefined;
  const schema = z.object({
    summary: z.string().trim().min(1).max(mode === "now" ? 500 : 1800),
  }).strict();
  const execution = await executor.executeStructured(input, headers, {
    schemaName: "academic_manager",
    schema,
    maxOutputTokens: mode === "now" ? 700 : 1800,
    ...(input.documentIds?.length || /\b(?:lecture coverage|based on (?:my )?(?:lectures?|documents?|course material))\b/i.test(input.request)
      ? { contextOverrides: { documents: true, limits: { documents: 3 } } } : {}),
    buildDirective(context, _personalization, adaptiveStrategy) {
      adaptive = adaptiveStrategy;
      snapshot = context.academicOverview;
      if (!snapshot) throw new AgentExecutionError("CONTEXT_FAILURE");
      const proactiveCandidates: AcademicAction[] = proactiveRecommendations.map((recommendation) => ({
        id: recommendation.id,
        agentId: recommendation.recommendedAgentId &&
          registeredSpecialists.includes(recommendation.recommendedAgentId)
          ? recommendation.recommendedAgentId as AcademicAction["agentId"] : null,
        action: recommendation.title,
        priority: recommendation.priority === "critical" ? "high" : recommendation.priority,
        reason: recommendation.message,
        courseId: typeof recommendation.actionPayload?.courseId === "string"
          ? recommendation.actionPayload.courseId : null,
      }));
      const allowedCandidates = (proactiveCandidates.length
        ? proactiveCandidates
        : snapshot.actionCandidates).map((action) => ({
        ...action,
        agentId: action.agentId && registeredSpecialists.includes(action.agentId) ? action.agentId : null,
      }));
      const avoided = (adaptiveStrategy.metadata.avoidRecommendationActions ?? [])
        .map((action) => action.normalize("NFKC").toLocaleLowerCase());
      const alternatives = avoided.length
        ? allowedCandidates.filter((candidate) => {
            const action = candidate.action.normalize("NFKC").toLocaleLowerCase();
            return !avoided.some((item) => item === action || item.includes(action) || action.includes(item));
          })
        : allowedCandidates;
      candidates = alternatives.length ? alternatives : allowedCandidates;
      snapshot = {
        ...snapshot,
        actionCandidates: candidates,
        priorities: snapshot.priorities.map((item) => ({
          ...item,
          suggestedAgent: item.suggestedAgent && registeredSpecialists.includes(item.suggestedAgent)
            ? item.suggestedAgent : null,
        })),
      };
      // Full snapshot and ranked candidates remain in the reference message.
      // The provider interprets that evidence; deterministic code below retains
      // ownership of the actual action selection.
      return ACADEMIC_MANAGER_INSTRUCTIONS + "\n" + JSON.stringify({
        mode,
        maximumActions,
        topCandidateIds: candidates.slice(0, maximumActions).map((action) => action.id),
      });
    },
  });
  if (!snapshot || !execution.structuredData || !candidates[0]) throw new AIError("INVALID_RESPONSE");
  const recommendedActions = candidates.slice(0, maximumActions);
  const result: AcademicManagerResponse = {
    summary: execution.structuredData.summary,
    mode, overallStatus: snapshot.overallStatus,
    topPriorities: snapshot.priorities.slice(0, mode === "now" ? 2 : 5),
    recommendedActions,
    nextBestAction: candidates[0],
    proactiveRecommendations,
    nextBestRecommendation: proactiveRecommendations[0] ?? null,
    ...(mode === "overview" ? { academicSnapshot: snapshot, risks: snapshot.risks, examReadiness: snapshot.examReadiness } : {}),
  };
  try {
    const evidenceBase = execution.metadata?.conversationTurnId ?? randomUUID();
    await Promise.all(recommendedActions.map((action, index) =>
      recordOwnedAdaptiveOutcome({
        agentId: "academic-manager",
        ...(action.courseId ? { courseId: action.courseId } : {}),
        strategyKey: adaptive?.metadata.strategyKey ?? "academic-manager",
        strategy: { ...(action.agentId ? { recommendedAgent: action.agentId } : {}) },
        outcomeType: "recommendation",
        action: action.action,
        evidenceKey: `manager-recommendation:${evidenceBase}:${index}`,
      }, headers),
    ));
  } catch {
    // Recommendations remain valid when optional outcome evidence is unavailable.
  }
  return {
    ...execution,
    structuredData: result,
    content: result.summary + "\n\n" + recommendedActions.map((action, index) =>
      `${index + 1}. ${action.action}${action.agentId ? ` (${registry.get(action.agentId).name})` : ""} — ${action.reason}`,
    ).join("\n"),
  };
};
