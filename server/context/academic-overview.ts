import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { buildAcademicSnapshot } from "../academic/snapshot";
import type { CourseWorkload, StudyPlanSummary } from "../academic/types";
import type { CategoryInput } from "./categories";
import type { ContextData } from "./types";

const DAY = 86_400_000;
const MAX_COURSES = 20;
const MAX_PLANS = 3;

function localDay(now: Date, timezone = "UTC"): Date {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)!.value;
    // StudyTask.date is a date-only value persisted at UTC midnight.
    return new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
  } catch { return new Date(now.toISOString().slice(0, 10) + "T00:00:00Z"); }
}

/** Centralized aggregate retrieval. Detailed deadlines and learning are supplied
 * by the existing loaders; no second assignment/exam/attempt-history scan here. */
export async function academicOverviewContext(args: CategoryInput, data: ContextData) {
  const { userId, input, semester, now, clip } = args;
  const client = db();
  const courseWhere = { userId, ...(input.courseId ? { id: input.courseId } : {}), ...(semester ? { semester } : {}) };
  const academicWhere = { userId, course: courseWhere };
  const taskWhere: Prisma.StudyTaskWhereInput = {
    userId, studyPlan: { userId, status: "ACTIVE" },
    ...(input.courseId ? { course: courseWhere }
      : { OR: [{ courseId: null }, { course: courseWhere }] }),
    AND: [
      { OR: [{ examId: null }, { exam: { userId } }] },
      { OR: [{ assignmentId: null }, { assignment: { userId } }] },
      { OR: [{ topicId: null }, { topicRecord: { userId, course: { userId } } }] },
    ],
  };
  const today = localDay(now, data.profile?.timezone);
  const [courseRows, totalActiveCourses, overdue, overdueHighPriorityAssignments, due7, exams14, missed, plans, planCount, sessions] = await Promise.all([
    client.course.findMany({ where: courseWhere, select: { id: true, courseCode: true, courseName: true }, orderBy: [{ courseCode: "asc" }, { id: "asc" }], take: MAX_COURSES }),
    client.course.count({ where: courseWhere }),
    client.assignment.groupBy({ by: ["courseId"], where: { ...academicWhere, status: { not: "COMPLETED" }, dueDate: { lt: now } }, _count: true }),
    client.assignment.count({ where: { ...academicWhere, status: { not: "COMPLETED" }, priority: "HIGH", dueDate: { lt: now } } }),
    client.assignment.groupBy({ by: ["courseId"], where: { ...academicWhere, status: { not: "COMPLETED" }, dueDate: { gte: now, lte: new Date(now.getTime() + 7 * DAY) } }, _count: true }),
    client.exam.groupBy({ by: ["courseId"], where: { ...academicWhere, examDate: { gte: now, lte: new Date(now.getTime() + 14 * DAY) } }, _count: true }),
    client.studyTask.groupBy({ by: ["courseId"], where: { ...taskWhere, status: { in: ["PLANNED", "IN_PROGRESS"] }, date: { lt: today } }, _count: true }),
    client.studyPlan.findMany({ where: { userId, status: "ACTIVE", tasks: { some: taskWhere } }, select: { id: true, title: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: MAX_PLANS }),
    client.studyPlan.count({ where: { userId, status: "ACTIVE", tasks: { some: taskWhere } } }),
    client.studyTask.findMany({ where: { ...taskWhere, status: { in: ["PLANNED", "IN_PROGRESS"] }, date: { gte: today, lte: new Date(today.getTime() + 7 * DAY) } }, select: { id: true, studyPlanId: true, title: true, courseId: true, date: true, durationMinutes: true }, orderBy: [{ date: "asc" }, { priority: "desc" }, { id: "asc" }], take: 8 }),
  ]);
  const planIds = plans.map((plan) => plan.id);
  const examIds = data.exams?.map((exam) => exam.id) ?? [];
  const [planCounts, missedByPlan, examCounts] = await Promise.all([
    client.studyTask.groupBy({ by: ["studyPlanId", "status"], where: { ...taskWhere, studyPlanId: { in: planIds } }, _count: true }),
    client.studyTask.groupBy({ by: ["studyPlanId"], where: { ...taskWhere, studyPlanId: { in: planIds }, status: { in: ["PLANNED", "IN_PROGRESS"] }, date: { lt: today } }, _count: true }),
    client.studyTask.groupBy({ by: ["examId", "status"], where: { ...taskWhere, examId: { in: examIds }, status: { not: "SKIPPED" } }, _count: true }),
  ]);
  const sum = (rows: { _count: number }[]) => rows.reduce((total, row) => total + row._count, 0);
  const countFor = (rows: { courseId: string | null; _count: number }[], id: string) => rows.find((row) => row.courseId === id)?._count ?? 0;
  const courses: CourseWorkload[] = courseRows.map((course) => ({
    id: course.id, courseCode: clip(course.courseCode, 40), courseName: clip(course.courseName, 200),
    overdueAssignments: countFor(overdue, course.id), assignmentsDueNext7Days: countFor(due7, course.id),
    examsNext14Days: countFor(exams14, course.id), missedStudyTasks: countFor(missed, course.id),
  }));
  const studyPlans: StudyPlanSummary[] = plans.map((plan) => {
    const rows = planCounts.filter((row) => row.studyPlanId === plan.id);
    const completed = rows.find((row) => row.status === "COMPLETED")?._count ?? 0;
    const remaining = sum(rows.filter((row) => row.status === "PLANNED" || row.status === "IN_PROGRESS"));
    return { id: plan.id, title: clip(plan.title, 200), completedTasks: completed, remainingTasks: remaining,
      skippedTasks: rows.find((row) => row.status === "SKIPPED")?._count ?? 0,
      missedTasks: missedByPlan.find((row) => row.studyPlanId === plan.id)?._count ?? 0,
      completionPercentage: completed + remaining ? Math.round(100 * completed / (completed + remaining)) : null };
  });
  return buildAcademicSnapshot({
    now, semester: semester ?? null,
    counts: { totalActiveCourses, overdueAssignments: sum(overdue), overdueHighPriorityAssignments, assignmentsDueNext7Days: sum(due7), examsNext14Days: sum(exams14) },
    courses, assignments: data.assignments ?? [], exams: data.exams ?? [], learning: data.learning,
    studyPlans, missedStudyTasks: sum(missed),
    upcomingSessions: sessions.map((task) => ({ id: task.id, planId: task.studyPlanId, title: clip(task.title, 200), courseId: task.courseId, date: task.date.toISOString().slice(0, 10), durationMinutes: task.durationMinutes })),
    examPlanEvidence: examIds.map((examId) => ({ examId,
      completed: sum(examCounts.filter((row) => row.examId === examId && row.status === "COMPLETED")),
      total: sum(examCounts.filter((row) => row.examId === examId)),
    })),
    limitations: [
      ...(totalActiveCourses > courses.length ? [`Showing ${courses.length} of ${totalActiveCourses} courses; counts cover the full selected semester.`] : []),
      ...(planCount > plans.length ? [`Plan progress covers the ${plans.length} most recently updated active plans; missed-task count covers all active plans.`] : []),
      ...(!semester && !input.courseId ? ["No current semester is available; course scope includes all owned courses."] : []),
      ...(data.assignments?.length === input.options.limits.assignments ? ["Assignment detail limit reached; workload counts remain complete."] : []),
      ...(data.exams?.length === input.options.limits.exams ? ["Exam detail limit reached; readiness covers only listed exams."] : []),
      "Learning summaries are bounded; unlisted topics are not assumed mastered.",
    ],
  });
}
