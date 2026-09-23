export const LEARNING_CONFIG = {
  priorMean: 0.5,
  priorEvidence: 4,
  recentWindow: 8,
  trendWindow: 5,
  recentBlendMaximum: 0.6,
  recentHalfLifeDays: 30,
  staleGraceDays: 30,
  stalePenaltyDays: 180,
  stalePenaltyMaximum: 8,
  trendMinimumChange: 0.15,
  trendMinimumCorrectDifference: 2,
  weakConfidenceMinimum: 40,
  strongConfidenceMinimum: 60,
  strongRecentAccuracyMinimum: 75,
  defaultListLimit: 5,
  maximumListLimit: 20,
  maximumTopicsPerQuestion: 5,
  maximumTopicNameLength: 120,
} as const;

export const DIFFICULTY_WEIGHTS = {
  easy: 0.8,
  medium: 1,
  hard: 1.2,
} as const;

export const MILLISECONDS_PER_DAY = 86_400_000;
