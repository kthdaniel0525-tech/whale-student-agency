import "server-only";
import { STUDENT_AGENT_IDS } from "../agents/types";
import { db } from "../db/client";
import { WORKFLOW_IDS } from "../workflows/types";
import { getNotificationPreferences, updateNotificationPreferences, enabledReminderTypes, reminderTypeEnabled, cancelDisabledReminders } from "../preferences/notifications";
import type { NotificationPreferenceInput, NotificationPreferences } from "@/lib/student/notification-preferences";
import { REMINDER_CONFIG } from "./config";
import { detectReminderCandidates, rankReminderCandidates } from "./detection";
import type {
  RankedReminderCandidate,
  ReminderActionTargetType,
  ReminderEvaluationResult,
  ReminderJson,
  ReminderRecord,
  ReminderSourceType,
  ReminderStatus,
  ReminderType,
} from "./types";

const DAY = 86_400_000;
const activeStatuses = ["SCHEDULED", "READY", "SNOOZED"] as const;

const typeToDatabase = {
  "assignment-due": "ASSIGNMENT_DUE",
  "assignment-overdue": "ASSIGNMENT_OVERDUE",
  "exam-upcoming": "EXAM_UPCOMING",
  "exam-tomorrow": "EXAM_TOMORROW",
  "study-session": "STUDY_SESSION",
  "missed-study-task": "MISSED_STUDY_TASK",
  "study-plan-behind": "STUDY_PLAN_BEHIND",
  "weak-topic-before-exam": "WEAK_TOPIC_BEFORE_EXAM",
  "diagnostic-practice": "DIAGNOSTIC_PRACTICE",
  "workflow-waiting": "WORKFLOW_WAITING",
} as const;
const typeFromDatabase = Object.fromEntries(
  Object.entries(typeToDatabase).map(([key, value]) => [value, key]),
) as Record<(typeof typeToDatabase)[ReminderType], ReminderType>;
const sourceToDatabase = {
  assignment: "ASSIGNMENT",
  exam: "EXAM",
  "study-task": "STUDY_TASK",
  "study-plan": "STUDY_PLAN",
  "learning-topic": "LEARNING_TOPIC",
  "workflow-run": "WORKFLOW_RUN",
} as const;
const sourceFromDatabase = Object.fromEntries(
  Object.entries(sourceToDatabase).map(([key, value]) => [value, key]),
) as Record<(typeof sourceToDatabase)[ReminderSourceType], ReminderSourceType>;
const priorityToDatabase = {
  low: "LOW", medium: "MEDIUM", high: "HIGH", critical: "CRITICAL",
} as const;
const priorityFromDatabase = {
  LOW: "low", MEDIUM: "medium", HIGH: "high", CRITICAL: "critical",
} as const;
const statusFromDatabase = {
  SCHEDULED: "scheduled", READY: "ready", DELIVERED: "delivered",
  DISMISSED: "dismissed", SNOOZED: "snoozed", EXPIRED: "expired",
  CANCELLED: "cancelled",
} as const satisfies Record<string, ReminderStatus>;
const actionToDatabase = {
  agent: "AGENT", workflow: "WORKFLOW", resource: "RESOURCE",
} as const;
const actionFromDatabase = {
  AGENT: "agent", WORKFLOW: "workflow", RESOURCE: "resource",
} as const satisfies Record<string, ReminderActionTargetType>;

export type ReminderErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "INVALID_TARGET"
  | "STORAGE_FAILURE";

export class ReminderError extends Error {
  constructor(readonly code: ReminderErrorCode) {
    super({
      INVALID_REQUEST: "Check the reminder request.",
      NOT_FOUND: "This reminder is no longer available.",
      INVALID_TARGET: "The reminder action is no longer valid.",
      STORAGE_FAILURE: "Reminders could not be loaded or updated.",
    }[code]);
    this.name = "ReminderError";
  }
}

function jsonObject(value: unknown): ReminderJson {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string | number | boolean | null] =>
    entry[1] === null || ["string", "number", "boolean"].includes(typeof entry[1]),
  ));
}

type ReminderRow = NonNullable<Awaited<ReturnType<ReturnType<typeof db>["reminder"]["findFirst"]>>>;

function publicReminder(row: ReminderRow): ReminderRecord {
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
    scheduledFor: row.scheduledFor.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    reasonCode: row.reasonCode,
    reasonData: jsonObject(row.reasonData),
    action: row.actionTargetType && row.actionTargetId ? {
      type: actionFromDatabase[row.actionTargetType],
      id: row.actionTargetId,
      payload: jsonObject(row.actionPayload),
    } : null,
  };
}

