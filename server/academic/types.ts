import type { CourseReference, ExamContext, LearningTopicContext } from "../context/types";

export type AcademicRiskLevel = "low" | "moderate" | "high";
export type SpecialistId = "tutor" | "notes" | "quiz" | "study-planner";

export interface AcademicCounts {
  totalActiveCourses: number;
  overdueAssignments: number;
  overdueHighPriorityAssignments: number;
  assignmentsDueNext7Days: number;
  examsNext14Days: number;
}

export interface CourseWorkload extends CourseReference {
  overdueAssignments: number;
  assignmentsDueNext7Days: number;
  examsNext14Days: number;
  missedStudyTasks: number;
}

export interface StudyPlanSummary {
  id: string;
  title: string;
  completionPercentage: number | null;
  completedTasks: number;
  remainingTasks: number;
  skippedTasks: number;
  missedTasks: number;
}

export interface PlannedSessionSummary {
  id: string;
  planId: string;
  title: string;
  courseId: string | null;
  date: string;
  durationMinutes: number;
}

export interface ExamPlanEvidence {
  examId: string;
  completed: number;
  total: number;
}

export interface ExamReadiness {
  examId: string;
  courseId: string;
  title: string;
  daysRemaining: number;
  readinessScore: number | null;
  readinessLevel: "high" | "moderate" | "low" | "insufficient-data";
  confidence: number;
  coverage: number;
  recentAccuracy: number | null;
  planCompletion: number | null;
  weakTopics: string[];
  explanation: string;
}

export interface AcademicConcern {
  id: string;
  courseId: string | null;
  score: number;
  reason: string;
  action: string;
  suggestedAgent: SpecialistId | null;
}

export interface AcademicRisk {
  id: string;
  level: AcademicRiskLevel;
  courseId: string | null;
  reason: string;
}

export interface AcademicAction {
  id: string;
  agentId: SpecialistId | null;
  action: string;
  priority: "high" | "medium" | "low";
  reason: string;
  courseId: string | null;
}

export interface AcademicSnapshot extends AcademicCounts {
  semester: string | null;
  overallStatus: AcademicRiskLevel | "insufficient-data";
  courses: (CourseWorkload & { attentionScore: number; attention: AcademicRiskLevel; reasons: string[] })[];
  weakestTopics: LearningTopicContext[];
  strongestTopics: LearningTopicContext[];
  decliningTopics: LearningTopicContext[];
  activeStudyPlans: StudyPlanSummary[];
  activeStudyPlanProgress: number | null;
  missedStudyTasks: number;
  upcomingSessions: PlannedSessionSummary[];
  priorities: AcademicConcern[];
  risks: AcademicRisk[];
  examReadiness: ExamReadiness[];
  actionCandidates: AcademicAction[];
  limitations: string[];
}

export interface AcademicSnapshotInput {
  now: Date;
  semester: string | null;
  counts: AcademicCounts;
  courses: CourseWorkload[];
  assignments: import("../context/types").AssignmentContext[];
  exams: ExamContext[];
  learning?: import("../context/types").LearningContext;
  studyPlans: StudyPlanSummary[];
  missedStudyTasks: number;
  upcomingSessions: PlannedSessionSummary[];
  examPlanEvidence: ExamPlanEvidence[];
  limitations?: string[];
}
