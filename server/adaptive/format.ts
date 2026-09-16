import "server-only";
import type { AdaptiveStrategy } from "./types";

/** Compact resolved behavior only; raw scores and internal history stay server-side. */
export function formatAdaptiveStrategyForAI(strategy: AdaptiveStrategy): string {
  const compact = Object.fromEntries(Object.entries({
    responseDepth: strategy.responseDepth,
    explanationApproach: strategy.explanationApproach,
    difficulty: strategy.difficulty,
    questionMix: strategy.questionMix,
    feedbackStyle: strategy.feedbackStyle,
    practiceIntensity: strategy.practiceIntensity,
    planningIntensity: strategy.planningIntensity,
    recommendedSessionMinutes: strategy.recommendedSessionMinutes,
    diagnosticMode: strategy.diagnosticMode,
    noteMode: strategy.noteMode,
    careerFocus: strategy.careerFocus,
    retryStrategy: strategy.retryStrategy,
    escalationStrategy: strategy.escalationStrategy,
    recommendations: strategy.recommendations,
  }).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length)));
  return `[ADAPTATION]\n${JSON.stringify(compact)}`;
}