// Compatibility exports for existing reminder callers; storage/validation are centralized.
export const getReminderPreferences = getNotificationPreferences;
export type ReminderPreferenceInput = NotificationPreferenceInput;
export async function updateReminderPreferences(userId: string, raw: ReminderPreferenceInput) {
  const explicitTimes = raw.quietHoursStart !== undefined && raw.quietHoursEnd !== undefined;
  return updateNotificationPreferences(userId, { ...raw,
    ...(explicitTimes && raw.quietHoursEnabled === undefined ? { quietHoursEnabled: raw.quietHoursStart !== null && raw.quietHoursEnd !== null } : {}),
  }, { refresh: false });
}

async function loadDetectionInput(userId: string, now: Date, preferences: NotificationPreferences) {
  const [assignments, exams, topics, studyPlans, workflows] = await Promise.all([
    db().assignment.findMany({
      where: {
        userId, status: { not: "COMPLETED" },
        dueDate: {
          gte: new Date(now.getTime() - (REMINDER_CONFIG.historicalOverdueDays + 1) * DAY),
          lte: new Date(now.getTime() + 8 * DAY),
        },
      },
      select: {
        id: true, courseId: true, title: true, dueDate: true, status: true,
        priority: true, estimatedHours: true,
        course: { select: { courseCode: true } },
      },
      orderBy: { dueDate: "asc" }, take: 100,
    }),
    db().exam.findMany({
      where: {
        userId,
        examDate: { gte: new Date(now.getTime() - DAY), lte: new Date(now.getTime() + 15 * DAY) },
      },
      select: {
        id: true, courseId: true, title: true, examDate: true, topics: true,
        course: { select: { courseCode: true } },
      },
      orderBy: { examDate: "asc" }, take: 50,
    }),
    db().learningTopic.findMany({
      where: { userId, progress: { isNot: null } },
      select: {
        id: true, courseId: true, name: true, normalizedName: true,
        progress: { select: {
          masteryScore: true, confidenceScore: true, questionsAttempted: true,
        } },
      },
      take: 150,
    }),
    db().studyPlan.findMany({
      where: { userId, status: "ACTIVE" },
      select: {
        id: true, title: true, endDate: true, status: true,
        tasks: {
          where: { userId },
          select: {
            id: true, courseId: true, examId: true, title: true, date: true, scheduledStart: true,
            durationMinutes: true, priority: true, status: true, updatedAt: true,
          },
          orderBy: [{ date: "asc" }, { priority: "desc" }], take: 200,
        },
      },
      orderBy: { updatedAt: "desc" }, take: 20,
    }),
    db().workflowRun.findMany({
      where: { userId, status: "WAITING_FOR_INPUT" },
      select: {
        id: true, workflowId: true, currentStep: true, status: true, updatedAt: true,
      },
      orderBy: { updatedAt: "asc" }, take: 30,
    }),
  ]);
  return {
    preferences,
    input: {
      now,
      timezone: preferences.timezone,
      leadTimeMinutes: preferences.leadTimeMinutes,
      assignments: assignments.map((row) => ({ ...row, courseCode: row.course.courseCode })),
      exams: exams.map((row) => ({ ...row, courseCode: row.course.courseCode })),
      topics: topics.flatMap((row) => row.progress ? [{
        id: row.id,
        courseId: row.courseId,
        name: row.name,
        normalizedName: row.normalizedName,
        mastery: row.progress.masteryScore,
        confidence: row.progress.confidenceScore,
        questionsAttempted: row.progress.questionsAttempted,
      }] : []),
      studyPlans,
      workflows: workflows.map((workflow) => ({
        ...workflow,
        status: "WAITING_FOR_INPUT" as const,
      })),
    },
  };
}

function validCandidateTarget(candidate: RankedReminderCandidate): boolean {
  if (candidate.actionTargetType === "agent")
    return STUDENT_AGENT_IDS.includes(candidate.actionTargetId as typeof STUDENT_AGENT_IDS[number]);
  if (candidate.actionTargetType === "workflow")
    return WORKFLOW_IDS.includes(candidate.actionTargetId as typeof WORKFLOW_IDS[number]);
  return ["assignment", "study-task", "study-plan", "workflow-run"].includes(candidate.actionTargetId);
}

function statusFor(scheduledFor: Date, now: Date) {
  return scheduledFor <= now ? "READY" as const : "SCHEDULED" as const;
}

