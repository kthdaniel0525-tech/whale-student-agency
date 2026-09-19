export const REMINDER_TYPES = [
  "assignment-due",
  "assignment-overdue",
  "exam-upcoming",
  "exam-tomorrow",
  "study-session",
  "missed-study-task",
  "study-plan-behind",
  "weak-topic-before-exam",
  "diagnostic-practice",
  "workflow-waiting",
] as const;
export type ReminderType = typeof REMINDER_TYPES[number];

export type ReminderPriority = "low" | "medium" | "high" | "critical";
export type ReminderStatus =
  | "scheduled"
  | "ready"
  | "delivered"
  | "dismissed"
  | "snoozed"
  | "expired"
  | "cancelled";
export type ReminderSourceType =
  | "assignment"
  | "exam"
  | "study-task"
  | "study-plan"
  | "learning-topic"
  | "workflow-run";
export type ReminderActionTargetType = "agent" | "workflow" | "resource";

export type ReminderJson = Readonly<Record<
  string,
  string | number | boolean | null
>>;

export interface ReminderPrioritySignals {
  readonly urgency?: number;
  readonly academicImpact?: number;
  readonly sourcePriority?: number;
  readonly readiness?: number;
  readonly weakness?: number;
  readonly missedWork?: number;
  readonly userActionRequired?: number;
}

export interface ReminderCandidate {
  readonly type: ReminderType;
  readonly title: string;
  readonly message: string;
  readonly sourceType: ReminderSourceType;
  readonly sourceId: string;
  readonly scheduledFor: Date;
  readonly expiresAt?: Date;
  readonly prioritySignals: ReminderPrioritySignals;
  readonly reasonCode: string;
  readonly reasonData: ReminderJson;
  readonly actionTargetType: ReminderActionTargetType;
  readonly actionTargetId: string;
  readonly actionPayload: ReminderJson;
  readonly dedupeKey: string;
  readonly supersessionKey: string;
  readonly stateFingerprint: string;
}

export interface ReminderDetectionInput {
  readonly now: Date;
  readonly timezone: string;
  readonly leadTimeMinutes: number;
  readonly assignments: readonly {
    id: string;
    courseId: string;
    courseCode: string;
    title: string;
    dueDate: Date;
    status: "TODO" | "IN_PROGRESS" | "COMPLETED";
    priority: "LOW" | "MEDIUM" | "HIGH";
    estimatedHours: number;
  }[];
  readonly exams: readonly {
    id: string;
    courseId: string;
    courseCode: string;
    title: string;
    examDate: Date;
    topics: readonly string[];
  }[];
  readonly topics: readonly {
    id: string;
    courseId: string;
    name: string;
    normalizedName: string;
    mastery: number;
    confidence: number;
    questionsAttempted: number;
  }[];
  readonly studyPlans: readonly {
    id: string;
    title: string;
    endDate: Date;
    status: "ACTIVE" | "COMPLETED" | "ARCHIVED";
    tasks: readonly {
      id: string;
      courseId: string | null;
      examId: string | null;
      title: string;
      date: Date;
      durationMinutes: number;
      priority: number;
      status: "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
      updatedAt: Date;
    }[];
  }[];
  readonly workflows: readonly {
    id: string;
    workflowId: string;
    currentStep: string | null;
    status: "WAITING_FOR_INPUT";
    updatedAt: Date;
  }[];
}

export interface RankedReminderCandidate extends ReminderCandidate {
  readonly priorityScore: number;
  readonly priority: ReminderPriority;
}

export interface ReminderRecord {
  readonly id: string;
  readonly type: ReminderType;
  readonly title: string;
  readonly message: string;
  readonly priority: ReminderPriority;
  readonly priorityScore: number;
  readonly status: ReminderStatus;
  readonly sourceType: ReminderSourceType;
  readonly sourceId: string | null;
  readonly scheduledFor: string;
  readonly expiresAt: string | null;
  readonly snoozedUntil: string | null;
  readonly reasonCode: string;
  readonly reasonData: ReminderJson;
  readonly action: null | {
    readonly type: ReminderActionTargetType;
    readonly id: string;
    readonly payload: ReminderJson;
  };
}

export interface ReminderEvaluationResult {
  readonly reminders: readonly ReminderRecord[];
  readonly candidatesDetected: number;
  readonly created: number;
  readonly updated: number;
  readonly deduplicated: number;
  readonly expired: number;
  readonly snoozed: number;
  readonly dismissed: number;
}
