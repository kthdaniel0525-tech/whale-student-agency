import "server-only";
import { db } from "@/server/db/client";
import { NotFoundError } from "@/server/services/academic";
import { retrieveAcademicContext, selectedDocumentContext } from "@/server/documents/retrieval";
import { getLearningOverview } from "@/server/learning";
import { retrieveRelevantMemories } from "@/server/memory";
import type {
  LearningTopicSummary,
  RecommendedPracticeTopic,
} from "@/server/learning/types";
import type {
  AssignmentContext,
  CourseContext,
  CourseReference,
  DocumentContext,
  ExamContext,
  LearningContext,
  LearningTopicContext,
  MemoryContext,
  ProfileContext,
  RecommendedLearningTopicContext,
} from "./types";
import type { SelectedContext } from "./validation";

export type CategoryInput = {
  userId: string;
  input: SelectedContext;
  now: Date;
  selectedAssignment?: Awaited<ReturnType<typeof import("../services/academic").getAssignment>>;
  semester?: string;
  examTopicNames?: string[];
  clip: (text: string, max: number) => string;
};
const courseSelect = { id: true, courseCode: true, courseName: true } as const;
function reference(
  course: CourseReference,
  clip: CategoryInput["clip"],
): CourseReference {
  return {
    id: course.id,
    courseCode: clip(course.courseCode, 40),
    courseName: clip(course.courseName, 200),
  };
}

export async function profileContext({
  userId,
  clip,
}: CategoryInput): Promise<ProfileContext | undefined> {
  const row = await db().profile.findUnique({
    where: { userId },
    select: {
      school: true,
      program: true,
      currentYear: true,
      semester: true,
      academicGoal: true,
      explanationDifficulty: true,
      studySessionMinutes: true,
      timezone: true,
      user: { select: { name: true } },
    },
  });
  if (!row) return undefined;
  return {
    name: clip(row.user.name, 120),
    school: clip(row.school, 200),
    program: clip(row.program, 200),
    currentYear: row.currentYear,
    semester: clip(row.semester, 80),
    academicGoal: clip(row.academicGoal, 500),
    explanationDifficulty: row.explanationDifficulty,
    studySessionMinutes: row.studySessionMinutes,
    timezone: clip(row.timezone, 80),
  };
}
export async function courseContext({
  userId,
  input,
  clip,
}: CategoryInput): Promise<CourseContext | undefined> {
  if (!input.courseId) return undefined;
  const row = await db().course.findUnique({
    where: { id_userId: { id: input.courseId, userId } },
    select: {
      ...courseSelect,
      professor: true,
      semester: true,
      description: true,
    },
  });
  if (!row) throw new NotFoundError();
  return {
    ...reference(row, clip),
    professor: row.professor === null ? null : clip(row.professor, 150),
    semester: clip(row.semester, 80),
    description: row.description === null ? null : clip(row.description, 1000),
  };
}
export async function assignmentContext({
  userId,
  input,
  now,
  clip,
  semester,
  selectedAssignment,
}: CategoryInput): Promise<AssignmentContext[]> {
  if (selectedAssignment) {
    const course = await db().course.findUnique({ where: { id_userId: { id: selectedAssignment.courseId, userId } }, select: courseSelect });
    if (!course) throw new NotFoundError();
    return [{ id: selectedAssignment.id, title: selectedAssignment.title, description: selectedAssignment.description,
      updatedAt: selectedAssignment.updatedAt.toISOString(), dueDate: selectedAssignment.dueDate.toISOString(),
      status: selectedAssignment.status, priority: selectedAssignment.priority, estimatedHours: selectedAssignment.estimatedHours,
      overdue: selectedAssignment.status !== "COMPLETED" && selectedAssignment.dueDate < now, course: reference(course, clip) }];
  }
  const rows = await db().assignment.findMany({
    where: {
      userId,
      course: { userId, ...(semester ? { semester } : {}) },
      ...(input.courseId ? { courseId: input.courseId } : {}),
      status: { not: "COMPLETED" },
      dueDate: {
        ...(!input.options.academicOverview
          ? { gte: new Date(now.getTime() - 30 * 86400000) }
          : {}),
        lte: new Date(
          now.getTime() + input.options.deadlineWindowDays * 86400000,
        ),
      },
    },
    orderBy: [{ dueDate: "asc" }, { priority: "desc" }, { id: "asc" }],
    take: input.options.limits.assignments,
    select: {
      id: true,
      title: true,
      dueDate: true,
      status: true,
      priority: true,
      estimatedHours: true,
      course: { select: courseSelect },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    title: clip(row.title, 200),
    dueDate: row.dueDate.toISOString(),
    status: row.status,
    priority: row.priority,
    estimatedHours: row.estimatedHours,
    overdue: row.dueDate < now,
    course: reference(row.course, clip),
  }));
}
export async function examContext({
  userId,
  input,
  now,
  clip,
  semester,
}: CategoryInput): Promise<ExamContext[]> {
  const rows = await db().exam.findMany({
    where: {
      userId,
      ...(input.examId ? { id: input.examId } : {}),
      course: { userId, ...(semester ? { semester } : {}) },
      ...(input.courseId ? { courseId: input.courseId } : {}),
      examDate: {
        gte: now,
        ...(!input.examId ? { lte: new Date(
          now.getTime() + input.options.deadlineWindowDays * 86400000,
        ) } : {}),
      },
    },
    orderBy: [{ examDate: "asc" }, { id: "asc" }],
    take: input.options.limits.exams,
    select: {
      id: true,
      title: true,
      examDate: true,
      topics: true,
      course: { select: courseSelect },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    title: clip(row.title, 200),
    examDate: row.examDate.toISOString(),
    topics: row.topics.slice(0, 10).map((topic) => clip(topic, 120)),
    ...(input.options.academicOverview ? { topicCount: row.topics.length } : {}),
    daysRemaining: Math.ceil(
      (row.examDate.getTime() - now.getTime()) / 86400000,
    ),
    course: reference(row.course, clip),
  }));
}
export async function documentContext({
  userId,
  input,
  clip,
}: CategoryInput): Promise<DocumentContext[]> {
  const selected = input.options.selectedDocumentCoverage ? input.documentIds : undefined;
  const retrieve = (documentIds: string[] | undefined, maxResults: number) => retrieveAcademicContext(userId, {
    query: input.request,
    ...(input.courseId ? { courseId: input.courseId } : {}),
    ...(documentIds ? { documentIds } : {}), maxResults,
  });
  // Reuse the existing authorized RAG service, reserving slots so one large
  // document cannot crowd out the other explicitly selected lecture materials.
  const rows = selected?.length
    ? (await Promise.all(selected.map(async (id, i) => {
        const limit = Math.floor(input.options.limits.documents / selected.length) +
          (i < input.options.limits.documents % selected.length ? 1 : 0);
        const semantic = await retrieve([id], limit);
        return semantic.length
          ? semantic
          : selectedDocumentContext(userId, id, limit);
      }))).flat()
    : await retrieve(input.documentIds, input.options.limits.documents);
  return rows.map((row) => ({
    content: clip(row.content, 3500),
    documentTitle: clip(row.documentTitle, 200),
    documentId: row.documentId,
    pageNumber: row.pageNumber,
    pageEnd: row.pageEnd,
    courseId: row.courseId,
    courseCode: row.courseCode === null ? null : clip(row.courseCode, 40),
    chunkIndex: row.chunkIndex,
    similarityScore: row.similarityScore,
  }));
}