function candidateData(
  userId: string,
  candidate: RankedReminderCandidate,
  now: Date,
) {
  return {
    type: typeToDatabase[candidate.type],
    title: candidate.title,
    message: candidate.message,
    priority: priorityToDatabase[candidate.priority],
    priorityScore: candidate.priorityScore,
    status: statusFor(candidate.scheduledFor, now),
    sourceType: sourceToDatabase[candidate.sourceType],
    sourceId: candidate.sourceId,
    scheduledFor: candidate.scheduledFor,
    expiresAt: candidate.expiresAt,
    reasonCode: candidate.reasonCode,
    reasonData: candidate.reasonData,
    preferenceSuppressedAt: null,
    actionTargetType: actionToDatabase[candidate.actionTargetType],
    actionTargetId: candidate.actionTargetId,
    actionPayload: candidate.actionPayload,
    dedupeKey: candidate.dedupeKey,
    supersessionKey: candidate.supersessionKey,
    stateFingerprint: candidate.stateFingerprint,
    activeKey: `${userId}:${candidate.supersessionKey}`,
    snoozedUntil: null,
  };
}

export async function evaluateReminders(
  userId: string,
  options: { now?: Date; enqueueDelivery?: (userId: string) => Promise<unknown> } = {},
): Promise<ReminderEvaluationResult> {
  if (!userId || userId.length > 100) throw new ReminderError("INVALID_REQUEST");
  const now = options.now ?? new Date();
  try {
    const owner = await db().user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!owner) throw new ReminderError("NOT_FOUND");
    const initialPreferences = await getNotificationPreferences(userId);
    if (!enabledReminderTypes(initialPreferences).length) {
      await db().$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
        await cancelDisabledReminders(tx, userId, await getNotificationPreferences(userId, tx), now);
      });
      return { reminders: [], candidatesDetected: 0, created: 0, updated: 0, deduplicated: 0, expired: 0, snoozed: 0, dismissed: 0 };
    }
    const { input } = await loadDetectionInput(userId, now, initialPreferences);
    let ranked: RankedReminderCandidate[] = [];
    let created = 0, updated = 0, deduplicated = 0, expired = 0;
    await db().$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
      const preferences = await getNotificationPreferences(userId, transaction);
      await cancelDisabledReminders(transaction, userId, preferences, now);
      ranked = rankReminderCandidates(detectReminderCandidates({ ...input, timezone: preferences.timezone, leadTimeMinutes: preferences.leadTimeMinutes })
        .filter((candidate) => reminderTypeEnabled(candidate.type, preferences)))
        .filter(validCandidateTarget);
      // Changing lead time can select a different dedupe key for the same session.
      // Carry the explicit per-reminder snooze across that settings adjustment.
      const snoozes = await transaction.reminder.findMany({ where: { userId, status: "SNOOZED", snoozedUntil: { gt: now } },
        select: { supersessionKey: true, snoozedUntil: true } });
      const selected = new Set(ranked.map((candidate) => candidate.dedupeKey));
      const stale = await transaction.reminder.updateMany({
        where: {
          userId,
          type: { in: enabledReminderTypes(preferences) },
          status: { in: [...activeStatuses, "DELIVERED"] },
          ...(selected.size ? {
            OR: [
              { dedupeKey: { notIn: [...selected] } },
              { expiresAt: { lte: now } },
            ],
          } : {}),
        },
        data: { status: "EXPIRED", activeKey: null },
      });
      expired += stale.count;
      for (const candidate of ranked) {
        const existing = await transaction.reminder.findUnique({
          where: { userId_dedupeKey: { userId, dedupeKey: candidate.dedupeKey } },
        });
        const settingsSuppressed = existing?.status === "CANCELLED" && existing.preferenceSuppressedAt !== null;
        if (candidate.expiresAt && candidate.expiresAt <= now) continue;
        // A lead-time round trip may revisit a superseded, still-future session.
        // Reuse that undelivered row; historical or dismissed work never revives.
        const futureSessionRescheduled = candidate.type === "study-session" && existing?.status === "EXPIRED" &&
          !existing.deliveredAt && !existing.dismissedAt && candidate.scheduledFor > now &&
          existing.expiresAt && existing.expiresAt > now;
        if (existing && !settingsSuppressed && !futureSessionRescheduled && ["DISMISSED", "DELIVERED", "EXPIRED", "CANCELLED"].includes(existing.status)) {
          deduplicated++;
          continue;
        }
        if (existing?.status === "SNOOZED" && existing.snoozedUntil && existing.snoozedUntil > now) {
          deduplicated++;
          continue;
        }
        const data = candidateData(userId, candidate, now);
        const restoreSnooze = settingsSuppressed && existing.snoozedUntil && existing.snoozedUntil > now
          ? existing.snoozedUntil : snoozes.find((row) => row.supersessionKey === candidate.supersessionKey)?.snoozedUntil ?? null;
        if (existing &&
          existing.stateFingerprint === data.stateFingerprint &&
          existing.priorityScore === data.priorityScore &&
          existing.title === data.title && existing.message === data.message &&
          existing.status === data.status &&
          (existing.status === "READY" ||
            existing.scheduledFor.getTime() === data.scheduledFor.getTime())) {
          deduplicated++;
          continue;
        }
        const superseded = await transaction.reminder.updateMany({
          where: {
            userId,
            status: { in: [...activeStatuses, "DELIVERED"] },
            supersessionKey: candidate.supersessionKey,
            ...(existing ? { id: { not: existing.id } } : {}),
          },
          data: { status: "EXPIRED", activeKey: null },
        });
        expired += superseded.count;
        const scheduledData = restoreSnooze ? { ...data, status: "SNOOZED" as const, snoozedUntil: restoreSnooze,
          scheduledFor: new Date(Math.max(data.scheduledFor.getTime(), restoreSnooze.getTime())) } : data;
        if (existing) {
          await transaction.reminder.update({ where: { id: existing.id }, data: scheduledData });
          updated++;
        } else {
          await transaction.reminder.create({ data: { userId, ...scheduledData } });
          created++;
        }
      }
    });
    const [rows, snoozed, dismissed] = await Promise.all([
      db().reminder.findMany({
        where: {
          userId, status: { in: [...activeStatuses] },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ priorityScore: "desc" }, { scheduledFor: "asc" }, { id: "asc" }],
        take: REMINDER_CONFIG.maximumActiveReminders,
      }),
      db().reminder.count({ where: { userId, status: "SNOOZED" } }),
      db().reminder.count({ where: { userId, status: "DISMISSED" } }),
    ]);
    if (rows.some((row) => row.status === "READY")) {
      try {
        if (options.enqueueDelivery) await options.enqueueDelivery(userId);
        else if (process.env.NODE_ENV !== "test") {
          const { enqueueNotificationDelivery } = await import("../jobs/enqueue");
          await enqueueNotificationDelivery(userId);
        }
      } catch {
        // The durable reminder remains available to the scheduled delivery sweep.
        console.error("Notification enqueue deferred to sweep", { userId });
      }
    }
    return {
      reminders: rows.map(publicReminder),
      candidatesDetected: ranked.length,
      created, updated, deduplicated, expired, snoozed, dismissed,
    };
  } catch (error) {
    if (error instanceof ReminderError) throw error;
    throw new ReminderError("STORAGE_FAILURE");
  }
}

