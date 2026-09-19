import "server-only";
import { db } from "../db/client";
import { notificationPreferencesFromStored, enabledReminderTypes } from "../preferences/notifications";

const DAY = 86_400_000;

export interface ActiveRecommendationUser {
  readonly userId: string;
  readonly timezone: string;
  readonly proactiveRecommendationsEnabled?: boolean;
  readonly remindersEnabled?: boolean;
}

export interface ActiveUserPage {
  readonly users: readonly ActiveRecommendationUser[];
  readonly nextCursor: string | null;
}

export interface ActiveUserPageInput {
  readonly now: Date;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * Selects students with a recent session or current work that can change as time
 * passes. The windows exclude abandoned historical data while active plans and
 * recommendations remain eligible until their own source state is resolved.
 */
export async function selectActiveRecommendationUsers(
  input: ActiveUserPageInput,
): Promise<ActiveUserPage> {
  const recentSession = new Date(input.now.getTime() - 30 * DAY);
  const recentDeadline = new Date(input.now.getTime() - 30 * DAY);
  const upcomingAssignment = new Date(input.now.getTime() + 60 * DAY);
  const recentExam = new Date(input.now.getTime() - DAY);
  const upcomingExam = new Date(input.now.getTime() + 120 * DAY);

  const rows = await db().user.findMany({
    where: {
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      OR: [
        { sessions: { some: { OR: [
          { expiresAt: { gt: input.now } },
          { updatedAt: { gte: recentSession } },
        ] } } },
        { assignments: { some: {
          status: { not: "COMPLETED" },
          dueDate: { gte: recentDeadline, lte: upcomingAssignment },
        } } },
        { exams: { some: { examDate: { gte: recentExam, lte: upcomingExam } } } },
        { studyPlans: { some: {
          status: "ACTIVE",
          endDate: { gte: recentDeadline },
        } } },
        { recommendations: { some: { status: "ACTIVE" } } },
        { reminders: { some: { status: { in: ["SCHEDULED", "READY", "SNOOZED"] } } } },
        { workflowRuns: { some: { status: "WAITING_FOR_INPUT" } } },
        { careerPlans: { some: { status: "ACTIVE" } } },
      ],
    },
    select: {
      id: true,
      profile: { select: { timezone: true } },
      reminderPreference: true,
    },
    orderBy: { id: "asc" },
    take: input.limit + 1,
  });
  const pageRows = rows.slice(0, input.limit);
  return {
    users: pageRows.map((row) => {
      const preferences = notificationPreferencesFromStored(row.reminderPreference, row.profile?.timezone);
      return { userId: row.id, timezone: preferences.timezone,
        ...(!preferences.proactiveRecommendationsEnabled ? { proactiveRecommendationsEnabled: false } : {}),
        ...(!enabledReminderTypes(preferences).length ? { remindersEnabled: false } : {}),
      };
    }),
    nextCursor: rows.length > input.limit
      ? pageRows.at(-1)?.id ?? null
      : null,
  };
}
