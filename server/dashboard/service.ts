import "server-only";
import { auth } from "../auth/config";
import { buildUserContext } from "../context/builder";
import { db } from "../db/client";
import { getNextBestAction, getTopRecommendations, type RecommendationRecord } from "../recommendations";
import type { AcademicSnapshot } from "../academic/types";
import type { LearningTopicContext, UserContext } from "../context/types";
import type {
  DashboardCourse,
  DashboardDeadline,
  DashboardExamReadiness,
  DashboardLearningTopic,
  DashboardRecommendation,
  DashboardStudyProgress,
  DashboardStudyTask,
  StudentDashboard,
} from "./types";

const DAY = 86_400_000;
const contextOptions = {
  profile: true,
  assignments: true,
  exams: true,
  learning: true,
  academicOverview: true,
  deadlineWindowDays: 30,
  limits: {
    assignments: 20,
    exams: 10,
    learning: 10,
    maxCharacters: 40_000,
  },
} as const;

type DashboardDependencies = {
  buildContext?: typeof buildUserContext;
  loadRecommendations?: typeof getTopRecommendations;
};

export class DashboardError extends Error {
  readonly code = "UNAUTHENTICATED";
  constructor() {
    super("Sign in to view this dashboard.");
    this.name = "DashboardError";
  }
}

