import type { UserContext } from "../context/types";

export type PersonalizationSource =
  | "current-request"
  | "task-context"
  | "explicit-profile"
  | "explicit-memory"
  | "inferred-memory"
  | "learning-intelligence"
  | "default";

export type PersonalizationStrength = "normal" | "soft";

export interface PersonalizedValue<T> {
  readonly value: T;
  readonly source: PersonalizationSource;
  readonly confidence: number;
  readonly strength: PersonalizationStrength;
}

export type ExplanationDepth = "beginner" | "intermediate" | "advanced";
export type AnswerLength = "concise" | "medium" | "detailed";
export type ExplanationStructure =
  | "direct"
  | "example-first"
  | "step-by-step"
  | "theory-first";
export type ExplanationRigor = "intuitive" | "balanced" | "formal";
export type QuizDifficultyRecommendation = "easy" | "medium" | "hard";
export type PlanningIntensity = "light" | "moderate" | "intensive";
export type NoteStyle =
  | "concise"
  | "structured"
  | "detailed"
  | "exam-focused"
  | "definitions-first"
  | "concept-first";
export type ConfidenceHandling = "diagnostic" | "balanced" | "challenge";
export type WeakTopicBehavior =
  | "foundational-review"
  | "diagnostic-first"
  | "targeted-practice"
  | "maintenance";

export interface CareerGoals {
  readonly objectives?: readonly string[];
  readonly targetRoles?: readonly string[];
  readonly targetIndustry?: string;
  readonly targetCompanies?: readonly string[];
  readonly internshipTimeline?: string;
  readonly portfolioGoal?: string;
}

export interface PersonalizationMetadata {
  readonly appliedSignals: readonly string[];
  readonly ignoredSignals: readonly string[];
  readonly conflictsResolved: readonly string[];
}

/** A short-lived, task-specific behavioral profile. It is never persisted. */
export interface PersonalizationProfile {
  readonly agentId?: string;
  readonly explanationStyle?: PersonalizedValue<string>;
  readonly explanationDepth?: PersonalizedValue<ExplanationDepth>;
  readonly preferredAnswerLength?: PersonalizedValue<AnswerLength>;
  readonly explanationStructure?: PersonalizedValue<ExplanationStructure>;
  readonly explanationRigor?: PersonalizedValue<ExplanationRigor>;
  readonly examplePreference?: PersonalizedValue<"minimal" | "as-needed" | "example-first">;
  readonly quizDifficulty?: PersonalizedValue<QuizDifficultyRecommendation>;
  readonly recommendedDifficulty?: PersonalizedValue<QuizDifficultyRecommendation>;
  readonly preferredQuestionTypes?: PersonalizedValue<readonly string[]>;
  readonly confidenceHandling?: PersonalizedValue<ConfidenceHandling>;
  readonly weakTopicBehavior?: PersonalizedValue<WeakTopicBehavior>;
  readonly studySessionMinutes?: PersonalizedValue<number>;
  readonly maxContinuousMinutes?: PersonalizedValue<number>;
  readonly planningIntensity?: PersonalizedValue<PlanningIntensity>;
  readonly preferredStudyTime?: PersonalizedValue<string>;
  readonly noteStyle?: PersonalizedValue<NoteStyle>;
  readonly noteStructure?: PersonalizedValue<string>;
  readonly noteDetail?: PersonalizedValue<AnswerLength>;
  readonly learningStrategies?: PersonalizedValue<readonly string[]>;
  readonly academicGoals?: PersonalizedValue<readonly string[]>;
  readonly careerGoals?: PersonalizedValue<CareerGoals>;
  readonly communicationPreferences?: PersonalizedValue<readonly string[]>;
  readonly metadata: PersonalizationMetadata;
}

export interface PersonalizationTaskContext {
  readonly availableMinutes?: number;
  readonly requiredDifficulty?: QuizDifficultyRecommendation;
  readonly requiredQuestionTypes?: readonly string[];
}

export interface BuildPersonalizationInput {
  readonly request: string;
  readonly agentId?: string;
  readonly courseId?: string;
  /** Context Builder has already authenticated and ownership-scoped this data. */
  readonly context: Readonly<UserContext>;
  readonly task?: Readonly<PersonalizationTaskContext>;
}