export async function getUpcomingReminders(input: {
  userId: string;
  limit?: number;
  now?: Date;
  refresh?: boolean;
}): Promise<ReminderRecord[]> {
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > REMINDER_CONFIG.maximumUpcomingReminders)
    throw new ReminderError("INVALID_REQUEST");
  const now = input.now ?? new Date();
  if (input.refresh !== false) await evaluateReminders(input.userId, { now });
  const rows = await db().reminder.findMany({
    where: {
      userId: input.userId,
      status: { in: [...activeStatuses] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ priorityScore: "desc" }, { scheduledFor: "asc" }, { id: "asc" }],
    take: limit,
  });
  return rows.map(publicReminder);
}

async function ownedActiveReminder(userId: string, reminderId: string) {
  if (!reminderId || reminderId.length > 100) throw new ReminderError("INVALID_REQUEST");
  const row = await db().reminder.findFirst({ where: {
    id: reminderId, userId, status: { in: [...activeStatuses] },
  } });
  if (!row) throw new ReminderError("NOT_FOUND");
  return row;
}

export async function snoozeReminder(
  userId: string,
  reminderId: string,
  until: Date,
  now = new Date(),
): Promise<ReminderRecord> {
  const row = await ownedActiveReminder(userId, reminderId);
  if (!Number.isFinite(until.getTime()) || until <= now || until > new Date(now.getTime() + 30 * DAY) ||
    (row.expiresAt && until >= row.expiresAt)) throw new ReminderError("INVALID_REQUEST");
  return publicReminder(await db().reminder.update({
    where: { id: row.id },
    data: { status: "SNOOZED", snoozedUntil: until },
  }));
}

