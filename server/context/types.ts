export type ContextCategory =
  | "profile"
  | "course"
  | "assignments"
  | "exams"
  | "documents"
  | "memories"
  | "learning";
export type MemoryKey =
  | "explanationStyle"
  | "studySessionMinutes"
  | "academicGoal";
export type ContextOptions = Partial<Record<ContextCategory, boolean>> & {
  memoryKeys?: MemoryKey[];
  deadlineWindowDays?: number;
  limits?: {
    assignments?: number;
    exams?: number;
    documents?: number;
    memories?: number;
    maxCharacters?: number;
  };
};
export type ContextRequest = {
  request: string;
  courseId?: string;
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
export type MemoryContext = { key: MemoryKey; value: string | number };
// Optional future contract; no progress model, writes, or fabricated mastery scores.
export type LearningContext = {
  topics: { topic: string; mastery: "unknown" | "developing" | "confident" }[];
  updatedAt: string;
};
export interface LearningContextSource {
  load(input: {
    userId: string;
    courseId?: string;
    limit: number;
  }): Promise<LearningContext | undefined>;
}
export type ContextData = {
  profile?: ProfileContext;
  course?: CourseContext;
  assignments?: AssignmentContext[];
  exams?: ExamContext[];
  documents?: DocumentContext[];
  memories?: MemoryContext[];
  learning?: LearningContext;
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
