import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { auth } from "../auth/config";
import { buildUserContext } from "../context/builder";
import type { UserContext } from "../context/types";
import { db } from "../db/client";
import { getLearningTopicStates } from "../learning";
import { getNextBestAction, type RecommendationRecord } from "../recommendations";
import type {
  ActivePlanProgress,
  ProgressCourse,
  ProgressExamReadiness,
  ProgressRange,
  ProgressRecommendation,
  ProgressTopic,
  QuestionTypeInsight,
  StudentProgress,
  StudyConsistency,
} from "./types";

const DAY = 86_400_000;
const MAX_TOPICS = 20;
const MAX_QUIZZES = 24;
const MAX_QUESTION_EVIDENCE = 400;
const MAX_SNAPSHOTS = 500;
const MIN_QUESTION_TYPE_EVIDENCE = 3;

const contextOptions = {
  profile: true,
  assignments: true,
  exams: true,
  learning: true,
  academicOverview: true,
  deadlineWindowDays: 45,
  limits: {
    assignments: 20,
    exams: 10,
    learning: 10,
    maxCharacters: 40_000,
  },
} as const;

export class ProgressError extends Error {
  readonly code = "UNAUTHENTICATED";
  constructor() {
    super("Sign in to view learning progress.");
    this.name = "ProgressError";
  }
}

type ProgressDependencies = {
  buildContext?: typeof buildUserContext;
  loadLearning?: typeof getLearningTopicStates;
  loadNextAction?: typeof getNextBestAction;
};

type SnapshotRow = {
  topicId: string;
  masteryScore: number;
  confidenceScore: number;
  recordedAt: Date;
};

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

function startOfWeek(now: Date, timezone: string): Date {
  const today = new Date(`${localDate(now, timezone)}T00:00:00.000Z`);
  const mondayOffset = (today.getUTCDay() + 6) % 7;
  return new Date(today.getTime() - mondayOffset * DAY);
}

const roundedAverage = (values: readonly number[]): number | null =>
  values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;

function confidenceLabel(confidence: number): ProgressTopic["confidenceLabel"] {
  if (confidence >= 70) return "High confidence";
  if (confidence >= 40) return "Moderate confidence";
  return "Low evidence";
}

function trendLabel(trend: ProgressTopic["trend"]): string {
  return trend === "insufficient-data"
    ? "Insufficient data"
    : trend[0].toUpperCase() + trend.slice(1);
}

function stateLabel(topic: {
  status: ProgressTopic["status"];
  evidence: "limited" | "sufficient";
}): string {
  if (topic.evidence === "limited" || topic.status === "unpracticed") return "Needs more evidence";
  return {
    weak: "Weak",
    developing: "Developing",
    good: "Good",
    strong: "Strong",
    unpracticed: "Needs more evidence",
  }[topic.status];
}

function actionForTopic(topic: {
  status: ProgressTopic["status"];
  evidence: "limited" | "sufficient";
}): ProgressTopic["recommendedAction"] {
  if (topic.evidence === "limited" || topic.status === "unpracticed") return "diagnostic";
  if (topic.status === "weak") return "review";
  if (topic.status === "developing") return "practice";
  return "maintain";
}

function difficulty(value: string): "easy" | "medium" | "hard" {
  return value === "EASY" ? "easy" : value === "HARD" ? "hard" : "medium";
}

function questionType(value: string): QuestionTypeInsight["type"] {
  return value.toLowerCase().replaceAll("_", "-") as QuestionTypeInsight["type"];
}

function questionTypeLabel(value: QuestionTypeInsight["type"]): string {
  return {
    "multiple-choice": "Multiple choice",
    "true-false": "True / false",
    "short-answer": "Short answer",
    "long-answer": "Long answer",
  }[value];
}

const actionLabels: Record<RecommendationRecord["type"], string> = {
  "exam-preparation": "Prepare for exam",
  "assignment-deadline": "Start assignment support",
  "weak-topic": "Start recovery",
  "diagnostic-practice": "Take diagnostic quiz",
  "study-plan": "Update study plan",
  "missed-study-task": "Adjust study plan",
  "course-inactivity": "Review course",
  "lecture-study": "Study lecture",
  "career-preparation": "Continue career plan",
};

function recommendation(value: RecommendationRecord | null): ProgressRecommendation {
  if (!value) return null;
  return {
    id: value.id,
    title: value.title,
    message: value.message,
    priority: value.priority,
    actionLabel: actionLabels[value.type],
  };
}

