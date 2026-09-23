import {
  DIFFICULTY_WEIGHTS,
  LEARNING_CONFIG,
  MILLISECONDS_PER_DAY,
} from "./constants";
import type {
  LearningAggregate,
  LearningAttemptEvidence,
  LearningDifficulty,
  LearningMetrics,
  LearningStatus,
  LearningTrend,
} from "./types";

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));
const rounded = (value: number) => Math.round(clamp(value, 0, 100));
const ageDays = (date: Date, now: Date) =>
  Math.max(0, (now.getTime() - date.getTime()) / MILLISECONDS_PER_DAY);

export function difficultyWeight(
  difficulty: LearningDifficulty | undefined,
): number {
  return DIFFICULTY_WEIGHTS[difficulty ?? "medium"];
}

function weightedAccuracy(
  attempts: readonly LearningAttemptEvidence[],
  now?: Date,
): number {
  let score = 0;
  let weight = 0;
  for (const attempt of attempts) {
    const recency = now
      ? 2 **
        (-ageDays(attempt.attemptedAt, now) /
          LEARNING_CONFIG.recentHalfLifeDays)
      : 1;
    const evidence = difficultyWeight(attempt.difficulty) * recency;
    score += clamp(attempt.score, 0, 1) * evidence;
    weight += evidence;
  }
  return weight ? score / weight : LEARNING_CONFIG.priorMean;
}

export function calculateTrend(
  attempts: readonly LearningAttemptEvidence[],
): LearningTrend {
  const ordered = [...attempts].sort(
    (a, b) =>
      b.attemptedAt.getTime() - a.attemptedAt.getTime() ||
      (b.id ?? "").localeCompare(a.id ?? ""),
  );
  const required = LEARNING_CONFIG.trendWindow * 2;
  const recent = ordered.slice(0, LEARNING_CONFIG.trendWindow);
  const previous = ordered.slice(
    LEARNING_CONFIG.trendWindow,
    required,
  );
  const sessions = new Set(
    ordered.slice(0, required).map((attempt) => attempt.sessionId),
  );
  if (
    recent.length < LEARNING_CONFIG.trendWindow ||
    previous.length < LEARNING_CONFIG.trendWindow ||
    sessions.size < 2
  ) {
    return "insufficient-data";
  }
  const change = weightedAccuracy(recent) - weightedAccuracy(previous);
  const correctDifference =
    recent.filter((attempt) => attempt.correct).length -
    previous.filter((attempt) => attempt.correct).length;
  if (
    change >= LEARNING_CONFIG.trendMinimumChange &&
    correctDifference >= LEARNING_CONFIG.trendMinimumCorrectDifference
  ) {
    return "improving";
  }
  if (
    change <= -LEARNING_CONFIG.trendMinimumChange &&
    correctDifference <= -LEARNING_CONFIG.trendMinimumCorrectDifference
  ) {
    return "declining";
  }
  return "stable";
}

export function calculateLearningFreshness(
  lastPracticedAt: Date | null,
  now: Date,
): { masteryPenalty: number; confidenceMultiplier: number } {
  const daysSincePractice = lastPracticedAt
    ? ageDays(lastPracticedAt, now)
    : 0;
  return {
    masteryPenalty:
      LEARNING_CONFIG.stalePenaltyMaximum *
      clamp(
        (daysSincePractice - LEARNING_CONFIG.staleGraceDays) /
          LEARNING_CONFIG.stalePenaltyDays,
        0,
        1,
      ),
    confidenceMultiplier:
      2 **
      (-Math.max(0, daysSincePractice - LEARNING_CONFIG.staleGraceDays) /
        LEARNING_CONFIG.stalePenaltyDays),
  };
}

/**
 * Bayesian smoothing prevents small samples from becoming 0/100 mastery.
 * Recent evidence contributes up to 60%, and difficulty only changes evidence
 * strength by ±20%. Old evidence is retained through the lifetime estimate.
 */
export function calculateLearningMetrics(input: {
  readonly aggregate: LearningAggregate;
  readonly recentAttempts: readonly LearningAttemptEvidence[];
  readonly now?: Date;
}): LearningMetrics {
  const now = input.now ?? new Date();
  const recentAttempts = [...input.recentAttempts]
    .sort(
      (a, b) =>
        b.attemptedAt.getTime() - a.attemptedAt.getTime() ||
        (b.id ?? "").localeCompare(a.id ?? ""),
    )
    .slice(0, LEARNING_CONFIG.trendWindow * 2);
  const recentForMastery = recentAttempts.slice(
    0,
    LEARNING_CONFIG.recentWindow,
  );
  const lifetime =
    (LEARNING_CONFIG.priorMean * LEARNING_CONFIG.priorEvidence +
      input.aggregate.difficultyWeightedScore) /
    (LEARNING_CONFIG.priorEvidence +
      input.aggregate.difficultyWeightTotal);
  const recent = weightedAccuracy(recentForMastery, now);
  const recentBlend =
    LEARNING_CONFIG.recentBlendMaximum *
    Math.min(
      recentForMastery.length / LEARNING_CONFIG.recentWindow,
      1,
    );
  const estimate = lifetime * (1 - recentBlend) + recent * recentBlend;
  const freshness = calculateLearningFreshness(
    input.aggregate.lastPracticedAt,
    now,
  );

  const attempts = input.aggregate.questionsAttempted;
  const difficulties = [
    input.aggregate.easyAttempts,
    input.aggregate.mediumAttempts,
    input.aggregate.hardAttempts,
  ].filter((count) => count > 0).length;
  const spanDays =
    input.aggregate.firstPracticedAt && input.aggregate.lastPracticedAt
      ? ageDays(
          input.aggregate.firstPracticedAt,
          input.aggregate.lastPracticedAt,
        )
      : 0;
  const confidenceBeforeFreshness =
    55 * Math.min(attempts / 15, 1) +
    20 * Math.min(input.aggregate.practiceSessions / 4, 1) +
    10 * (difficulties / 3) +
    15 * Math.min(spanDays / 21, 1);
  return {
    mastery: rounded(estimate * 100 - freshness.masteryPenalty),
    confidence: rounded(
      confidenceBeforeFreshness * freshness.confidenceMultiplier,
    ),
    recentAccuracy: rounded(recent * 100),
    trend: calculateTrend(recentAttempts),
  };
}

export function learningStatus(
  mastery: number,
  attempted = true,
): LearningStatus {
  if (!attempted) return "unpracticed";
  if (mastery < 40) return "weak";
  if (mastery < 70) return "developing";
  if (mastery < 85) return "good";
  return "strong";
}
