import type { AcademicSnapshot } from "../academic/types";
import type { CareerContext } from "../career/types";
import type {
  MemoryCategory,
  MemorySourceType,
  MemoryValue,
} from "../memory/types";

export type ContextCategory =
  | "availability"
  | "profile"
  | "course"
  | "assignments"
  | "exams"
  | "documents"
  | "memories"
  | "learning"
  | "career"
  | "academicOverview";
export type MemoryKey =
  | "explanationStyle"
  | "answerLength"
  | "studySessionMinutes"
  | "quizDifficulty"
  | "questionType"
  | "noteStyle"
  | "planningIntensity"
  | "preferredStudyTime"
  | "academicGoal"
  | "targetGrade"
  | "courseGoal"
  | "examGoal"
  | "targetRole"
  | "targetIndustry"
  | "targetCompanies"
  | "internshipTimeline"
  | "portfolioGoal";
export type ContextOptions = Partial<Record<ContextCategory, boolean>> & {
  /** Reserve retrieval slots for every explicitly selected document. */
  selectedDocumentCoverage?: boolean;
  availabilityExcludePlanId?: string;
  availabilityWindow?: { startDate?: string; endDate?: string };
  memoryKeys?: MemoryKey[];
  memoryCategories?: MemoryCategory[];
  deadlineWindowDays?: number;
  limits?: {
    assignments?: number;
    exams?: number;
    documents?: number;
    memories?: number;
    learning?: number;
    maxCharacters?: number;
  };
};
export type ContextRequest = {
  request: string;
  courseId?: string;
  examId?: string;
  assignmentId?: string;
  projectIds?: string[];
  documentIds?: string[];
  options?: ContextOptions;
};
export type ProfileContext = {
  name: string;
  school: string;
  program: string;
  currentYear: number;
  semester: string;
  academicGoal: string;
  explanationDifficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
  studySessionMinutes: number;
  timezone: string;
};
export type CourseContext = {
  id: string;
  courseCode: string;
  courseName: string;
  professor: string | null;
  semester: string;
  description: string | null;
};
export type CourseReference = Pick<
  CourseContext,
  "id" | "courseCode" | "courseName"
>;
export type AssignmentContext = {
  id: string;
  title: string;
  /** Exact wording and revision are included only for an explicitly selected assignment. */
  description?: string | null;
  updatedAt?: string;
  dueDate: string;
  status: "TODO" | "IN_PROGRESS" | "COMPLETED";
  priority: "LOW" | "MEDIUM" | "HIGH";
  estimatedHours: number;
  overdue: boolean;
  course: CourseReference;
};
export type ExamContext = {
  id: string;
  title: string;
  examDate: string;
  topics: string[];
  topicCount?: number;
  daysRemaining: number;
  course: CourseReference;
};
export type DocumentContext = {
  content: string;
  documentTitle: string;
  documentId: string;
  pageNumber: number | null;
  pageEnd: number | null;
  courseId: string | null;
  courseCode: string | null;
  chunkIndex: number;
  similarityScore: number;
};
export type MemoryContext = {
  id: string;
  category: MemoryCategory;
  key: string;
  value: MemoryValue;
  sourceType: MemorySourceType;
  confidence: number;
  importance: number;
  stale: boolean;
  lastUpdated: string;
  explanation: string;
};
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
export type LearningEvidence = "limited" | "sufficient";
export type LearningRecommendationReason =
  | "low-mastery"
  | "low-recent-performance"
  | "stale-practice"
  | "low-confidence"
  | "upcoming-need"
  | "unpracticed";
export type LearningTopicContext = {
  topicId: string;
  topic: string;
  course: CourseReference;
  mastery: number;
  confidence: number;
  recentAccuracy: number;
  questionsAttempted: number;
  practiceSessions: number;
  status: LearningStatus;
  evidence: LearningEvidence;
  trend: LearningTrend;
  lastPracticedAt: string | null;
};
export type RecommendedLearningTopicContext = LearningTopicContext & {
  reasons: LearningRecommendationReason[];
};
export type LearningContext = {
  weakTopics: LearningTopicContext[];
  strongTopics: LearningTopicContext[];
  recommendedTopics: RecommendedLearningTopicContext[];
  examTopics?: LearningTopicContext[];
};
export interface LearningContextSource {
  load(input: {
    userId: string;
    courseId?: string;
    limit: number;
    now: Date;
  }): Promise<LearningContext | undefined>;
}
export type ContextData = {
  availability?: import("@/lib/student/calendar/types").AvailabilityContext;
  career?: CareerContext;
  profile?: ProfileContext;
  course?: CourseContext;
  assignments?: AssignmentContext[];
  exams?: ExamContext[];
  documents?: DocumentContext[];
  memories?: MemoryContext[];
  learning?: LearningContext;
  academicOverview?: AcademicSnapshot;
};
export type UserContext = ContextData & {
  metadata: {
    generatedAt: string;
    requestedCategories: ContextCategory[];
    unavailableCategories: ContextCategory[];
    truncatedCategories: ContextCategory[];
    estimatedContextSize: number;
    estimatedTokens: number;
    maxCharacters: number;
  };
};
