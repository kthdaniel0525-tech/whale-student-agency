import "server-only";
import { z } from "zod";
import { db } from "@/server/db/client";
import { NotFoundError } from "@/server/services/academic";
import { retrieveAcademicContext } from "@/server/documents/retrieval";
import type {
  AssignmentContext,
  CourseContext,
  CourseReference,
  DocumentContext,
  ExamContext,
  MemoryContext,
  ProfileContext,
} from "./types";
import type { SelectedContext } from "./validation";

export type CategoryInput = {
  userId: string;
  input: SelectedContext;
  now: Date;
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
}: CategoryInput): Promise<AssignmentContext[]> {
  const rows = await db().assignment.findMany({
    where: {
      userId,
      course: { userId },
      ...(input.courseId ? { courseId: input.courseId } : {}),
      status: { not: "COMPLETED" },
      dueDate: {
        gte: new Date(now.getTime() - 30 * 86400000),
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
}: CategoryInput): Promise<ExamContext[]> {
  const rows = await db().exam.findMany({
    where: {
      userId,
      course: { userId },
      ...(input.courseId ? { courseId: input.courseId } : {}),
      examDate: {
        gte: now,
        lte: new Date(
          now.getTime() + input.options.deadlineWindowDays * 86400000,
        ),
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
    topics: row.topics.slice(0, 10).map((topic) => clip(topic, 100)),
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
  const rows = await retrieveAcademicContext(userId, {
    query: input.request,
    ...(input.courseId ? { courseId: input.courseId } : {}),
    ...(input.documentIds ? { documentIds: input.documentIds } : {}),
    maxResults: input.options.limits.documents,
  });
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
// UserMemory has no sensitivity flag. Accept only bounded, known preference values.
const memoryValues = {
  explanationStyle: z.enum(["concise", "detailed", "step-by-step", "socratic"]),
  studySessionMinutes: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(15).max(180)),
  academicGoal: z.enum([
    "understand_concepts",
    "prepare_for_exams",
    "improve_grades",
  ]),
};
export async function memoryContext({
  userId,
  input,
}: CategoryInput): Promise<MemoryContext[]> {
  const keys = input.options.memoryKeys;
  if (!keys.length) return [];
  const rows = await db().userMemory.findMany({
    where: { userId, key: { in: keys } },
    select: { key: true, value: true },
    orderBy: { key: "asc" },
    take: 3,
  });
  const result: MemoryContext[] = [];
  for (const row of rows) {
    const key = keys.find((key) => key === row.key);
    if (!key) continue;
    const parsed = memoryValues[key].safeParse(row.value);
    if (parsed.success) result.push({ key, value: parsed.data });
  }
  return result.slice(0, input.options.limits.memories);
}