function learningTopic(
  item: LearningTopicSummary,
  clip: CategoryInput["clip"],
): LearningTopicContext {
  return {
    topicId: item.id,
    topic: clip(item.topic, 160),
    course: {
      id: item.courseId,
      courseCode: clip(item.courseCode, 40),
      courseName: clip(item.courseName, 200),
    },
    mastery: item.mastery,
    confidence: item.confidence,
    recentAccuracy: item.recentAccuracy,
    questionsAttempted: item.questionsAttempted,
    practiceSessions: item.practiceSessions,
    status: item.status,
    evidence: item.evidence,
    trend: item.trend,
    lastPracticedAt: item.lastPracticedAt,
  };
}

function recommendedLearningTopic(
  item: RecommendedPracticeTopic,
  clip: CategoryInput["clip"],
): RecommendedLearningTopicContext {
  return {
    ...learningTopic(item, clip),
    reasons: [...item.reasons],
  };
}

export async function learningContext({
  userId,
  input,
  now,
  clip,
  semester,
  examTopicNames,
}: CategoryInput): Promise<LearningContext | undefined> {
  const overview = await getLearningOverview({
    userId,
    ...(input.courseId ? { courseId: input.courseId } : {}),
    limit: input.options.limits.learning,
    now,
    ...(semester ? { semester } : {}),
    ...(examTopicNames ? { examTopicNames } : {}),
  });
  if (!overview) return undefined;
  const result: LearningContext = {
    weakTopics: overview.weakTopics.map((item) => learningTopic(item, clip)),
    strongTopics: overview.strongTopics.map((item) =>
      learningTopic(item, clip),
    ),
    recommendedTopics: overview.recommendedTopics.map((item) =>
      recommendedLearningTopic(item, clip),
    ),
    ...(overview.examTopics ? {
      examTopics: overview.examTopics.map((item) => learningTopic(item, clip)),
    } : {}),
  };
  return Object.values(result).some((items) => items.length)
    ? result
    : undefined;
}
export async function memoryContext({
  userId,
  input,
  now,
  clip,
}: CategoryInput): Promise<MemoryContext[]> {
  const rows = await retrieveRelevantMemories({
    userId,
    request: input.request,
    categories: input.options.memoryCategories,
    keys: input.options.memoryKeys,
    limit: input.options.limits.memories,
    now,
  });
  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    key: clip(row.key, 80),
    value:
      typeof row.value === "string" ? clip(row.value, 500) : row.value,
    sourceType: row.sourceType,
    confidence: row.confidence,
    importance: row.importance,
    stale: row.stale,
    lastUpdated: row.lastObservedAt,
    explanation: clip(row.explanation, 300),
  }));
}
