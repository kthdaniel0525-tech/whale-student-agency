import "server-only";
import { auth } from "../auth/config";
import { buildUserContext } from "../context/builder";
import type { UserContext } from "../context/types";
import { db } from "../db/client";
import { listDocuments } from "../documents/service";
import { getLearningTopicStates } from "../learning";
import { getTopRecommendations, type RecommendationRecord } from "../recommendations";
import { NotFoundError } from "../services/academic";
import type {
  CourseCard,
  CoursePlanSummary,
  CourseWorkspace,
  CourseWorkspaceDocument,
  CourseWorkspaceExam,
  CourseWorkspaceNote,
  CourseWorkspaceTopic,
} from "./types";

const DAY = 86_400_000;
const MAX_COURSES = 30;
const MAX_ASSIGNMENTS = 100;
const MAX_EXAMS = 30;
const MAX_DOCUMENTS = 100;
const MAX_NOTES = 12;
const MAX_QUIZZES = 12;

const contextOptions = {
  profile: true,
  assignments: true,
  exams: true,
  learning: true,
  academicOverview: true,
  deadlineWindowDays: 90,
  limits: { assignments: 20, exams: 10, learning: 10, maxCharacters: 40_000 },
} as const;

type Dependencies = {
  buildContext?: typeof buildUserContext;
  loadDocuments?: typeof listDocuments;
  loadLearning?: typeof getLearningTopicStates;
  loadRecommendations?: typeof getTopRecommendations;
};

export class CourseWorkspaceError extends Error {
  readonly code = "UNAUTHENTICATED";
  constructor() {
    super("Sign in to view this course workspace.");
    this.name = "CourseWorkspaceError";
  }
}

async function authorize(userId: string, requestHeaders: Headers) {
  const session = await auth().api.getSession({
    headers: new Headers(requestHeaders),
    query: { disableRefresh: true },
  });
  if (!session?.user.id || session.user.id !== userId) throw new CourseWorkspaceError();
}

const average = (values: readonly number[]) => values.length
  ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  : null;

function documentCategory(title: string, fileName: string): CourseWorkspaceDocument["category"] {
  const value = `${title} ${fileName}`.toLowerCase();
  if (/syllabus|course outline/.test(value)) return "Syllabus";
  if (/lecture|week\s*\d|class\s*\d|slides?/.test(value)) return "Lecture";
  if (/notes?|summary|review sheet/.test(value)) return "Notes";
  if (/reading|chapter|article|textbook/.test(value)) return "Reading";
  return "Other";
}

function confidenceLabel(confidence: number): CourseWorkspaceTopic["confidenceLabel"] {
  return confidence >= 70 ? "High confidence" : confidence >= 40 ? "Moderate confidence" : "Low evidence";
}

function topicState(topic: {
  status: "weak" | "developing" | "good" | "strong" | "unpracticed";
  evidence: "limited" | "sufficient";
}): CourseWorkspaceTopic["stateLabel"] {
  if (topic.evidence === "limited" || topic.status === "unpracticed") return "Needs more evidence";
  return { weak: "Weak", developing: "Developing", good: "Good", strong: "Strong" }[topic.status] ?? "Needs more evidence";
}

function readinessLabel(level: CourseWorkspaceExam["readinessLevel"]) {
  return level === "insufficient-data" ? "Insufficient data"
    : level === "high" ? "Ready"
      : level === "moderate" ? "Developing" : "Needs attention";
}

function actionLabel(type: RecommendationRecord["type"]) {
  return {
    "exam-preparation": "Prepare for exam",
    "assignment-deadline": "Start assignment support",
    "weak-topic": "Start recovery",
    "diagnostic-practice": "Take diagnostic quiz",
    "study-plan": "Update study plan",
    "missed-study-task": "Adjust study plan",
    "course-inactivity": "Review course",
    "lecture-study": "Study lecture",
    "career-preparation": "Continue",
  }[type];
}

function noteFromRow(row: {
  id: string;
  conversationId: string;
  content: string;
  createdAt: Date;
  metadata: unknown;
}): CourseWorkspaceNote {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown> : {};
  let title = "Course notes";
  if (typeof metadata.presentationData === "string" && metadata.presentationData.length <= 24_000) {
    try {
      const value = JSON.parse(metadata.presentationData) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).title === "string")
        title = String((value as Record<string, unknown>).title).slice(0, 200);
    } catch { /* The persisted response text remains usable. */ }
  }
  const documentIds: string[] = [];
  if (typeof metadata.sourceRefs === "string" && metadata.sourceRefs.length <= 20_000) {
    try {
      const sources = JSON.parse(metadata.sourceRefs) as unknown;
      if (Array.isArray(sources)) for (const source of sources) {
        if (source && typeof source === "object" && typeof (source as Record<string, unknown>).documentId === "string")
          documentIds.push(String((source as Record<string, unknown>).documentId));
      }
    } catch { /* Notes can be shown without source chips. */ }
  }
  return {
    id: row.id,
    conversationId: row.conversationId,
    title,
    content: row.content,
    documentIds: [...new Set(documentIds)].slice(0, 8),
    createdAt: row.createdAt.toISOString(),
  };
}