/**
 * Read-only, bounded aggregation for the Progress experience. Mastery, topic
 * state, trends and exam readiness are consumed from their domain services;
 * this layer only groups them for presentation. It never initializes AI.
 */
export async function getStudentProgress(
  userId: string,
  requestHeaders: Headers,
  options: {
    now?: Date;
    range?: ProgressRange;
    dependencies?: ProgressDependencies;
  } = {},
): Promise<StudentProgress> {
  const session = await auth().api.getSession({
    headers: new Headers(requestHeaders),
    query: { disableRefresh: true },
  });
  if (!session?.user.id || session.user.id !== userId) throw new ProgressError();

  const now = options.now ?? new Date();
  const range = options.range ?? "semester";
  const buildContext = options.dependencies?.buildContext ?? buildUserContext;
  const loadLearning = options.dependencies?.loadLearning ?? getLearningTopicStates;
  const loadNextAction = options.dependencies?.loadNextAction ?? getNextBestAction;
  const profile = await db().profile.findUnique({
    where: { userId },
    select: { semester: true, timezone: true },
  });
  if (!profile) throw new Error("Progress profile is unavailable.");

  const weekStart = startOfWeek(now, profile.timezone);
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY);
  const rangedAfter = range === "7d"
    ? new Date(now.getTime() - 7 * DAY)
    : range === "30d" ? new Date(now.getTime() - 30 * DAY) : undefined;
  const currentSemesterQuiz: Prisma.QuizWhereInput = {
    OR: [
      { courseId: null },
      { course: { userId, semester: profile.semester } },
    ],
  };
  const snapshotQuery = rangedAfter
    ? Prisma.sql`
        SELECT snapshot."topicId", snapshot."masteryScore", snapshot."confidenceScore", snapshot."recordedAt"
        FROM "LearningProgressSnapshot" AS snapshot
        INNER JOIN "LearningTopic" AS topic ON topic."id" = snapshot."topicId" AND topic."userId" = snapshot."userId"
        INNER JOIN "Course" AS course ON course."id" = topic."courseId" AND course."userId" = snapshot."userId"
        WHERE snapshot."userId" = ${userId} AND course."semester" = ${profile.semester}
          AND snapshot."recordedAt" >= ${rangedAfter}
        ORDER BY snapshot."recordedAt" DESC, snapshot."id" DESC
        LIMIT ${MAX_SNAPSHOTS}
      `
    : Prisma.sql`
        SELECT snapshot."topicId", snapshot."masteryScore", snapshot."confidenceScore", snapshot."recordedAt"
        FROM "LearningProgressSnapshot" AS snapshot
        INNER JOIN "LearningTopic" AS topic ON topic."id" = snapshot."topicId" AND topic."userId" = snapshot."userId"
        INNER JOIN "Course" AS course ON course."id" = topic."courseId" AND course."userId" = snapshot."userId"
        WHERE snapshot."userId" = ${userId} AND course."semester" = ${profile.semester}
        ORDER BY snapshot."recordedAt" DESC, snapshot."id" DESC
        LIMIT ${MAX_SNAPSHOTS}
      `;

  const [courses, contextResult, learningResult, recommendationResult, quizResult, studyResult, snapshotResult] = await Promise.all([
    db().course.findMany({
      where: { userId, semester: profile.semester },
      select: { id: true, courseCode: true, courseName: true },
      orderBy: [{ courseCode: "asc" }, { id: "asc" }],
      take: 30,
    }),
    Promise.resolve(buildContext(
      { request: "Prepare the deterministic student progress summary.", options: contextOptions },
      requestHeaders,
    )).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    Promise.resolve(loadLearning({
      userId,
      semester: profile.semester,
      limit: MAX_TOPICS,
      now,
    })).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    Promise.resolve(loadNextAction(userId, now, { refresh: false }))
      .then((value) => ({ ok: true as const, value }))
      .catch(() => ({ ok: false as const })),
    Promise.all([
      db().quizAttempt.count({
        where: {
          userId,
          completedAt: { not: null, ...(rangedAfter ? { gte: rangedAfter } : {}) },
          quiz: { userId, ...currentSemesterQuiz },
        },
      }),
      db().quizAttempt.findMany({
        where: {
          userId,
          completedAt: { not: null, ...(rangedAfter ? { gte: rangedAfter } : {}) },
          quiz: { userId, ...currentSemesterQuiz },
        },
        select: {
          id: true,
          quizId: true,
          completedAt: true,
          quiz: {
            select: {
              title: true,
              topic: true,
              difficulty: true,
              courseId: true,
              course: { select: { courseCode: true } },
            },
          },
          questionAttempts: {
            select: { score: true },
            orderBy: [{ attemptedAt: "asc" }, { id: "asc" }],
            take: 100,
          },
        },
        orderBy: [{ completedAt: "desc" }, { id: "desc" }],
        take: MAX_QUIZZES,
      }),
      db().questionAttempt.findMany({
        where: {
          userId,
          quizAttempt: {
            userId,
            completedAt: { not: null, ...(rangedAfter ? { gte: rangedAfter } : {}) },
          },
          question: { userId, quiz: { userId, ...currentSemesterQuiz } },
        },
        select: {
          score: true,
          attemptedAt: true,
          quizAttemptId: true,
          question: {
            select: {
              type: true,
              topicMappings: { where: { userId }, select: { topicId: true } },
              quiz: { select: { title: true, difficulty: true } },
            },
          },
        },
        orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
        take: MAX_QUESTION_EVIDENCE,
      }),
    ]).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    Promise.all([
      db().studyTask.findMany({
        where: {
          userId,
          date: { gte: weekStart, lt: weekEnd },
          studyPlan: { userId },
          OR: [{ courseId: null }, { course: { userId } }],
        },
        select: { date: true, durationMinutes: true, status: true },
        orderBy: [{ date: "asc" }, { id: "asc" }],
        take: 200,
      }),
      db().studyPlan.findMany({
        where: { userId, status: "ACTIVE" },
        select: { id: true, title: true, endDate: true },
        orderBy: [{ endDate: "asc" }, { id: "asc" }],
        take: 10,
      }),
    ]).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    db().$queryRaw<SnapshotRow[]>(snapshotQuery)
      .then((value) => ({ ok: true as const, value }))
      .catch(() => ({ ok: false as const })),
  ]);

  const context: UserContext | undefined = contextResult.ok ? contextResult.value : undefined;
  const snapshot = context?.academicOverview;
  const learningStates = learningResult.ok ? learningResult.value : [];
  const snapshotsByTopic = new Map<string, Array<{ date: string; mastery: number; confidence: number }>>();
  if (snapshotResult.ok) {
    for (const point of [...snapshotResult.value].reverse()) {
      const values = snapshotsByTopic.get(point.topicId) ?? [];
      values.push({
        date: point.recordedAt.toISOString(),
        mastery: Math.round(point.masteryScore),
        confidence: Math.round(point.confidenceScore),
      });
      snapshotsByTopic.set(point.topicId, values.slice(-12));
    }
  }

  const topicQuizGroups = new Map<string, Map<string, {
    date: Date;
    title: string;
    difficulty: "easy" | "medium" | "hard";
    scores: number[];
  }>>();
  const quizAttempts = quizResult.ok ? quizResult.value[2] : [];
  for (const attempt of quizAttempts) {
    for (const mapping of attempt.question.topicMappings) {
      const groups = topicQuizGroups.get(mapping.topicId) ?? new Map();
      const group = groups.get(attempt.quizAttemptId) ?? {
        date: attempt.attemptedAt,
        title: attempt.question.quiz.title,
        difficulty: difficulty(attempt.question.quiz.difficulty),
        scores: [],
      };
      group.scores.push(attempt.score);
      groups.set(attempt.quizAttemptId, group);
      topicQuizGroups.set(mapping.topicId, groups);
    }
  }

  const topics: ProgressTopic[] = learningStates.map((topic) => {
    const evidence = topic.evidence;
    const quizGroups = [...(topicQuizGroups.get(topic.id)?.values() ?? [])]
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 5);
    return {
      id: topic.id,
      topic: topic.topic,
      courseId: topic.courseId,
      courseCode: topic.courseCode,
      courseName: topic.courseName,
      mastery: Math.round(topic.mastery),
      confidence: Math.round(topic.confidence),
      confidenceLabel: confidenceLabel(topic.confidence),
      recentAccuracy: Math.round(topic.recentAccuracy),
      questionsAttempted: topic.questionsAttempted,
      practiceSessions: topic.practiceSessions,
      trend: topic.trend,
      trendLabel: trendLabel(topic.trend),
      lastPracticedAt: topic.lastPracticedAt,
      status: topic.status,
      stateLabel: stateLabel(topic),
      needsMoreData: evidence === "limited" || topic.status === "unpracticed",
      history: snapshotsByTopic.get(topic.id) ?? [],
      recentQuizzes: quizGroups.map((item) => ({
        date: item.date.toISOString(),
        title: item.title,
        difficulty: item.difficulty,
        accuracy: roundedAverage(item.scores.map((score) => score * 100)) ?? 0,
      })),
      recommendedAction: actionForTopic(topic),
    };
  });

  const topicPriority = (topic: ProgressTopic) =>
    Number(topic.trend === "declining") * 30 + (100 - topic.mastery) + (100 - topic.recentAccuracy) / 4;
  const weakTopics = topics
    .filter((topic) => !topic.needsMoreData && ["weak", "developing"].includes(topic.status))
    .sort((a, b) => topicPriority(b) - topicPriority(a) || a.topic.localeCompare(b.topic))
    .slice(0, 6);
  const strongTopics = topics
    .filter((topic) => !topic.needsMoreData && topic.status === "strong")
    .sort((a, b) => b.mastery - a.mastery || b.confidence - a.confidence)
    .slice(0, 6);
  const lowEvidenceTopics = topics
    .filter((topic) => topic.needsMoreData)
    .sort((a, b) => b.questionsAttempted - a.questionsAttempted || a.topic.localeCompare(b.topic))
    .slice(0, 6);

  const attentionByCourse = new Map(snapshot?.courses.map((course) => [course.id, course]) ?? []);
  const progressCourses: ProgressCourse[] = courses.map((course) => {
    const relevant = topics.filter((topic) => topic.courseId === course.id && topic.questionsAttempted > 0);
    const reliable = relevant.filter((topic) => !topic.needsMoreData);
    const attention = attentionByCourse.get(course.id);
    const strongest = [...reliable].sort((a, b) => b.mastery - a.mastery)[0];
    const weakest = [...reliable].sort((a, b) => a.mastery - b.mastery)[0];
    return {
      ...course,
      attention: attention?.attention ?? "low",
      attentionLabel: attention?.attention === "high"
        ? "Needs attention"
        : attention?.attention === "moderate" ? "Keep an eye on" : "On track",
      averageMastery: roundedAverage(relevant.map((topic) => topic.mastery)),
      averageConfidence: roundedAverage(relevant.map((topic) => topic.confidence)),
      trackedTopics: relevant.length,
      strongTopic: strongest?.status === "strong" ? strongest.topic : null,
      needsAttentionTopic: weakest && ["weak", "developing"].includes(weakest.status) ? weakest.topic : null,
    };
  }).sort((a, b) => {
    const weight = { high: 2, moderate: 1, low: 0 };
    return weight[b.attention] - weight[a.attention] || a.courseCode.localeCompare(b.courseCode);
  });

  const completedQuizCount = quizResult.ok ? quizResult.value[0] : 0;
  const quizHistory = quizResult.ok ? quizResult.value[1].map((attempt) => ({
    id: attempt.id,
    quizId: attempt.quizId,
    title: attempt.quiz.title,
    courseId: attempt.quiz.courseId,
    courseCode: attempt.quiz.course?.courseCode ?? null,
    topic: attempt.quiz.topic,
    difficulty: difficulty(attempt.quiz.difficulty),
    completedAt: attempt.completedAt!.toISOString(),
    accuracy: roundedAverage(attempt.questionAttempts.map((item) => item.score * 100)) ?? 0,
    answered: attempt.questionAttempts.length,
  })) : [];
  const questionTypeGroups = new Map<QuestionTypeInsight["type"], number[]>();
  for (const attempt of quizAttempts) {
    const type = questionType(attempt.question.type);
    const values = questionTypeGroups.get(type) ?? [];
    values.push(attempt.score * 100);
    questionTypeGroups.set(type, values);
  }
  const questionTypes: QuestionTypeInsight[] = [...questionTypeGroups].flatMap(([type, scores]) =>
    scores.length >= MIN_QUESTION_TYPE_EVIDENCE
      ? [{ type, label: questionTypeLabel(type), accuracy: roundedAverage(scores)!, attempts: scores.length }]
      : [],
  ).sort((a, b) => b.attempts - a.attempts || a.type.localeCompare(b.type));

  const studyTasks = studyResult.ok ? studyResult.value[0] : [];
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days = dayLabels.map((label, index) => {
    const date = new Date(weekStart.getTime() + index * DAY);
    const key = date.toISOString().slice(0, 10);
    const relevant = studyTasks.filter((task) => task.date.toISOString().slice(0, 10) === key);
    return {
      date: key,
      label,
      plannedMinutes: relevant.reduce((sum, task) => sum + task.durationMinutes, 0),
      completedMinutes: relevant.filter((task) => task.status === "COMPLETED").reduce((sum, task) => sum + task.durationMinutes, 0),
      completedTasks: relevant.filter((task) => task.status === "COMPLETED").length,
      skippedTasks: relevant.filter((task) => task.status === "SKIPPED").length,
    };
  });
  const completedTasks = studyTasks.filter((task) => task.status === "COMPLETED");
  const skippedTasks = studyTasks.filter((task) => task.status === "SKIPPED");
  const considered = studyTasks.filter((task) => task.status !== "PLANNED" && task.status !== "IN_PROGRESS");
  const skippedAverage = roundedAverage(skippedTasks.map((task) => task.durationMinutes));
  const completedAverage = roundedAverage(completedTasks.map((task) => task.durationMinutes));
  const studyConsistency: StudyConsistency = {
    plannedMinutes: studyTasks.reduce((sum, task) => sum + task.durationMinutes, 0),
    completedMinutes: completedTasks.reduce((sum, task) => sum + task.durationMinutes, 0),
    completedTasks: completedTasks.length,
    skippedTasks: skippedTasks.length,
    completionRate: considered.length ? Math.round(completedTasks.length / considered.length * 100) : null,
    days,
    insight: skippedTasks.length >= 2 && skippedAverage !== null && completedAverage !== null && skippedAverage >= completedAverage + 15
      ? "Longer planned sessions were skipped more often this week. Consider shorter sessions when adjusting the plan."
      : null,
  };

  const planSummaryById = new Map(snapshot?.activeStudyPlans.map((plan) => [plan.id, plan]) ?? []);
  const activePlans: ActivePlanProgress[] = (studyResult.ok ? studyResult.value[1] : []).map((plan) => {
    const summary = planSummaryById.get(plan.id);
    return {
      id: plan.id,
      title: plan.title,
      endDate: plan.endDate.toISOString(),
      daysRemaining: Math.max(0, Math.ceil((plan.endDate.getTime() - now.getTime()) / DAY)),
      completedTasks: summary?.completedTasks ?? 0,
      remainingTasks: summary?.remainingTasks ?? 0,
      skippedTasks: summary?.skippedTasks ?? 0,
      completionPercentage: summary?.completionPercentage ?? null,
    };
  });

  const examReadiness: ProgressExamReadiness[] = (snapshot?.examReadiness ?? []).slice(0, 6).map((exam) => ({
    ...exam,
    courseCode: courses.find((course) => course.id === exam.courseId)?.courseCode ?? "Course",
    readinessLabel: exam.readinessLevel === "insufficient-data"
      ? "Insufficient data"
      : exam.readinessLevel === "high" ? "Ready" : exam.readinessLevel === "moderate" ? "Developing" : "Needs attention",
  }));

  const tracked = topics.filter((topic) => topic.questionsAttempted > 0);
  const sectionErrors: StudentProgress["sectionErrors"] = [];
  if (!contextResult.ok) sectionErrors.push("academic");
  if (!learningResult.ok || !snapshotResult.ok) sectionErrors.push("learning");
  if (!quizResult.ok) sectionErrors.push("quiz");
  if (!studyResult.ok) sectionErrors.push("study");
  if (!recommendationResult.ok) sectionErrors.push("recommendation");

  return {
    generatedAt: now.toISOString(),
    range,
    semester: profile.semester,
    hasCourses: courses.length > 0,
    hasLearningData: tracked.length > 0,
    overview: {
      activeCourses: courses.length,
      topicsTracked: tracked.length,
      averageMastery: roundedAverage(tracked.map((topic) => topic.mastery)),
      completedStudyTasksThisWeek: studyConsistency.completedTasks,
      upcomingExams: snapshot?.examsNext14Days ?? 0,
      highestPriorityTopic: weakTopics[0]?.topic ?? lowEvidenceTopics[0]?.topic ?? null,
    },
    courses: progressCourses,
    topics,
    weakTopics,
    strongTopics,
    improvingTopics: topics.filter((topic) => topic.trend === "improving" && !topic.needsMoreData).slice(0, 6),
    decliningTopics: topics.filter((topic) => topic.trend === "declining" && !topic.needsMoreData).slice(0, 6),
    lowEvidenceTopics,
    quizSummary: {
      completed: completedQuizCount,
      recentAccuracy: roundedAverage(quizAttempts.map((item) => item.score * 100)),
      history: quizHistory,
      questionTypes,
      strongestTopic: strongTopics[0]?.topic ?? null,
      weakestTopic: weakTopics[0]?.topic ?? null,
    },
    studyConsistency,
    activePlans,
    examReadiness,
    nextBestAction: recommendation(recommendationResult.ok ? recommendationResult.value : null),
    sectionErrors,
  };
}
