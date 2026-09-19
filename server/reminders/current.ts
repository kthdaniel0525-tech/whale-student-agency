import "server-only";
import { db } from "../db/client";
import { calendarDayDifference, isUtcDateOnly, validTimezone } from "../time/local";
import type { Reminder } from "@/generated/prisma/client";

/** Resource lifecycle checks only. Academic detection/priority stays in the engine. */
export async function reminderSourceCurrent(row: Reminder, now: Date): Promise<boolean> {
  if (!row.sourceId || ["EXPIRED", "CANCELLED", "DISMISSED"].includes(row.status) ||
    (row.expiresAt && row.expiresAt <= now)) return false;
  const where = { id: row.sourceId, userId: row.userId };
  const payload = row.actionPayload as Record<string, unknown> | null;
  const examCurrent = async (id: string) => {
    const exam = await db().exam.findFirst({ where: { id, userId: row.userId } });
    if (!exam) return false;
    if (!isUtcDateOnly(exam.examDate)) return exam.examDate > now;
    const profile = await db().profile.findUnique({ where: { userId: row.userId }, select: { timezone: true } });
    return calendarDayDifference(exam.examDate, now, validTimezone(profile?.timezone)) >= 0;
  };
  if (typeof payload?.examId === "string" && !await examCurrent(payload.examId)) return false;
  switch (row.sourceType) {
    case "ASSIGNMENT": return Boolean(await db().assignment.findFirst({ where: { ...where, status: { not: "COMPLETED" } } }));
    case "EXAM": return examCurrent(row.sourceId);
    case "STUDY_PLAN": return Boolean(await db().studyPlan.findFirst({ where: { ...where, status: "ACTIVE" } }));
    case "STUDY_TASK": return Boolean(await db().studyTask.findFirst({ where: { ...where,
      status: { in: row.type === "MISSED_STUDY_TASK" ? ["PLANNED", "IN_PROGRESS", "SKIPPED"] : ["PLANNED", "IN_PROGRESS"] },
      studyPlan: { userId: row.userId, status: "ACTIVE" },
    } }));
    case "WORKFLOW_RUN": return Boolean(await db().workflowRun.findFirst({ where: { ...where, status: "WAITING_FOR_INPUT" } }));
    case "LEARNING_TOPIC": {
      const topic = await db().learningTopic.findFirst({ where, include: { progress: true } });
      if (!topic?.progress) return false;
      return row.type === "DIAGNOSTIC_PRACTICE"
        ? topic.progress.confidenceScore <= 44 && topic.progress.masteryScore <= 69
        : topic.progress.confidenceScore >= 60 && topic.progress.masteryScore <= 59;
    }
  }
}