function attentionFor(
  attention: "high" | "moderate" | "low" | undefined,
  hasReliableEvidence: boolean,
): Pick<CourseCard, "attention" | "attentionLabel"> {
  if (attention === "high" || attention === "moderate") return { attention: "needs-attention", attentionLabel: "Needs attention" };
  if (!hasReliableEvidence) return { attention: "low-evidence", attentionLabel: "Low evidence" };
  return { attention: "on-track", attentionLabel: "On track" };
}

export async function getCourseCards(
  userId: string,
  requestHeaders: Headers,
  options: { now?: Date; dependencies?: Dependencies } = {},
): Promise<CourseCard[]> {
  await authorize(userId, requestHeaders);
  const now = options.now ?? new Date();
  const buildContext = options.dependencies?.buildContext ?? buildUserContext;
  const loadLearning = options.dependencies?.loadLearning ?? getLearningTopicStates;
  const [courses, assignments, exams, contextResult, learningResult] = await Promise.all([
    db().course.findMany({
      where: { userId },
      select: { id: true, courseCode: true, courseName: true, professor: true, semester: true },
      orderBy: [{ semester: "desc" }, { courseCode: "asc" }, { id: "asc" }],
      take: MAX_COURSES,
    }),
    db().assignment.findMany({
      where: { userId, status: { not: "COMPLETED" }, course: { userId } },
      select: { courseId: true, title: true, dueDate: true },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: 200,
    }),
    db().exam.findMany({
      where: { userId, examDate: { gte: now }, course: { userId } },
      select: { courseId: true, title: true, examDate: true },
      orderBy: [{ examDate: "asc" }, { id: "asc" }],
      take: 100,
    }),
    Promise.resolve(buildContext({ request: "Prepare deterministic course attention summaries.", options: contextOptions }, requestHeaders))
      .then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    Promise.resolve(loadLearning({ userId, limit: 20, now }))
      .then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
  ]);
  const snapshot = contextResult.ok ? contextResult.value.academicOverview : undefined;
  const learning = learningResult.ok ? learningResult.value : [];
  return courses.map((course) => {
    const academic = snapshot?.courses.find((item) => item.id === course.id);
    const hasReliableEvidence = learning.some((topic) => topic.courseId === course.id && topic.questionsAttempted > 0 && topic.confidence >= 40);
    const attention = attentionFor(academic?.attention, hasReliableEvidence);
    const assignment = assignments.find((item) => item.courseId === course.id);
    const exam = exams.find((item) => item.courseId === course.id);
    return {
      ...course,
      ...attention,
      nextDeadline: assignment ? { title: assignment.title, date: assignment.dueDate.toISOString(), overdue: assignment.dueDate < now } : null,
      nextExam: exam ? { title: exam.title, date: exam.examDate.toISOString(), daysRemaining: Math.max(0, Math.ceil((exam.examDate.getTime() - now.getTime()) / DAY)) } : null,
    };
  });
}

/** Bounded, read-only course aggregation. All intelligence is sourced from the
 * existing Learning, Academic and Recommendation services; no AI provider is used. */