export async function dismissReminder(
  userId: string,
  reminderId: string,
  now = new Date(),
): Promise<ReminderRecord> {
  const row = await ownedActiveReminder(userId, reminderId);
  return publicReminder(await db().reminder.update({
    where: { id: row.id },
    data: { status: "DISMISSED", dismissedAt: now, activeKey: null },
  }));
}

async function sourceExists(userId: string, sourceType: ReminderSourceType, sourceId: string) {
  if (sourceType === "assignment") return Boolean(await db().assignment.findFirst({ where: { id: sourceId, userId }, select: { id: true } }));
  if (sourceType === "exam") return Boolean(await db().exam.findFirst({ where: { id: sourceId, userId }, select: { id: true } }));
  if (sourceType === "study-task") return Boolean(await db().studyTask.findFirst({ where: { id: sourceId, userId }, select: { id: true } }));
  if (sourceType === "study-plan") return Boolean(await db().studyPlan.findFirst({ where: { id: sourceId, userId }, select: { id: true } }));
  if (sourceType === "learning-topic") return Boolean(await db().learningTopic.findFirst({ where: { id: sourceId, userId }, select: { id: true } }));
  return Boolean(await db().workflowRun.findFirst({ where: { id: sourceId, userId }, select: { id: true } }));
}

async function payloadReferencesExist(userId: string, payload: ReminderJson) {
  const checks: Promise<boolean>[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!key.endsWith("Id") || typeof value !== "string") continue;
    if (key === "courseId") checks.push(db().course.findFirst({ where: { id: value, userId }, select: { id: true } }).then(Boolean));
    else if (key === "assignmentId") checks.push(db().assignment.findFirst({ where: { id: value, userId }, select: { id: true } }).then(Boolean));
    else if (key === "examId") checks.push(db().exam.findFirst({ where: { id: value, userId }, select: { id: true } }).then(Boolean));
    else if (key === "topicId") checks.push(db().learningTopic.findFirst({ where: { id: value, userId }, select: { id: true } }).then(Boolean));
    else if (key === "studyPlanId") checks.push(db().studyPlan.findFirst({ where: { id: value, userId }, select: { id: true } }).then(Boolean));
    else if (key === "studyTaskId") checks.push(db().studyTask.findFirst({ where: { id: value, userId }, select: { id: true } }).then(Boolean));
    else if (key === "workflowRunId") checks.push(db().workflowRun.findFirst({ where: { id: value, userId }, select: { id: true } }).then(Boolean));
  }
  return (await Promise.all(checks)).every(Boolean);
}

export async function getReminderAction(userId: string, reminderId: string) {
  const row = await db().reminder.findFirst({ where: { id: reminderId, userId } });
  if (!row) throw new ReminderError("NOT_FOUND");
  if (!row.actionTargetType || !row.actionTargetId || !row.sourceId ||
    !await sourceExists(userId, sourceFromDatabase[row.sourceType], row.sourceId))
    throw new ReminderError("INVALID_TARGET");
  const payload = jsonObject(row.actionPayload);
  if (!await payloadReferencesExist(userId, payload))
    throw new ReminderError("INVALID_TARGET");
  const targetType = actionFromDatabase[row.actionTargetType];
  if (targetType === "agent" && !STUDENT_AGENT_IDS.includes(row.actionTargetId as typeof STUDENT_AGENT_IDS[number]))
    throw new ReminderError("INVALID_TARGET");
  if (targetType === "workflow" && !WORKFLOW_IDS.includes(row.actionTargetId as typeof WORKFLOW_IDS[number]))
    throw new ReminderError("INVALID_TARGET");
  if (targetType === "resource" && !["assignment", "study-task", "study-plan", "workflow-run"].includes(row.actionTargetId))
    throw new ReminderError("INVALID_TARGET");
  return {
    reminderId: row.id,
    target: { type: targetType, id: row.actionTargetId },
    payload,
  };
}

export async function refreshRemindersBestEffort(userId: string): Promise<void> {
  try {
    if (process.env.NODE_ENV === "test") await evaluateReminders(userId);
    else {
      const { enqueueReminderRefresh } = await import("../jobs/enqueue");
      await enqueueReminderRefresh(userId);
    }
  } catch {
    // Reminder freshness must never invalidate the domain write that triggered it.
  }
}
