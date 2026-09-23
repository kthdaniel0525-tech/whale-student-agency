import type { AIUsage } from "../../ai/types";
import type {
  AssignmentContext,
  ExamContext,
  LearningTopicContext,
  UserContext,
} from "../../context/types";

export const STUDY_ACTIVITY_TYPES = [
  "learn",
  "review",
  "practice",
  "quiz",
  "assignment",
  "exam-review",
  "notes-review",
  "mixed-practice",
] as const;

export type StudyActivityType = (typeof STUDY_ACTIVITY_TYPES)[number];
export type StudyPlanStatus = "active" | "completed" | "archived";
export type StudyTaskStatus =
  | "planned"
  | "in-progress"
  | "completed"
  | "skipped";
export type PlanningPriorityLevel = "low" | "medium" | "high" | "urgent";
export type PlanningSignalKind = "topic" | "exam" | "assignment" | "general";

export interface StudyAvailability {
  readonly date: string;
  readonly availableMinutes: number;
  readonly freeWindows?: readonly import("@/lib/student/calendar/types").TimeWindow[];
}

export interface StudyPlanRequest {
  readonly examId?: string;
  readonly request: string;
  readonly conversation?: { readonly id: string; readonly turnId?: string };
  readonly courseId?: string;
  readonly documentIds?: readonly string[];
  readonly startDate?: string;
  readonly endDate?: string;
  readonly availability?: readonly StudyAvailability[];
  readonly preferredSessionMinutes?: number;
  readonly intensive?: boolean;
}

export interface StudyPlanUpdateRequest extends StudyPlanRequest {
  readonly planId: string;
}

export interface StudyNowRequest {
  readonly request: string;
  readonly conversation?: { readonly id: string; readonly turnId?: string };
  readonly courseId?: string;
  readonly documentIds?: readonly string[];
  readonly availableMinutes?: number;
  readonly preferredSessionMinutes?: number;
}

export interface PlanningSignal {
  readonly id: string;
  readonly kind: PlanningSignalKind;
  readonly courseId: string | null;
  readonly courseName: string | null;
  readonly topicId: string | null;
  readonly topic: string | null;
  readonly linkedExamId: string | null;
  readonly linkedAssignmentId: string | null;
  readonly priorityScore: number;
  readonly priority: PlanningPriorityLevel;
  readonly urgency: number;
  readonly weakness: number;
  readonly confidenceNeed: number;
  readonly trend: number;
  readonly staleness: number;
  readonly importance: number;
  readonly suggestedActivity: StudyActivityType;
  readonly allowedActivities: readonly StudyActivityType[];
  readonly reason: string;
  readonly sourceDueDate: string | null;
  readonly sourceMasteryScore: number | null;
  readonly sourceConfidenceScore: number | null;
  readonly targetMinutes: number;
}

export interface PlanningChanges {
  readonly missedTasks: readonly {
    id: string;
    title: string;
    date: string;
    durationMinutes: number;
  }[];
  readonly completedTasks: readonly {
    id: string;
    title: string;
    date: string;
    durationMinutes: number;
  }[];
  readonly changedDeadlines: readonly {
    taskId: string;
    title: string;
    previousDate: string;
    currentDate: string;
  }[];
  readonly masteryChanges: readonly {
    taskId: string;
    topic: string;
    previousMastery: number;
    currentMastery: number;
    previousConfidence: number;
    currentConfidence: number;
  }[];
  readonly remainingMinutes: number;
}

export interface PlanningBrief {
  readonly calendarTimezone?: string;
  readonly mode: "create" | "update" | "now";
  readonly startDate: string;
  readonly endDate: string;
  readonly availability: readonly StudyAvailability[];
  readonly preferredSessionMinutes: number;
  readonly maximumSessionMinutes: number;
  readonly totalAvailableMinutes: number;
  readonly assumptions: readonly string[];
  readonly signals: readonly PlanningSignal[];
  readonly changes?: PlanningChanges;
}

export interface PlanningBriefOptions {
  readonly mode: PlanningBrief["mode"];
  readonly request: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly availability?: readonly StudyAvailability[];
  readonly availableMinutes?: number;
  readonly preferredSessionMinutes?: number;
  readonly intensive?: boolean;
  readonly reservedMinutesByDate?: Readonly<Record<string, number>>;
}

export interface PlanningSignalInput {
  readonly assignments: readonly AssignmentContext[];
  readonly exams: readonly ExamContext[];
  readonly learning?: UserContext["learning"];
  readonly startDate: string;
  readonly totalAvailableMinutes: number;
}

export interface StoredStudyTask {
  readonly scheduledStart?: string | null;
  readonly scheduledEnd?: string | null;
  readonly scheduledTimezone?: string | null;
  readonly id: string;
  readonly date: string;
  readonly title: string;
  readonly courseId: string | null;
  readonly courseName: string | null;
  readonly topicId: string | null;
  readonly topic: string | null;
  readonly examId: string | null;
  readonly assignmentId: string | null;
  readonly activityType: StudyActivityType;
  readonly durationMinutes: number;
  readonly priority: number;
  readonly status: StudyTaskStatus;
  readonly reason: string;
}

export interface StudyPlanDay {
  readonly date: string;
  readonly totalMinutes: number;
  readonly sessions: readonly StoredStudyTask[];
}

export interface StoredStudyPlan {
  readonly id: string;
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly totalPlannedMinutes: number;
  readonly status: StudyPlanStatus;
  readonly days: readonly StudyPlanDay[];
  readonly metadata: {
    readonly model?: string;
    readonly usage?: AIUsage;
    readonly durationMs?: number;
  };
}

export interface StudyNowRecommendation {
  readonly date: string;
  readonly summary: string;
  readonly totalMinutes: number;
  readonly sessions: readonly Omit<StoredStudyTask, "id" | "status">[];
  readonly assumptions: readonly string[];
}

export interface CurrentPlanTask {
  readonly id: string;
  readonly date: Date;
  readonly title: string;
  readonly topicId: string | null;
  readonly topic: string | null;
  readonly examId: string | null;
  readonly assignmentId: string | null;
  readonly durationMinutes: number;
  readonly status: "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
  readonly sourceDueDate: Date | null;
  readonly sourceMasteryScore: number | null;
  readonly sourceConfidenceScore: number | null;
}

export interface PlanningContextIndex {
  readonly assignments: ReadonlyMap<string, AssignmentContext>;
  readonly exams: ReadonlyMap<string, ExamContext>;
  readonly topics: ReadonlyMap<string, LearningTopicContext>;
}

export type StudyPlannerAgentErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "AUTHENTICATION_FAILURE"
  | "NOT_STUDY_PLANNER_REQUEST"
  | "PLAN_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "NO_AVAILABILITY"
  | "INVALID_PLAN_RESPONSE"
  | "STORAGE_FAILURE";
