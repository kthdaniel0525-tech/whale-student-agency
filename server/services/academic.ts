import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { cleanupAfterDelete } from "@/server/documents/cleanup";
import { db } from "@/server/db/client";
import { getTopRecommendations, refreshRecommendationsBestEffort } from "@/server/recommendations";
import type {
  CourseInput,
  AssignmentInput,
  ExamInput,
  ProfileInput,
} from "@/features/student/validation/schemas";
export class NotFoundError extends Error {
  constructor() {
    super("This item was not found.");
  }
}
export async function getCourse(userId: string, id: string, client: Prisma.TransactionClient = db()) {
  const course = await client.course.findUnique({
    where: { id_userId: { id, userId } },
    include: {
      assignments: { where: { userId }, orderBy: { dueDate: "asc" } },
      exams: { where: { userId }, orderBy: { examDate: "asc" } },
    },
  });
  if (!course) throw new NotFoundError();
  return course;
}
export function listCourses(userId: string) {
  return db().course.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: {
          assignments: { where: { userId, status: { not: "COMPLETED" } } },
          exams: { where: { userId } },
        },
      },
    },
  });
}
export function createCourse(userId: string, input: CourseInput, client: Prisma.TransactionClient = db()) {
  return client.course.create({ data: { ...input, userId } });
}
export async function updateCourse(
  userId: string,
  id: string,
  input: CourseInput,
) {
  const result = await db().course.updateMany({
    where: { id, userId },
    data: input,
  });
  if (!result.count) throw new NotFoundError();
  return getCourse(userId, id);
}
export async function deleteCourse(userId: string, id: string) {
  const result = await db().course.deleteMany({ where: { id, userId } });
  if (!result.count) throw new NotFoundError();
  const cleanupPending = await cleanupAfterDelete(userId);
  await refreshRecommendationsBestEffort(userId);
  return { success: true, cleanupPending };
}
export async function createAssignment(
  userId: string,
  courseId: string,
  input: AssignmentInput,
  transaction?: Prisma.TransactionClient,
) {
  await getCourse(userId, courseId, transaction ?? db());
  const assignment = await (transaction ?? db()).assignment.create({
    data: {
      ...input,
      dueDate: new Date(input.dueDate),
      userId,
      courseId,
      completedAt: input.status === "COMPLETED" ? new Date() : null,
    },
  });
  if (!transaction) await refreshRecommendationsBestEffort(userId);
  return assignment;
}
export async function getAssignment(userId: string, id: string) {
  const item = await db().assignment.findFirst({ where: { id, userId } });
  if (!item) throw new NotFoundError();
  return item;
}
export async function updateAssignment(
  userId: string,
  id: string,
  input: AssignmentInput | Pick<AssignmentInput, "status">,
) {
  const old = await getAssignment(userId, id);
  const result = await db().assignment.updateMany({
    where: { id, userId },
    data: {
      ...input,
      ...("dueDate" in input ? { dueDate: new Date(input.dueDate) } : {}),
      completedAt:
        input.status === "COMPLETED" ? (old.completedAt ?? new Date()) : null,
    },
  });
  if (!result.count) throw new NotFoundError();
  await refreshRecommendationsBestEffort(userId);
  return getAssignment(userId, id);
}
export async function deleteAssignment(userId: string, id: string) {
  const result = await db().assignment.deleteMany({ where: { id, userId } });
  if (!result.count) throw new NotFoundError();
  await refreshRecommendationsBestEffort(userId);
}
export async function createExam(
  userId: string,
  courseId: string,
  input: ExamInput,
  transaction?: Prisma.TransactionClient,
) {
  await getCourse(userId, courseId, transaction ?? db());
  const exam = await (transaction ?? db()).exam.create({
    data: { ...input, examDate: new Date(input.examDate), userId, courseId },
  });
  if (!transaction) await refreshRecommendationsBestEffort(userId);
  return exam;
}
export async function getExam(userId: string, id: string) {
  const item = await db().exam.findFirst({ where: { id, userId } });
  if (!item) throw new NotFoundError();
  return item;
}
export async function updateExam(userId: string, id: string, input: ExamInput) {
  const result = await db().exam.updateMany({
    where: { id, userId },
    data: { ...input, examDate: new Date(input.examDate) },
  });
  if (!result.count) throw new NotFoundError();
  await refreshRecommendationsBestEffort(userId);
  return getExam(userId, id);
}
export async function deleteExam(userId: string, id: string) {
  const result = await db().exam.deleteMany({ where: { id, userId } });
  if (!result.count) throw new NotFoundError();
  await refreshRecommendationsBestEffort(userId);
}
export async function saveProfile(userId: string, input: ProfileInput) {
  const { name, ...data } = input;
  const [, profile] = await db().$transaction([
    db().user.update({ where: { id: userId }, data: { name } }),
    db().profile.upsert({
      where: { userId },
      create: { ...data, userId },
      update: data,
    }),
  ]);
  const { refreshNotificationPreferenceEffects } = await import("../preferences/notifications");
  await refreshNotificationPreferenceEffects(userId);
  return { ...profile, name };
}
export async function dashboard(userId: string) {
  const [courses, assignments, exams, recommendations] = await Promise.all([
    listCourses(userId),
    db().assignment.findMany({
      where: { userId, status: { not: "COMPLETED" } },
      orderBy: [{ dueDate: "asc" }, { priority: "desc" }],
      take: 12,
      include: { course: { select: { courseCode: true } } },
    }),
    db().exam.findMany({
      where: { userId, examDate: { gte: new Date() } },
      orderBy: { examDate: "asc" },
      take: 8,
      include: { course: { select: { courseCode: true } } },
    }),
    getTopRecommendations({ userId, limit: 5 }),
  ]);
  return { courses, assignments, exams, recommendations };
}

/** Only these imported fields belong to the source. Preserve personal effort, priority and completion. */
export async function updateImportedAssignment(userId: string, id: string, input: Pick<AssignmentInput, "title" | "description" | "dueDate">, tx: Prisma.TransactionClient) {
  const result = await tx.assignment.updateMany({ where: { id, userId }, data: { ...input, dueDate: new Date(input.dueDate) } });
  if (!result.count) throw new NotFoundError();
}
export async function updateImportedExam(userId: string, id: string, input: Pick<ExamInput, "title" | "examDate">, tx: Prisma.TransactionClient) {
  const result = await tx.exam.updateMany({ where: { id, userId }, data: { ...input, examDate: new Date(input.examDate) } });
  if (!result.count) throw new NotFoundError();
}
