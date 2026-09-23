import type { StudentAgentId } from "../agents/types";
import type { WorkflowId } from "../workflows/types";

export const RECOMMENDATION_TYPES = [
  "exam-preparation",
  "assignment-deadline",
  "weak-topic",
  "diagnostic-practice",
  "study-plan",
  "missed-study-task",
  "course-inactivity",
  "lecture-study",
  "career-preparation",
] as const;

export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];
export type RecommendationPriority = "low" | "medium" | "high" | "critical";
export type RecommendationStatus = "active" | "completed" | "dismissed" | "expired";
export type RecommendationSourceType =
  | "exam"
  | "assignment"
  | "learning-topic"
  | "study-plan"
  | "study-task"
  | "course"
  | "document"
  | "career-plan";

export type RecommendationAgentId = Extract<
  StudentAgentId,
  "tutor" | "quiz" | "study-planner" | "academic-manager" | "career"
>;

export type RecommendationActionPayload = Readonly<Record<
  string,
  string | number | boolean | null
>>;

export interface RecommendationPrioritySignals {
  readonly urgency?: number;
  readonly impact?: number;
  readonly weakness?: number;
  readonly confidence?: number;
  readonly trend?: number;
  readonly missedWork?: number;
}

export interface RecommendationCandidate {
  readonly type: RecommendationType;
  readonly title: string;
  readonly message: string;
  readonly sourceType: RecommendationSourceType;
  readonly sourceId?: string;
  readonly recommendedAgentId?: RecommendationAgentId;
  readonly recommendedWorkflowId?: WorkflowId;
  readonly actionPayload?: RecommendationActionPayload;
  readonly reasonCode: string;
  readonly reasonData: RecommendationActionPayload;
  readonly prioritySignals: RecommendationPrioritySignals;
  readonly dedupeKey: string;
  readonly supersessionKey: string;
  readonly stateFingerprint: string;
  readonly expiresAt?: Date;
}

export interface RecommendationRecord {
  readonly id: string;
  readonly type: RecommendationType;
  readonly title: string;
  readonly message: string;
  readonly priority: RecommendationPriority;
  readonly priorityScore: number;
  readonly status: RecommendationStatus;
  readonly sourceType: RecommendationSourceType;
  readonly sourceId: string | null;
  readonly recommendedAgentId: RecommendationAgentId | null;
  readonly recommendedWorkflowId: WorkflowId | null;
  readonly actionPayload: RecommendationActionPayload | null;
  readonly reasonCode: string;
  readonly reasonData: RecommendationActionPayload;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly dismissedAt: string | null;
  readonly completedAt: string | null;
}

export interface RecommendationAction {
  readonly recommendationId: string;
  readonly target:
    | { readonly type: "agent"; readonly id: RecommendationAgentId }
    | { readonly type: "workflow"; readonly id: WorkflowId };
  readonly payload: RecommendationActionPayload;
}

export interface RecommendationEvaluationResult {
  readonly recommendations: readonly RecommendationRecord[];
  readonly created: number;
  readonly updated: number;
  readonly expired: number;
  readonly suppressed: number;
}

export interface RecommendationDetectionInput {
  readonly now: Date;
  readonly preferences: {
    readonly studySessionMinutes: number;
    readonly timezone: string;
  };
  readonly courses: readonly {
    id: string;
    courseCode: string;
    courseName: string;
    lastActivityAt: Date | null;
  }[];
  readonly exams: readonly {
    id: string;
    courseId: string;
    title: string;
    examDate: Date;
    topics: readonly string[];
    courseCode: string;
    studyPlanId: string | null;
    planCompletion: number | null;
  }[];
  readonly assignments: readonly {
    id: string;
    courseId: string;
    title: string;
    dueDate: Date;
    status: "TODO" | "IN_PROGRESS" | "COMPLETED";
    priority: "LOW" | "MEDIUM" | "HIGH";
    estimatedHours: number;
    courseCode: string;
  }[];
  readonly topics: readonly {
    id: string;
    courseId: string;
    courseCode: string;
    name: string;
    normalizedName: string;
    mastery: number;
    confidence: number;
    recentAccuracy: number;
    trend: "IMPROVING" | "STABLE" | "DECLINING" | "INSUFFICIENT_DATA";
    questionsAttempted: number;
    lastPracticedAt: Date | null;
    recentFailures: number;
  }[];
  readonly studyPlans: readonly {
    id: string;
    title: string;
    endDate: Date;
    status: "ACTIVE" | "COMPLETED" | "ARCHIVED";
    missedTasks: number;
    remainingTasks: number;
  }[];
  readonly documents: readonly {
    id: string;
    courseId: string | null;
    title: string;
    createdAt: Date;
    courseCode: string | null;
  }[];
  readonly studiedDocumentIds: ReadonlySet<string>;
  readonly activeWorkflowSourceKeys: ReadonlySet<string>;
  readonly careerPlans: readonly {
    id: string;
    targetRole: string;
    targetDate: Date | null;
    status: "ACTIVE" | "COMPLETED" | "ARCHIVED";
    nextTask: null | {
      id: string;
      title: string;
      priority: number;
      targetDate: Date | null;
    };
  }[];
}
