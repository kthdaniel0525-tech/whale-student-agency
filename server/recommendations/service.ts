import "server-only";
import { auth } from "../auth/config";
import { STUDENT_AGENT_IDS } from "../agents/types";
import { db } from "../db/client";
import { WORKFLOW_IDS } from "../workflows/types";
import { RECOMMENDATION_CONFIG } from "./config";
import { detectRecommendationCandidates, rankRecommendationCandidates } from "./detection";
import type {
  RecommendationAction,
  RecommendationActionPayload,
  RecommendationAgentId,
  RecommendationCandidate,
  RecommendationDetectionInput,
  RecommendationEvaluationResult,
  RecommendationRecord,
  RecommendationSourceType,
  RecommendationType,
} from "./types";

const DAY = 86_400_000;
const allowedAgents = new Set<RecommendationAgentId>([
  "tutor", "quiz", "study-planner", "academic-manager", "career",
]);

const typeToDatabase = {
  "exam-preparation": "EXAM_PREPARATION",
  "assignment-deadline": "ASSIGNMENT_DEADLINE",
  "weak-topic": "WEAK_TOPIC",
  "diagnostic-practice": "DIAGNOSTIC_PRACTICE",
  "study-plan": "STUDY_PLAN",
  "missed-study-task": "MISSED_STUDY_TASK",
  "course-inactivity": "COURSE_INACTIVITY",
  "lecture-study": "LECTURE_STUDY",
  "career-preparation": "CAREER_PREPARATION",
} as const;
const typeFromDatabase = Object.fromEntries(
  Object.entries(typeToDatabase).map(([key, value]) => [value, key]),
) as Record<(typeof typeToDatabase)[RecommendationType], RecommendationType>;
const priorityToDatabase = {
  low: "LOW", medium: "MEDIUM", high: "HIGH", critical: "CRITICAL",
} as const;
const priorityFromDatabase = {
  LOW: "low", MEDIUM: "medium", HIGH: "high", CRITICAL: "critical",
} as const;
const statusFromDatabase = {
  ACTIVE: "active", COMPLETED: "completed", DISMISSED: "dismissed", EXPIRED: "expired",
} as const;
const sourceToDatabase = {
  exam: "EXAM",
  assignment: "ASSIGNMENT",
  "learning-topic": "LEARNING_TOPIC",
  "study-plan": "STUDY_PLAN",
  "study-task": "STUDY_TASK",
  course: "COURSE",
  document: "DOCUMENT",
  "career-plan": "CAREER_PLAN",
} as const;
const sourceFromDatabase = Object.fromEntries(
  Object.entries(sourceToDatabase).map(([key, value]) => [value, key]),
) as Record<(typeof sourceToDatabase)[RecommendationSourceType], RecommendationSourceType>;

export type RecommendationErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "INVALID_TARGET"
  | "STORAGE_FAILURE";

export class RecommendationError extends Error {
  constructor(readonly code: RecommendationErrorCode) {
    super({
      INVALID_REQUEST: "Check the recommendation request.",
      UNAUTHENTICATED: "Sign in to access recommendations.",
      NOT_FOUND: "This recommendation is no longer available.",
      INVALID_TARGET: "The recommended action is no longer valid.",
      STORAGE_FAILURE: "Recommendations could not be loaded or updated.",
    }[code]);
    this.name = "RecommendationError";
  }
}

type RecommendationRow = NonNullable<Awaited<ReturnType<ReturnType<typeof db>["recommendation"]["findFirst"]>>>;

function jsonObject(value: unknown): RecommendationActionPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || ["string", "number", "boolean"].includes(typeof item)) {
      result[key] = item as string | number | boolean | null;
    }
  }
  return result;
}

