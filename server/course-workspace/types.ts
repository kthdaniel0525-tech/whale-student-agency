import type { DocumentItem } from "@/features/documents/types";

export type CourseAttention = "needs-attention" | "on-track" | "low-evidence";

export type CourseCard = {
  id: string;
  courseCode: string;
  courseName: string;
  professor: string | null;
  semester: string;
  attention: CourseAttention;
  attentionLabel: string;
  nextDeadline: { title: string; date: string; overdue: boolean } | null;
  nextExam: { title: string; date: string; daysRemaining: number } | null;
};

export type CourseWorkspaceAssignment = {
  id: string;
  title: string;
  description: string | null;
  dueDate: string;
  status: "TODO" | "IN_PROGRESS" | "COMPLETED";
  priority: "LOW" | "MEDIUM" | "HIGH";
  estimatedHours: number;
  overdue: boolean;
};

export type CourseWorkspaceExam = {
  id: string;
  title: string;
  examDate: string;
  daysRemaining: number;
  topics: string[];
  notes: string | null;
  readinessScore: number | null;
  readinessLevel: "high" | "moderate" | "low" | "insufficient-data";
  readinessLabel: string;
  readinessConfidence: number;
  weakTopics: string[];
  planCompletion: number | null;
};

export type CourseWorkspaceDocument = DocumentItem & {
  category: "Lecture" | "Syllabus" | "Reading" | "Notes" | "Other";
};

export type CourseWorkspaceNote = {
  id: string;
  conversationId: string;
  title: string;
  content: string;
  documentIds: string[];
  createdAt: string;
};

export type CourseWorkspaceTopic = {
  id: string;
  topic: string;
  mastery: number;
  confidence: number;
  confidenceLabel: "High confidence" | "Moderate confidence" | "Low evidence";
  recentAccuracy: number;
  questionsAttempted: number;
  trend: "improving" | "stable" | "declining" | "insufficient-data";
  stateLabel: string;
  needsMoreData: boolean;
};

export type CourseQuizHistory = {
  id: string;
  quizId: string;
  title: string;
  topic: string | null;
  difficulty: "easy" | "medium" | "hard";
  completedAt: string;
  accuracy: number;
  answered: number;
};

export type CoursePlanSummary = {
  id: string;
  title: string;
  completedTasks: number;
  remainingTasks: number;
  skippedTasks: number;
  completionPercentage: number | null;
  nextTask: { id: string; title: string; date: string; durationMinutes: number } | null;
} | null;

export type CourseRecommendation = {
  id: string;
  title: string;
  message: string;
  priority: "low" | "medium" | "high" | "critical";
  actionLabel: string;
} | null;

export type CourseWorkspace = {
  generatedAt: string;
  course: {
    id: string;
    courseCode: string;
    courseName: string;
    professor: string | null;
    semester: string;
    description: string | null;
    attention: CourseAttention;
    attentionLabel: string;
  };
  overview: {
    nextAssignment: CourseWorkspaceAssignment | null;
    nextExam: CourseWorkspaceExam | null;
    averageMastery: number | null;
    averageConfidence: number | null;
    learningLabel: string;
    topWeakTopic: CourseWorkspaceTopic | null;
    latestReadyDocument: CourseWorkspaceDocument | null;
  };
  nextBestAction: CourseRecommendation;
  assignments: CourseWorkspaceAssignment[];
  exams: CourseWorkspaceExam[];
  documents: CourseWorkspaceDocument[];
  notes: CourseWorkspaceNote[];
  topics: CourseWorkspaceTopic[];
  weakTopics: CourseWorkspaceTopic[];
  strongTopics: CourseWorkspaceTopic[];
  improvingTopics: CourseWorkspaceTopic[];
  recentQuizzes: CourseQuizHistory[];
  studyPlan: CoursePlanSummary;
  sectionErrors: Array<"academic" | "documents" | "notes" | "progress" | "quizzes" | "study-plan" | "recommendation">;
};
