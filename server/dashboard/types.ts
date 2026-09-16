import type { RecommendationPriority, RecommendationType } from "../recommendations/types";

export type DashboardRecommendation = {
  id: string;
  type: RecommendationType;
  title: string;
  message: string;
  priority: RecommendationPriority;
  courseLabel: string | null;
  actionLabel: string;
};

export type DashboardStudyTask = {
  id: string;
  title: string;
  date: string;
  courseId: string | null;
  courseCode: string | null;
  courseName: string | null;
  topicId: string | null;
  topic: string | null;
  examId: string | null;
  assignmentId: string | null;
  activityType: "learn" | "review" | "practice" | "quiz" | "assignment" | "exam-review" | "notes-review" | "mixed-practice";
  durationMinutes: number;
  priority: number;
  status: "planned" | "in-progress" | "completed" | "skipped";
  reason: string;
};

export type DashboardDeadline = {
  id: string;
  kind: "assignment" | "exam";
  title: string;
  courseId: string;
  courseCode: string;
  date: string;
  dateLabel: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | null;
};

export type DashboardLearningTopic = {
  id: string;
  topic: string;
  courseId: string;
  courseCode: string;
  mastery: number;
  confidence: number;
  trend: "improving" | "stable" | "declining" | "insufficient-data";
  stateLabel: string;
  needsMoreData: boolean;
};

export type DashboardExamReadiness = {
  examId: string;
  courseId: string;
  courseCode: string;
  title: string;
  daysRemaining: number;
  readinessScore: number | null;
  readinessLevel: "high" | "moderate" | "low" | "insufficient-data";
  confidence: number;
  weakTopics: string[];
};

export type DashboardCourse = {
  id: string;
  courseCode: string;
  courseName: string;
  attention: "high" | "moderate" | "low";
  attentionLabel: string;
  nextDeadline: DashboardDeadline | null;
};

export type DashboardStudyProgress = {
  completed: number;
  remaining: number;
  skipped: number;
  missed: number;
  percentage: number;
  planCount: number;
};

export type StudentDashboard = {
  generatedAt: string;
  greeting: string;
  summary: string;
  semester: string;
  timezone: string;
  hasCourses: boolean;
  nextBestAction: DashboardRecommendation | null;
  recommendations: DashboardRecommendation[];
  todayTasks: DashboardStudyTask[];
  upcomingDeadlines: DashboardDeadline[];
  examReadiness: DashboardExamReadiness[];
  weakTopics: DashboardLearningTopic[];
  strongTopics: DashboardLearningTopic[];
  improvingTopics: DashboardLearningTopic[];
  studyPlanProgress: DashboardStudyProgress | null;
  risks: Array<{ id: string; level: "low" | "moderate" | "high"; reason: string }>;
  courses: DashboardCourse[];
  sectionErrors: Array<"academic" | "recommendations" | "study-plan">;
  // Compatibility fields retained for existing API consumers.
  assignments: DashboardDeadline[];
  exams: DashboardDeadline[];
};