function publicRecommendation(row: RecommendationRow): RecommendationRecord {
  return {
    id: row.id,
    type: typeFromDatabase[row.type],
    title: row.title,
    message: row.message,
    priority: priorityFromDatabase[row.priority],
    priorityScore: row.priorityScore,
    status: statusFromDatabase[row.status],
    sourceType: sourceFromDatabase[row.sourceType],
    sourceId: row.sourceId,
    recommendedAgentId: row.recommendedAgentId && allowedAgents.has(row.recommendedAgentId as RecommendationAgentId)
      ? row.recommendedAgentId as RecommendationAgentId : null,
    recommendedWorkflowId: row.recommendedWorkflowId && WORKFLOW_IDS.includes(row.recommendedWorkflowId as typeof WORKFLOW_IDS[number])
      ? row.recommendedWorkflowId as typeof WORKFLOW_IDS[number] : null,
    actionPayload: jsonObject(row.actionPayload),
    reasonCode: row.reasonCode,
    reasonData: jsonObject(row.reasonData) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function validCandidateTarget(candidate: RecommendationCandidate): boolean {
  const targetCount = Number(Boolean(candidate.recommendedAgentId)) + Number(Boolean(candidate.recommendedWorkflowId));
  return targetCount === 1 &&
    (!candidate.recommendedAgentId ||
      (STUDENT_AGENT_IDS.includes(candidate.recommendedAgentId) && allowedAgents.has(candidate.recommendedAgentId))) &&
    (!candidate.recommendedWorkflowId || WORKFLOW_IDS.includes(candidate.recommendedWorkflowId));
}

function collectDocumentIds(value: unknown, result: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const object = value as Record<string, unknown>;
  if (typeof object.documentId === "string") result.add(object.documentId);
  if (Array.isArray(object.documentIds)) {
    for (const id of object.documentIds) if (typeof id === "string") result.add(id);
  }
}

function collectActionSourceKeys(value: unknown, result: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const object = value as Record<string, unknown>;
  for (const [field, prefix] of [
    ["examId", "exam"],
    ["assignmentId", "assignment"],
    ["topicId", "topic"],
    ["documentId", "document"],
  ] as const) {
    if (typeof object[field] === "string") result.add(`${prefix}:${object[field]}`);
  }
  if (Array.isArray(object.documentIds)) {
    for (const id of object.documentIds) if (typeof id === "string") result.add(`document:${id}`);
  }
}

async function loadDetectionInput(userId: string, now: Date): Promise<RecommendationDetectionInput> {
  const user = await db().user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new RecommendationError("NOT_FOUND");
  const [profile, courses, exams, assignments, topicRows, studyPlans, documents, lectureRuns, activeRuns, completedLectures, careerPlans, outcomes] = await Promise.all([
    db().profile.findUnique({ where: { userId }, select: { studySessionMinutes: true } }),
    db().course.findMany({ where: { userId }, select: { id: true, courseCode: true, courseName: true } }),
    db().exam.findMany({
      where: { userId, examDate: { gte: new Date(now.getTime() - DAY) } },
      select: { id: true, courseId: true, title: true, examDate: true, topics: true, course: { select: { courseCode: true } } },
      orderBy: { examDate: "asc" }, take: 30,
    }),
    db().assignment.findMany({
      where: { userId, status: { not: "COMPLETED" } },
      select: { id: true, courseId: true, title: true, dueDate: true, status: true, priority: true, estimatedHours: true, course: { select: { courseCode: true } } },
      orderBy: { dueDate: "asc" }, take: 60,
    }),
    db().learningTopic.findMany({
      where: { userId, progress: { isNot: null } },
      select: { id: true, courseId: true, name: true, normalizedName: true, course: { select: { courseCode: true } }, progress: { select: {
        masteryScore: true, confidenceScore: true, recentAccuracy: true, trend: true,
        questionsAttempted: true, lastPracticedAt: true,
      } } },
      take: 100,
    }),
    db().studyPlan.findMany({
      where: { userId, status: "ACTIVE" },
      select: { id: true, title: true, endDate: true, status: true, tasks: { where: { userId }, select: { status: true, date: true, updatedAt: true, courseId: true, examId: true } } },
      take: 20,
    }),
    db().document.findMany({
      where: { userId, processingStatus: "READY", createdAt: { gte: new Date(now.getTime() - RECOMMENDATION_CONFIG.lectureFreshnessDays * DAY) } },
      select: { id: true, courseId: true, title: true, createdAt: true, course: { select: { courseCode: true } } },
      orderBy: { createdAt: "desc" }, take: 20,
    }),
    db().workflowRun.findMany({
      where: { userId, workflowId: "lecture-study", status: "COMPLETED" },
      select: { input: true, context: true }, orderBy: { completedAt: "desc" }, take: 50,
    }),
    db().workflowRun.findMany({
      where: { userId, status: { in: ["PENDING", "RUNNING", "WAITING_FOR_INPUT"] } },
      select: { input: true, context: true }, orderBy: { updatedAt: "desc" }, take: 30,
    }),
    db().recommendation.findMany({
      where: { userId, type: "LECTURE_STUDY", status: "COMPLETED", sourceId: { not: null } },
      select: { sourceId: true }, take: 100,
    }),
    db().careerPlan.findMany({
      where: { userId, status: "ACTIVE" },
      select: { id: true, targetRole: true, targetDate: true, status: true, tasks: {
        where: { userId, status: { in: ["PLANNED", "IN_PROGRESS"] } },
        select: { id: true, title: true, priority: true, targetDate: true },
        orderBy: [{ priority: "desc" }, { targetDate: "asc" }, { id: "asc" }], take: 1,
      } }, take: 10,
    }),
    db().adaptiveOutcome.findMany({
      where: { userId, agentId: "quiz", outcomeType: "quiz-performance", successful: false, createdAt: { gte: new Date(now.getTime() - 60 * DAY) } },
      select: { topicId: true }, take: 200,
    }),
  ]);
  const failures = new Map<string, number>();
  for (const outcome of outcomes) if (outcome.topicId) failures.set(outcome.topicId, (failures.get(outcome.topicId) ?? 0) + 1);
  const topicActivity = new Map<string, Date>();
  for (const topic of topicRows) {
    const practiced = topic.progress?.lastPracticedAt;
    if (practiced && (!topicActivity.get(topic.courseId) || practiced > topicActivity.get(topic.courseId)!)) topicActivity.set(topic.courseId, practiced);
  }
  for (const plan of studyPlans) for (const task of plan.tasks) {
    if (task.status !== "COMPLETED" || !task.courseId) continue;
    if (!topicActivity.get(task.courseId) || task.updatedAt > topicActivity.get(task.courseId)!) topicActivity.set(task.courseId, task.updatedAt);
  }
  const studiedDocumentIds = new Set<string>();
  for (const run of lectureRuns) {
    collectDocumentIds(run.input, studiedDocumentIds);
    collectDocumentIds(run.context, studiedDocumentIds);
  }
  for (const recommendation of completedLectures) if (recommendation.sourceId) studiedDocumentIds.add(recommendation.sourceId);
  const activeWorkflowSourceKeys = new Set<string>();
  for (const run of activeRuns) {
    collectActionSourceKeys(run.input, activeWorkflowSourceKeys);
    collectActionSourceKeys(run.context, activeWorkflowSourceKeys);
  }
  const examPlans = new Map<string, { studyPlanId: string; total: number; completed: number }>();
  for (const plan of studyPlans) for (const task of plan.tasks) {
    if (!task.examId || task.status === "SKIPPED") continue;
    const current = examPlans.get(task.examId) ?? { studyPlanId: plan.id, total: 0, completed: 0 };
    current.total++;
    if (task.status === "COMPLETED") current.completed++;
    examPlans.set(task.examId, current);
  }
  return {
    now,
    preferences: { studySessionMinutes: profile?.studySessionMinutes ?? 45 },
    courses: courses.map((course) => ({ ...course, lastActivityAt: topicActivity.get(course.id) ?? null })),
    exams: exams.map((exam) => {
      const plan = examPlans.get(exam.id);
      return {
        ...exam,
        courseCode: exam.course.courseCode,
        studyPlanId: plan?.studyPlanId ?? null,
        planCompletion: plan?.total ? Math.round(plan.completed / plan.total * 100) : null,
      };
    }),
    assignments: assignments.map((assignment) => ({ ...assignment, courseCode: assignment.course.courseCode })),
    topics: topicRows.flatMap((topic) => topic.progress ? [{
      id: topic.id, courseId: topic.courseId, courseCode: topic.course.courseCode,
      name: topic.name, normalizedName: topic.normalizedName,
      mastery: topic.progress.masteryScore, confidence: topic.progress.confidenceScore,
      recentAccuracy: topic.progress.recentAccuracy, trend: topic.progress.trend,
      questionsAttempted: topic.progress.questionsAttempted,
      lastPracticedAt: topic.progress.lastPracticedAt,
      recentFailures: failures.get(topic.id) ?? 0,
    }] : []),
    studyPlans: studyPlans.map((plan) => ({
      id: plan.id, title: plan.title, endDate: plan.endDate, status: plan.status,
      missedTasks: plan.tasks.filter((task) => task.status === "SKIPPED" ||
        ((task.status === "PLANNED" || task.status === "IN_PROGRESS") && task.date < now)).length,
      remainingTasks: plan.tasks.filter((task) => task.status === "PLANNED" || task.status === "IN_PROGRESS").length,
    })),
    documents: documents.map((document) => ({
      id: document.id, courseId: document.courseId, title: document.title, createdAt: document.createdAt,
      courseCode: document.course?.courseCode ?? null,
    })),
    studiedDocumentIds,
    activeWorkflowSourceKeys,
    careerPlans: careerPlans.map((plan) => ({
      id: plan.id, targetRole: plan.targetRole, targetDate: plan.targetDate, status: plan.status,
      nextTask: plan.tasks[0] ?? null,
    })),
  };
}

function candidateData(userId: string, candidate: ReturnType<typeof rankRecommendationCandidates>[number]) {
  return {
    type: typeToDatabase[candidate.type],
    title: candidate.title,
    message: candidate.message,
    priority: priorityToDatabase[candidate.priority],
    priorityScore: candidate.priorityScore,
    sourceType: sourceToDatabase[candidate.sourceType],
    sourceId: candidate.sourceId,
    recommendedAgentId: candidate.recommendedAgentId,
    recommendedWorkflowId: candidate.recommendedWorkflowId,
    actionPayload: candidate.actionPayload,
    reasonCode: candidate.reasonCode,
    reasonData: candidate.reasonData,
    dedupeKey: candidate.dedupeKey,
    supersessionKey: candidate.supersessionKey,
    stateFingerprint: candidate.stateFingerprint,
    activeKey: `${userId}:${candidate.dedupeKey}`,
    expiresAt: candidate.expiresAt,
  };
}

export async function evaluateRecommendations(
  userId: string,
  options: { now?: Date } = {},
): Promise<RecommendationEvaluationResult> {
  if (!userId || userId.length > 100) throw new RecommendationError("INVALID_REQUEST");
  const now = options.now ?? new Date();
  try {
    const input = await loadDetectionInput(userId, now);
    const ranked = rankRecommendationCandidates(detectRecommendationCandidates(input))
      .filter(validCandidateTarget)
      .slice(0, RECOMMENDATION_CONFIG.maximumActiveRecommendations);
    let created = 0, updated = 0, expired = 0, suppressed = 0;
    await db().$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
      const active = await transaction.recommendation.findMany({ where: { userId, status: "ACTIVE" } });
      const selected = new Set(ranked.map((candidate) => candidate.dedupeKey));
      for (const row of active) {
        if (!selected.has(row.dedupeKey) || (row.expiresAt && row.expiresAt <= now)) {
          await transaction.recommendation.update({ where: { id: row.id }, data: { status: "EXPIRED", activeKey: null } });
          expired++;
        }
      }
      const history = await transaction.recommendation.findMany({
        where: {
          userId,
          status: { in: ["DISMISSED", "COMPLETED"] },
          dedupeKey: { in: ranked.map((candidate) => candidate.dedupeKey) },
          updatedAt: { gte: new Date(now.getTime() - RECOMMENDATION_CONFIG.completedSuppressionDays * DAY) },
        },
        orderBy: { updatedAt: "desc" },
      });
      for (const candidate of ranked) {
        const existing = await transaction.recommendation.findFirst({
          where: { userId, status: "ACTIVE", dedupeKey: candidate.dedupeKey },
        });
        if (existing) {
          await transaction.recommendation.update({ where: { id: existing.id }, data: candidateData(userId, candidate) });
          updated++;
          continue;
        }
        const prior = history.find((row) => row.dedupeKey === candidate.dedupeKey && row.stateFingerprint === candidate.stateFingerprint);
        const suppressionDays = prior?.status === "DISMISSED"
          ? RECOMMENDATION_CONFIG.dismissalSuppressionDays
          : RECOMMENDATION_CONFIG.completedSuppressionDays;
        if (prior && now.getTime() - prior.updatedAt.getTime() < suppressionDays * DAY) {
          suppressed++;
          continue;
        }
        const superseded = await transaction.recommendation.updateMany({
          where: { userId, status: "ACTIVE", supersessionKey: candidate.supersessionKey },
          data: { status: "EXPIRED", activeKey: null },
        });
        expired += superseded.count;
        await transaction.recommendation.create({
          data: { userId, ...candidateData(userId, candidate) },
        });
        created++;
      }
    });
    const rows = await db().recommendation.findMany({
      where: { userId, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: [{ priorityScore: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
      take: RECOMMENDATION_CONFIG.maximumActiveRecommendations,
    });
    return { recommendations: rows.map(publicRecommendation), created, updated, expired, suppressed };
  } catch (error) {
    if (error instanceof RecommendationError) throw error;
    throw new RecommendationError("STORAGE_FAILURE");
  }
}

export async function getTopRecommendations(input: {
  userId: string;
  limit?: number;
  now?: Date;
  refresh?: boolean;
}): Promise<RecommendationRecord[]> {
  const limit = input.limit ?? RECOMMENDATION_CONFIG.defaultTopLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > RECOMMENDATION_CONFIG.maximumTopLimit)
    throw new RecommendationError("INVALID_REQUEST");
  if (input.refresh !== false) await evaluateRecommendations(input.userId, { ...(input.now ? { now: input.now } : {}) });
  const now = input.now ?? new Date();
  const rows = await db().recommendation.findMany({
    where: { userId: input.userId, status: "ACTIVE", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: [{ priorityScore: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
    take: limit,
  });
  return rows.map(publicRecommendation);
}

export async function getNextBestAction(
  userId: string,
  now?: Date,
  options: { refresh?: boolean } = {},
): Promise<RecommendationRecord | null> {
  return (await getTopRecommendations({
    userId,
    limit: 1,
    ...(now ? { now } : {}),
    ...(options.refresh !== undefined ? { refresh: options.refresh } : {}),
  }))[0] ?? null;
}

async function ownedRecommendation(userId: string, id: string) {
  if (!id || id.length > 100) throw new RecommendationError("INVALID_REQUEST");
  const row = await db().recommendation.findFirst({ where: { id, userId } });
  if (!row) throw new RecommendationError("NOT_FOUND");
  return row;
}

export async function dismissRecommendation(userId: string, id: string, now = new Date()): Promise<RecommendationRecord> {
  const row = await ownedRecommendation(userId, id);
  if (row.status !== "ACTIVE") throw new RecommendationError("NOT_FOUND");
  return publicRecommendation(await db().recommendation.update({
    where: { id: row.id }, data: { status: "DISMISSED", dismissedAt: now, activeKey: null },
  }));
}

export async function completeRecommendation(userId: string, id: string, now = new Date()): Promise<RecommendationRecord> {
  const row = await ownedRecommendation(userId, id);
  if (row.status !== "ACTIVE") throw new RecommendationError("NOT_FOUND");
  return publicRecommendation(await db().recommendation.update({
    where: { id: row.id }, data: { status: "COMPLETED", completedAt: now, activeKey: null },
  }));
}

async function referenceExists(userId: string, kind: string, id: string): Promise<boolean> {
  if (kind === "courseId") return Boolean(await db().course.findUnique({ where: { id_userId: { id, userId } }, select: { id: true } }));
  if (kind === "examId") return Boolean(await db().exam.findFirst({ where: { id, userId }, select: { id: true } }));
  if (kind === "assignmentId") return Boolean(await db().assignment.findFirst({ where: { id, userId }, select: { id: true } }));
  if (kind === "topicId") return Boolean(await db().learningTopic.findFirst({ where: { id, userId }, select: { id: true } }));
  if (kind === "studyPlanId") return Boolean(await db().studyPlan.findFirst({ where: { id, userId }, select: { id: true } }));
  if (kind === "studyTaskId") return Boolean(await db().studyTask.findFirst({ where: { id, userId }, select: { id: true } }));
  if (kind === "documentId") return Boolean(await db().document.findFirst({ where: { id, userId }, select: { id: true } }));
  if (kind === "careerPlanId") return Boolean(await db().careerPlan.findFirst({ where: { id, userId }, select: { id: true } }));
  if (kind === "careerTaskId") return Boolean(await db().careerTask.findFirst({ where: { id, userId }, select: { id: true } }));
  return true;
}

/** Returns a validated launch descriptor. Execution remains an explicit user action. */
export async function startRecommendedAction(userId: string, id: string): Promise<RecommendationAction> {
  const row = await ownedRecommendation(userId, id);
  if (row.status !== "ACTIVE") throw new RecommendationError("NOT_FOUND");
  const payload = jsonObject(row.actionPayload) ?? {};
  const sourceKind = {
    EXAM: "examId",
    ASSIGNMENT: "assignmentId",
    LEARNING_TOPIC: "topicId",
    STUDY_PLAN: "studyPlanId",
    STUDY_TASK: "studyTaskId",
    COURSE: "courseId",
    DOCUMENT: "documentId",
    CAREER_PLAN: "careerPlanId",
  }[row.sourceType];
  if (row.sourceId && !(await referenceExists(userId, sourceKind, row.sourceId)))
    throw new RecommendationError("INVALID_TARGET");
  const references = Object.entries(payload).filter(([key, value]) => key.endsWith("Id") && typeof value === "string") as [string, string][];
  if (!(await Promise.all(references.map(([kind, value]) => referenceExists(userId, kind, value)))).every(Boolean))
    throw new RecommendationError("INVALID_TARGET");
  if (row.recommendedWorkflowId && WORKFLOW_IDS.includes(row.recommendedWorkflowId as typeof WORKFLOW_IDS[number])) {
    return { recommendationId: row.id, target: { type: "workflow", id: row.recommendedWorkflowId as typeof WORKFLOW_IDS[number] }, payload };
  }
  if (row.recommendedAgentId && allowedAgents.has(row.recommendedAgentId as RecommendationAgentId)) {
    return { recommendationId: row.id, target: { type: "agent", id: row.recommendedAgentId as RecommendationAgentId }, payload };
  }
  throw new RecommendationError("INVALID_TARGET");
}

async function authenticatedUser(headers: Headers): Promise<string> {
  const session = await auth().api.getSession({ headers: new Headers(headers), query: { disableRefresh: true } });
  if (!session?.user.id) throw new RecommendationError("UNAUTHENTICATED");
  return session.user.id;
}

export async function getOwnedTopRecommendations(headers: Headers, limit = RECOMMENDATION_CONFIG.defaultTopLimit) {
  return getTopRecommendations({ userId: await authenticatedUser(headers), limit });
}

export async function refreshRecommendationsBestEffort(userId: string): Promise<void> {
  try { await evaluateRecommendations(userId); } catch { /* Optional refresh never invalidates the triggering domain write. */ }
}
