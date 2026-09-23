export type ProgressRange = "7d" | "30d" | "semester";
export type ProgressTrend = "improving" | "stable" | "declining" | "insufficient-data";

export type ProgressOverview = {
  activeCourses: number;
  topicsTracked: number;
  averageMastery: number | null;
  completedStudyTasksThisWeek: number;
  upcomingExams: number;
  highestPriorityTopic: string | null;
};

export type ProgressHistoryPoint = {
  date: string;
  mastery: number;
  confidence: number;
};

export type ProgressTopicQuiz = {
  date: string;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  accuracy: number;
};

export type ProgressTopic = {
  id: string;
  topic: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  mastery: number;
  confidence: number;
  confidenceLabel: "High confidence" | "Moderate confidence" | "Low evidence";
  recentAccuracy: number;
  questionsAttempted: number;
  practiceSessions: number;
  trend: ProgressTrend;
  trendLabel: string;
  lastPracticedAt: string | null;
  status: "weak" | "developing" | "good" | "strong" | "unpracticed";
  stateLabel: string;
  needsMoreData: boolean;
  history: ProgressHistoryPoint[];
  recentQuizzes: ProgressTopicQuiz[];
  recommendedAction: "review" | "practice" | "diagnostic" | "maintain";
};

export type ProgressCourse = {
  id: string;
  courseCode: string;
  courseName: string;
  attention: "high" | "moderate" | "low";
  attentionLabel: string;
  averageMastery: number | null;
  averageConfidence: number | null;
  trackedTopics: number;
  strongTopic: string | null;
  needsAttentionTopic: string | null;
};

export type QuizHistoryItem = {
  id: string;
  quizId: string;
  title: string;
  courseId: string | null;
  courseCode: string | null;
  topic: string | null;
  difficulty: "easy" | "medium" | "hard";
  completedAt: string;
  accuracy: number;
  answered: number;
};

export type QuestionTypeInsight = {
  type: "multiple-choice" | "true-false" | "short-answer" | "long-answer";
  label: string;
  accuracy: number;
  attempts: number;
};

export type QuizSummary = {
  completed: number;
  recentAccuracy: number | null;
  history: QuizHistoryItem[];
  questionTypes: QuestionTypeInsight[];
  strongestTopic: string | null;
  weakestTopic: string | null;
};

export type StudyDay = {
  date: string;
  label: string;
  plannedMinutes: number;
  completedMinutes: number;
  completedTasks: number;
  skippedTasks: number;
};

export type StudyConsistency = {
  plannedMinutes: number;
  completedMinutes: number;
  completedTasks: number;
  skippedTasks: number;
  completionRate: number | null;
  days: StudyDay[];
  insight: string | null;
};

export type ActivePlanProgress = {
  id: string;
  title: string;
  endDate: string;
  daysRemaining: number;
  completedTasks: number;
  remainingTasks: number;
  skippedTasks: number;
  completionPercentage: number | null;
};

export type ProgressExamReadiness = {
  examId: string;
  courseId: string;
  courseCode: string;
  title: string;
  daysRemaining: number;
  readinessScore: number | null;
  readinessLevel: "high" | "moderate" | "low" | "insufficient-data";
  readinessLabel: string;
  confidence: number;
  coverage: number;
  recentAccuracy: number | null;
  planCompletion: number | null;
  weakTopics: string[];
  explanation: string;
};

export type ProgressRecommendation = {
  id: string;
  title: string;
  message: string;
  priority: "low" | "medium" | "high" | "critical";
  actionLabel: string;
} | null;

export type StudentProgress = {
  generatedAt: string;
  range: ProgressRange;
  semester: string;
  hasCourses: boolean;
  hasLearningData: boolean;
  overview: ProgressOverview;
  courses: ProgressCourse[];
  topics: ProgressTopic[];
  weakTopics: ProgressTopic[];
  strongTopics: ProgressTopic[];
  improvingTopics: ProgressTopic[];
  decliningTopics: ProgressTopic[];
  lowEvidenceTopics: ProgressTopic[];
  quizSummary: QuizSummary;
  studyConsistency: StudyConsistency;
  activePlans: ActivePlanProgress[];
  examReadiness: ProgressExamReadiness[];
  nextBestAction: ProgressRecommendation;
  sectionErrors: Array<"academic" | "learning" | "quiz" | "study" | "recommendation">;
};