function localDate(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function dayDifference(value: string | Date, today: string): number {
  return Math.round((Date.parse(new Date(value).toISOString().slice(0, 10)) - Date.parse(today)) / DAY);
}

function dateLabel(value: string | Date, today: string): string {
  const days = dayDifference(value, today);
  if (days < 0) return "Overdue";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days} days`;
}

function greeting(name: string, timezone: string, now: Date): string {
  let hour = now.getUTCHours();
  try {
    hour = Number(new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now));
  } catch {
    // UTC remains a safe deterministic fallback for invalid legacy timezones.
  }
  const period = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  return `Good ${period}, ${name.split(" ")[0]}`;
}

const actionLabels: Record<RecommendationRecord["type"], string> = {
  "exam-preparation": "Prepare for exam",
  "assignment-deadline": "Start assignment support",
  "weak-topic": "Start recovery",
  "diagnostic-practice": "Take diagnostic quiz",
  "study-plan": "Update study plan",
  "missed-study-task": "Rebalance plan",
  "course-inactivity": "Review course",
  "lecture-study": "Study lecture",
  "career-preparation": "Continue career plan",
};

function recommendation(
  value: RecommendationRecord,
  courseLabels: ReadonlyMap<string, string>,
): DashboardRecommendation {
  const courseId = value.actionPayload && typeof value.actionPayload.courseId === "string"
    ? value.actionPayload.courseId
    : null;
  return {
    id: value.id,
    type: value.type,
    title: value.title,
    message: value.message,
    priority: value.priority,
    courseLabel: courseId ? courseLabels.get(courseId) ?? null : null,
    actionLabel: actionLabels[value.type],
  };
}

function topic(value: LearningTopicContext): DashboardLearningTopic {
  const needsMoreData = value.evidence === "limited" || value.status === "unpracticed";
  const labels = {
    weak: "Needs attention",
    developing: "Developing",
    good: "Good",
    strong: "Strong",
    unpracticed: "Needs more data",
  } as const;
  return {
    id: value.topicId,
    topic: value.topic,
    courseId: value.course.id,
    courseCode: value.course.courseCode,
    mastery: Math.round(value.mastery),
    confidence: Math.round(value.confidence),
    trend: value.trend,
    stateLabel: needsMoreData ? "Needs more data" : labels[value.status],
    needsMoreData,
  };
}

function dedupeTopics(values: readonly LearningTopicContext[]): LearningTopicContext[] {
  return [...new Map(values.map((value) => [value.topicId, value])).values()];
}

function studyProgress(snapshot: AcademicSnapshot | undefined): DashboardStudyProgress | null {
  if (!snapshot?.activeStudyPlans.length) return null;
  const completed = snapshot.activeStudyPlans.reduce((sum, plan) => sum + plan.completedTasks, 0);
  const remaining = snapshot.activeStudyPlans.reduce((sum, plan) => sum + plan.remainingTasks, 0);
  const skipped = snapshot.activeStudyPlans.reduce((sum, plan) => sum + plan.skippedTasks, 0);
  return {
    completed,
    remaining,
    skipped,
    missed: snapshot.activeStudyPlans.reduce((sum, plan) => sum + plan.missedTasks, 0),
    percentage: snapshot.activeStudyPlanProgress ?? 0,
    planCount: snapshot.activeStudyPlans.length,
  };
}

function summary(tasks: readonly DashboardStudyTask[], deadlines: readonly DashboardDeadline[], risks: number): string {
  const tomorrow = deadlines.filter((item) => item.kind === "assignment" && item.dateLabel === "Tomorrow").length;
  const parts = [
    tasks.length ? `${tasks.length} study task${tasks.length === 1 ? "" : "s"} today` : "no study tasks scheduled today",
    tomorrow ? `${tomorrow} assignment${tomorrow === 1 ? "" : "s"} due tomorrow` : null,
    risks ? `${risks} item${risks === 1 ? "" : "s"} need attention` : null,
  ].filter(Boolean);
  return parts.join(" · ") + ".";
}

function activity(value: string): DashboardStudyTask["activityType"] {
  return value.toLowerCase().replaceAll("_", "-") as DashboardStudyTask["activityType"];
}

function taskStatus(value: string): DashboardStudyTask["status"] {
  return value.toLowerCase().replaceAll("_", "-") as DashboardStudyTask["status"];
}

/** Bounded read-only aggregation. Existing domain services own all ranking,
 * mastery, readiness, risk and plan calculations; this service only composes. */
export async function getStudentDashboard(
  userId: string,
  requestHeaders: Headers,
  options: { now?: Date; dependencies?: DashboardDependencies } = {},
): Promise<StudentDashboard> {
  const session = await auth().api.getSession({
    headers: new Headers(requestHeaders),
    query: { disableRefresh: true },
  });
  if (!session?.user.id || session.user.id !== userId) throw new DashboardError();
  const now = options.now ?? new Date();
  const buildContext = options.dependencies?.buildContext ?? buildUserContext;
  const loadRecommendations = options.dependencies?.loadRecommendations ?? getTopRecommendations;
  const [identity, courseCount] = await Promise.all([
    db().profile.findUnique({
      where: { userId },
      select: { semester: true, timezone: true, user: { select: { name: true } } },
    }),
    db().course.count({ where: { userId } }),
  ]);
  if (!identity) throw new Error("Dashboard profile is unavailable.");
  const today = localDate(now, identity.timezone);
  const todayDate = new Date(`${today}T00:00:00.000Z`);

  const [contextResult, recommendationResult, taskResult, deadlineResult] = await Promise.allSettled([
    buildContext({ request: "Prepare the deterministic student dashboard.", options: contextOptions }, requestHeaders),
    (async () => {
      const top = await loadRecommendations({ userId, limit: 4, now });
      const next = await getNextBestAction(userId, now, { refresh: false });
      return { top, next };
    })(),
    db().studyTask.findMany({
      where: {
        userId,
        date: todayDate,
        // Keep today's completed/skipped work visible even when the final
        // mutation closes the parent plan.
        studyPlan: { userId },
        OR: [
          { courseId: null },
          { course: { userId } },
        ],
        AND: [
          { OR: [{ examId: null }, { exam: { userId } }] },
          { OR: [{ assignmentId: null }, { assignment: { userId } }] },
          { OR: [{ topicId: null }, { topicRecord: { userId } }] },
        ],
      },
      select: {
        id: true, title: true, date: true, courseId: true, topicId: true, topic: true,
        examId: true, assignmentId: true, activityType: true, durationMinutes: true,
        priority: true, status: true, reason: true,
        course: { select: { courseCode: true, courseName: true } },
      },
      orderBy: [{ status: "asc" }, { priority: "desc" }, { id: "asc" }],
      take: 8,
    }),
    Promise.all([
      db().assignment.findMany({
        where: { userId, status: { not: "COMPLETED" }, course: { userId } },
        select: {
          id: true, title: true, courseId: true, dueDate: true, priority: true,
          course: { select: { courseCode: true } },
        },
        orderBy: [{ dueDate: "asc" }, { priority: "desc" }, { id: "asc" }],
        take: 12,
      }),
      db().exam.findMany({
        where: { userId, examDate: { gte: now }, course: { userId } },
        select: {
          id: true, title: true, courseId: true, examDate: true,
          course: { select: { courseCode: true } },
        },
        orderBy: [{ examDate: "asc" }, { id: "asc" }],
        take: 8,
      }),
    ]),
  ]);

  const context: UserContext | undefined = contextResult.status === "fulfilled" ? contextResult.value : undefined;
  const snapshot = context?.academicOverview;
  const courseLabels = new Map(snapshot?.courses.map((course) => [course.id, `${course.courseCode} ${course.courseName}`]) ?? []);
  const recommendations = recommendationResult.status === "fulfilled"
    ? recommendationResult.value.top.map((item) => recommendation(item, courseLabels))
    : [];
  const nextBestAction = recommendationResult.status === "fulfilled" && recommendationResult.value.next
    ? recommendation(recommendationResult.value.next, courseLabels)
    : null;
  const tasks: DashboardStudyTask[] = taskResult.status === "fulfilled"
    ? taskResult.value.map((item) => ({
        id: item.id,
        title: item.title,
        date: item.date.toISOString().slice(0, 10),
        courseId: item.courseId,
        courseCode: item.course?.courseCode ?? null,
        courseName: item.course?.courseName ?? null,
        topicId: item.topicId,
        topic: item.topic,
        examId: item.examId,
        assignmentId: item.assignmentId,
        activityType: activity(item.activityType),
        durationMinutes: item.durationMinutes,
        priority: item.priority,
        status: taskStatus(item.status),
        reason: item.reason,
      }))
    : [];

  const assignments: DashboardDeadline[] = deadlineResult.status === "fulfilled"
    ? deadlineResult.value[0].map((item) => ({
        id: item.id,
        kind: "assignment" as const,
        title: item.title,
        courseId: item.courseId,
        courseCode: item.course.courseCode,
        date: item.dueDate.toISOString(),
        dateLabel: dateLabel(item.dueDate, today),
        priority: item.priority,
      }))
    : [];
  const exams: DashboardDeadline[] = deadlineResult.status === "fulfilled"
    ? deadlineResult.value[1].map((item) => ({
        id: item.id,
        kind: "exam" as const,
        title: item.title,
        courseId: item.courseId,
        courseCode: item.course.courseCode,
        date: item.examDate.toISOString(),
        dateLabel: dateLabel(item.examDate, today),
        priority: null,
      }))
    : [];
  const upcomingDeadlines = [...assignments, ...exams]
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || Number(b.priority === "HIGH") - Number(a.priority === "HIGH") || a.id.localeCompare(b.id))
    .slice(0, 7);

  const learning = context?.learning;
  const weakSource = dedupeTopics([
    ...(snapshot?.weakestTopics ?? []),
    ...(learning?.recommendedTopics.filter((item) => item.status === "weak" || item.status === "developing" || item.evidence === "limited") ?? []),
  ]).slice(0, 3);
  const allTopics = dedupeTopics([
    ...(learning?.weakTopics ?? []),
    ...(learning?.strongTopics ?? []),
    ...(learning?.recommendedTopics ?? []),
  ]);
  const readiness: DashboardExamReadiness[] = (snapshot?.examReadiness ?? []).slice(0, 3).map((item) => ({
    ...item,
    courseCode: snapshot?.courses.find((course) => course.id === item.courseId)?.courseCode ?? "Course",
  }));
  const courses: DashboardCourse[] = (snapshot?.courses ?? []).slice(0, 6).map((course) => ({
    id: course.id,
    courseCode: course.courseCode,
    courseName: course.courseName,
    attention: course.attention,
    attentionLabel: course.attention === "high" ? "Needs attention" : course.attention === "moderate" ? "Keep an eye on" : "On track",
    nextDeadline: upcomingDeadlines.find((item) => item.courseId === course.id) ?? null,
  }));
  const sectionErrors: StudentDashboard["sectionErrors"] = [];
  if (contextResult.status === "rejected") sectionErrors.push("academic");
  if (deadlineResult.status === "rejected" && !sectionErrors.includes("academic")) sectionErrors.push("academic");
  if (recommendationResult.status === "rejected") sectionErrors.push("recommendations");
  if (taskResult.status === "rejected") sectionErrors.push("study-plan");

  return {
    generatedAt: now.toISOString(),
    greeting: greeting(identity.user.name, identity.timezone, now),
    summary: summary(tasks, upcomingDeadlines, snapshot?.risks.length ?? 0),
    semester: identity.semester,
    timezone: identity.timezone,
    hasCourses: courseCount > 0,
    nextBestAction,
    recommendations: recommendations.filter((item) => item.id !== nextBestAction?.id).slice(0, 3),
    todayTasks: tasks,
    upcomingDeadlines,
    examReadiness: readiness,
    weakTopics: weakSource.map(topic),
    strongTopics: (snapshot?.strongestTopics ?? []).slice(0, 3).map(topic),
    improvingTopics: allTopics.filter((item) => item.trend === "improving").slice(0, 3).map(topic),
    studyPlanProgress: studyProgress(snapshot),
    risks: (snapshot?.risks ?? []).filter((item) => item.level !== "low").slice(0, 3),
    courses,
    sectionErrors,
    assignments,
    exams,
  };
}
