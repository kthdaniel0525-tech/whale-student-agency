export type LearningDifficulty = "easy" | "medium" | "hard";
export type LearningTrend =
  | "improving"
  | "stable"
  | "declining"
  | "insufficient-data";
export type LearningStatus =
  | "weak"
  | "developing"
  | "good"
  | "strong"
  | "unpracticed";

export interface LearningAttemptEvidence {
  readonly id?: string;
  readonly score: number;
  readonly correct: boolean;
  readonly difficulty?: LearningDifficulty;
  readonly attemptedAt: Date;
  readonly sessionId: string;
}

export interface LearningAggregate {
  readonly questionsAttempted: number;
  readonly scoreTotal: number;
  readonly difficultyWeightedScore: number;
  readonly difficultyWeightTotal: number;
  readonly practiceSessions: number;
  readonly easyAttempts: number;
  readonly mediumAttempts: number;
  readonly hardAttempts: number;
  readonly firstPracticedAt: Date | null;
  readonly lastPracticedAt: Date | null;
}

export interface LearningMetrics {
  readonly mastery: number;
  readonly confidence: number;
  readonly recentAccuracy: number;
  readonly trend: LearningTrend;
}

export interface LearningTopicSummary {
  readonly id: string;
  readonly topic: string;
  readonly courseId: string;
  readonly courseCode: string;
  readonly courseName: string;
  readonly mastery: number;
  readonly confidence: number;
  readonly recentAccuracy: number;
  readonly questionsAttempted: number;
  readonly practiceSessions: number;
  readonly trend: LearningTrend;
  readonly lastPracticedAt: string | null;
  readonly status: LearningStatus;
  readonly evidence: "limited" | "sufficient";
}

export interface RecommendedPracticeTopic extends LearningTopicSummary {
  readonly priority: number;
  readonly reasons: readonly (
    | "low-mastery"
    | "low-recent-performance"
    | "stale-practice"
    | "low-confidence"
    | "upcoming-need"
    | "unpracticed"
  )[];
}

export interface LearningOverview {
  readonly weakTopics: readonly LearningTopicSummary[];
  readonly strongTopics: readonly LearningTopicSummary[];
  readonly recommendedTopics: readonly RecommendedPracticeTopic[];
  /** Exact-name coverage requested for readiness, from the same learning-state read. */
  readonly examTopics?: readonly LearningTopicSummary[];
}

export interface LearningTopicQuery {
  readonly userId: string;
  readonly courseId?: string;
  /** Exact owned topic scope; avoids scanning a course for a recovery refresh. */
  readonly topicId?: string;
  readonly semester?: string;
  readonly examTopicNames?: readonly string[];
  readonly limit?: number;
  readonly now?: Date;
}

export interface RecommendedPracticeQuery extends LearningTopicQuery {
  /** Exact normalized topic names supplied by a future deadline-aware caller. */
  readonly upcomingTopicNames?: readonly string[];
}
