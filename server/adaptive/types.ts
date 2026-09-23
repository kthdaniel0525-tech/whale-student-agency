import type { ConversationContext } from "../conversations";
import type { UserContext } from "../context/types";
import type { PersonalizationProfile } from "../personalization";
import type { StudentAgentId } from "../agents/types";

export const EXPLANATION_APPROACHES = [
  "intuitive",
  "formal",
  "example-first",
  "step-by-step",
  "analogy",
  "worked-example",
  "concise-review",
] as const;

export const ADAPTIVE_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const ADAPTIVE_QUESTION_TYPES = [
  "multiple-choice",
  "true-false",
  "short-answer",
  "long-answer",
] as const;

export type ExplanationApproach = (typeof EXPLANATION_APPROACHES)[number];
export type AdaptiveDifficulty = (typeof ADAPTIVE_DIFFICULTIES)[number];
export type AdaptiveQuestionType = (typeof ADAPTIVE_QUESTION_TYPES)[number];
export type AdaptiveResponseDepth =
  | "foundational"
  | "concise"
  | "standard"
  | "advanced";
export type AdaptiveFeedbackStyle =
  | "brief-correction"
  | "guided-feedback"
  | "deep-remediation";
export type AdaptiveIntensity = "light" | "moderate" | "high";
export type AdaptiveNoteMode =
  | "concept-learning"
  | "structured-review"
  | "exam-review"
  | "concise-maintenance";
export type AdaptiveCareerFocus =
  | "projects"
  | "resume"
  | "portfolio"
  | "interview"
  | "applications"
  | "current-gap";

export interface AdaptiveStrategyMetadata {
  readonly strategyKey: string;
  readonly reasons: readonly string[];
  readonly evidenceCount: number;
  readonly shortTerm: true;
  readonly priorStrategyKey?: string;
  readonly priorExplanationApproach?: ExplanationApproach;
  readonly selectedTopicId?: string;
  readonly selectedCourseId?: string;
  readonly avoidRecommendationActions?: readonly string[];
}

/** Resolved, short-lived behavior instructions for one Agent execution. */
export interface AdaptiveStrategy {
  readonly responseDepth?: AdaptiveResponseDepth;
  readonly explanationApproach?: ExplanationApproach;
  readonly difficulty?: AdaptiveDifficulty;
  readonly questionMix?: readonly AdaptiveQuestionType[];
  readonly feedbackStyle?: AdaptiveFeedbackStyle;
  readonly practiceIntensity?: AdaptiveIntensity;
  readonly planningIntensity?: AdaptiveIntensity;
  readonly recommendedSessionMinutes?: number;
  readonly diagnosticMode?: boolean;
  readonly noteMode?: AdaptiveNoteMode;
  readonly careerFocus?: AdaptiveCareerFocus;
  readonly retryStrategy?: "maintain" | "switch-approach" | "diagnose-first";
  readonly escalationStrategy?:
    | "none"
    | "check-understanding"
    | "recommend-tutor"
    | "weak-topic-recovery";
  readonly recommendations: readonly string[];
  readonly metadata: AdaptiveStrategyMetadata;
}

export type AdaptiveOutcomeType =
  | "agent-response"
  | "explicit-understanding"
  | "explicit-confusion"
  | "quiz-performance"
  | "study-task-completed"
  | "study-task-skipped"
  | "recommendation"
  | "workflow-result";

export interface AdaptiveOutcomeStrategySnapshot {
  readonly explanationApproach?: ExplanationApproach;
  readonly difficulty?: AdaptiveDifficulty;
  readonly questionMix?: readonly AdaptiveQuestionType[];
  readonly planningIntensity?: AdaptiveIntensity;
  readonly recommendedSessionMinutes?: number;
  readonly diagnosticMode?: boolean;
  readonly noteMode?: AdaptiveNoteMode;
  readonly careerFocus?: AdaptiveCareerFocus;
  readonly recommendedAgent?: string;
}

export interface AdaptiveOutcomeRecord {
  readonly id: string;
  readonly userId: string;
  readonly agentId: StudentAgentId;
  readonly courseId: string | null;
  readonly topicId: string | null;
  readonly strategyKey: string;
  readonly strategy: AdaptiveOutcomeStrategySnapshot;
  readonly outcomeType: AdaptiveOutcomeType;
  readonly score: number | null;
  readonly successful: boolean | null;
  readonly action: string | null;
  readonly evidenceKey: string;
  readonly createdAt: string;
}

export interface BuildAdaptiveStrategyInput {
  readonly userId?: string;
  readonly agentId: string;
  readonly request: string;
  readonly personalization: Readonly<PersonalizationProfile>;
  readonly context: Readonly<UserContext>;
  readonly conversationState?: Readonly<ConversationContext>;
  readonly recentOutcomes?: readonly AdaptiveOutcomeRecord[];
}

export interface RecordAdaptiveOutcomeInput {
  readonly userId: string;
  readonly agentId: StudentAgentId;
  readonly courseId?: string;
  readonly topicId?: string;
  readonly strategyKey: string;
  readonly strategy: AdaptiveOutcomeStrategySnapshot;
  readonly outcomeType: AdaptiveOutcomeType;
  readonly score?: number;
  readonly successful?: boolean;
  readonly action?: string;
  readonly evidenceKey: string;
  readonly memoryCandidate?: {
    readonly key: string;
    readonly value: string;
    readonly source: string;
  };
}

export interface PreparedAdaptiveStrategy {
  readonly userId?: string;
  readonly strategy: AdaptiveStrategy;
}