export async function getCourseWorkspace(
  userId: string,
  courseId: string,
  requestHeaders: Headers,
  options: { now?: Date; dependencies?: Dependencies } = {},
): Promise<CourseWorkspace> {
  await authorize(userId, requestHeaders);
  if (!courseId || courseId.length > 100) throw new NotFoundError();
  const now = options.now ?? new Date();
  const dependencies = options.dependencies;
  const course = await db().course.findUnique({
    where: { id_userId: { id: courseId, userId } },
    select: { id: true, courseCode: true, courseName: true, professor: true, semester: true, description: true },
  });
  if (!course) throw new NotFoundError();

  const buildContext = dependencies?.buildContext ?? buildUserContext;
  const loadDocuments = dependencies?.loadDocuments ?? listDocuments;
  const loadLearning = dependencies?.loadLearning ?? getLearningTopicStates;
  const loadRecommendations = dependencies?.loadRecommendations ?? getTopRecommendations;
  const [academicResult, assignmentResult, examResult, documentResult, learningResult, recommendationResult, quizResult, noteResult, planResult] = await Promise.all([
    Promise.resolve(buildContext({ courseId, request: `Prepare deterministic course workspace data for ${course.courseCode}.`, options: contextOptions }, requestHeaders))
      .then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    db().assignment.findMany({
      where: { userId, courseId, course: { userId } },
      select: { id: true, title: true, description: true, dueDate: true, status: true, priority: true, estimatedHours: true },
      orderBy: [{ status: "asc" }, { dueDate: "asc" }, { id: "asc" }],
      take: MAX_ASSIGNMENTS,
    }).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    db().exam.findMany({
      where: { userId, courseId, course: { userId } },
      select: { id: true, title: true, examDate: true, topics: true, notes: true },
      orderBy: [{ examDate: "asc" }, { id: "asc" }],
      take: MAX_EXAMS,
    }).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    Promise.resolve(loadDocuments(userId, courseId))
      .then((value) => ({ ok: true as const, value: value.slice(0, MAX_DOCUMENTS) })).catch(() => ({ ok: false as const })),
    Promise.resolve(loadLearning({ userId, courseId, limit: 20, now }))
      .then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    Promise.resolve(loadRecommendations({ userId, limit: 10, now, refresh: false }))
      .then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    db().quizAttempt.findMany({
      where: { userId, completedAt: { not: null }, quiz: { userId, courseId, course: { userId } } },
      select: {
        id: true, quizId: true, completedAt: true,
        quiz: { select: { title: true, topic: true, difficulty: true } },
        questionAttempts: { select: { score: true }, orderBy: [{ attemptedAt: "asc" }, { id: "asc" }], take: 100 },
      },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      take: MAX_QUIZZES,
    }).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    db().conversationMessage.findMany({
      where: { userId, role: "ASSISTANT", agentId: "notes", conversation: { userId, courseId } },
      select: { id: true, conversationId: true, content: true, metadata: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_NOTES,
    }).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
    db().studyPlan.findFirst({
      where: { userId, status: "ACTIVE", tasks: { some: { userId, courseId } } },
      select: {
        id: true, title: true,
        tasks: {
          where: { userId, courseId },
          select: { id: true, title: true, date: true, durationMinutes: true, status: true },
          orderBy: [{ date: "asc" }, { priority: "desc" }, { id: "asc" }],
          take: 100,
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    }).then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
  ]);

  const context: UserContext | undefined = academicResult.ok ? academicResult.value : undefined;
  const academic = context?.academicOverview;
  const assignments = assignmentResult.ok ? assignmentResult.value.map((item) => ({
    ...item,
    dueDate: item.dueDate.toISOString(),
    overdue: item.status !== "COMPLETED" && item.dueDate < now,
  })) : [];
  const readinessByExam = new Map(academic?.examReadiness.map((item) => [item.examId, item]) ?? []);
  const exams: CourseWorkspaceExam[] = examResult.ok ? examResult.value.map((item) => {
    const readiness = readinessByExam.get(item.id);
    const level = readiness?.readinessLevel ?? "insufficient-data";
    return {
      ...item,
      examDate: item.examDate.toISOString(),
      daysRemaining: Math.max(0, Math.ceil((item.examDate.getTime() - now.getTime()) / DAY)),
      readinessScore: readiness?.readinessScore ?? null,
      readinessLevel: level,
      readinessLabel: readinessLabel(level),
      readinessConfidence: readiness?.confidence ?? 0,
      weakTopics: readiness?.weakTopics ?? [],
      planCompletion: readiness?.planCompletion ?? null,
    };
  }) : [];
  const documents: CourseWorkspaceDocument[] = documentResult.ok ? documentResult.value.map((item) => ({
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    category: documentCategory(item.title, item.originalFileName),
  })) : [];
  const topics: CourseWorkspaceTopic[] = (learningResult.ok ? learningResult.value : []).map((item) => ({
    id: item.id,
    topic: item.topic,
    mastery: Math.round(item.mastery),
    confidence: Math.round(item.confidence),
    confidenceLabel: confidenceLabel(item.confidence),
    recentAccuracy: Math.round(item.recentAccuracy),
    questionsAttempted: item.questionsAttempted,
    trend: item.trend,
    stateLabel: topicState(item),
    needsMoreData: item.evidence === "limited" || item.status === "unpracticed",
  }));
  const weakTopics = topics.filter((item) => !item.needsMoreData && item.mastery < 70)
    .sort((a, b) => a.mastery - b.mastery || b.confidence - a.confidence).slice(0, 6);
  const strongTopics = topics.filter((item) => !item.needsMoreData && item.stateLabel === "Strong")
    .sort((a, b) => b.mastery - a.mastery).slice(0, 6);
  const reliable = topics.filter((item) => !item.needsMoreData && item.questionsAttempted > 0);
  const academicCourse = academic?.courses.find((item) => item.id === courseId);
  const attention = attentionFor(academicCourse?.attention, reliable.length > 0);

  const recommendations = recommendationResult.ok ? recommendationResult.value : [];
  const next = recommendations.find((item) => {
    const payloadCourseId = item.actionPayload && typeof item.actionPayload.courseId === "string" ? item.actionPayload.courseId : null;
    return payloadCourseId === courseId || (item.sourceType === "course" && item.sourceId === courseId);
  }) ?? null;
  const planRow = planResult.ok ? planResult.value : null;
  const planSummary = planRow ? academic?.activeStudyPlans.find((item) => item.id === planRow.id) : undefined;
  const planTasks = planRow?.tasks ?? [];
  const fallbackCompleted = planTasks.filter((item) => item.status === "COMPLETED").length;
  const fallbackRemaining = planTasks.filter((item) => item.status === "PLANNED" || item.status === "IN_PROGRESS").length;
  const studyPlan: CoursePlanSummary = planRow ? {
    id: planRow.id,
    title: planRow.title,
    completedTasks: planSummary?.completedTasks ?? fallbackCompleted,
    remainingTasks: planSummary?.remainingTasks ?? fallbackRemaining,
    skippedTasks: planSummary?.skippedTasks ?? planTasks.filter((item) => item.status === "SKIPPED").length,
    completionPercentage: planSummary?.completionPercentage ?? (fallbackCompleted + fallbackRemaining ? Math.round(100 * fallbackCompleted / (fallbackCompleted + fallbackRemaining)) : null),
    nextTask: (() => {
      const item = planTasks.find((task) => task.status === "PLANNED" || task.status === "IN_PROGRESS");
      return item ? { id: item.id, title: item.title, date: item.date.toISOString(), durationMinutes: item.durationMinutes } : null;
    })(),
  } : null;

  const sectionErrors: CourseWorkspace["sectionErrors"] = [];
  if (!academicResult.ok || !assignmentResult.ok || !examResult.ok) sectionErrors.push("academic");
  if (!documentResult.ok) sectionErrors.push("documents");
  if (!noteResult.ok) sectionErrors.push("notes");
  if (!learningResult.ok) sectionErrors.push("progress");
  if (!quizResult.ok) sectionErrors.push("quizzes");
  if (!planResult.ok) sectionErrors.push("study-plan");
  if (!recommendationResult.ok) sectionErrors.push("recommendation");

  return {
    generatedAt: now.toISOString(),
    course: { ...course, ...attention },
    overview: {
      nextAssignment: assignments.find((item) => item.status !== "COMPLETED") ?? null,
      nextExam: exams.find((item) => new Date(item.examDate) >= now) ?? null,
      averageMastery: average(reliable.map((item) => item.mastery)),
      averageConfidence: average(reliable.map((item) => item.confidence)),
      learningLabel: !reliable.length ? "Low evidence" : weakTopics.length ? "Needs attention" : "On track",
      topWeakTopic: weakTopics[0] ?? topics.find((item) => item.needsMoreData) ?? null,
      latestReadyDocument: documents.find((item) => item.processingStatus === "READY") ?? null,
    },
    nextBestAction: next ? { id: next.id, title: next.title, message: next.message, priority: next.priority, actionLabel: actionLabel(next.type) } : null,
    assignments,
    exams,
    documents,
    notes: noteResult.ok ? noteResult.value.map(noteFromRow) : [],
    topics,
    weakTopics,
    strongTopics,
    improvingTopics: topics.filter((item) => !item.needsMoreData && item.trend === "improving").slice(0, 6),
    recentQuizzes: quizResult.ok ? quizResult.value.map((item) => ({
      id: item.id,
      quizId: item.quizId,
      title: item.quiz.title,
      topic: item.quiz.topic,
      difficulty: item.quiz.difficulty === "EASY" ? "easy" : item.quiz.difficulty === "HARD" ? "hard" : "medium",
      completedAt: item.completedAt!.toISOString(),
      accuracy: average(item.questionAttempts.map((attempt) => attempt.score * 100)) ?? 0,
      answered: item.questionAttempts.length,
    })) : [],
    studyPlan,
    sectionErrors,
  };
}
