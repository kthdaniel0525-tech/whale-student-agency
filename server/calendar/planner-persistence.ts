import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { PlanningBrief } from "../agents/study-planner/types";
import { getUserAvailability } from "./availability";
import { placeStudyTasks } from "./planning";
import { addCalendarDays, zonedInstant, interval } from "./time";
import { IntegrationError } from "../integrations/errors";
type Schedulable = {
    date: Date;
    durationMinutes: number;
    scheduledStart?: Date;
    scheduledEnd?: Date;
    scheduledTimezone?: string;
    examId?: string | null;
    sourceDueDate?: Date | null;
};
/** Refresh only stale data after generation, then place against the latest known
 * windows. Existing scheduled tasks are excluded only for the plan being rebuilt. */
export async function prepareScheduledTasks<T extends Schedulable>(userId: string, tasks: T[], brief: PlanningBrief, excludePlanId?: string) {
    if (!brief.calendarTimezone)
        return tasks;
    const context = await getUserAvailability({ userId, start: zonedInstant(`${brief.startDate}T00:00`, brief.calendarTimezone), end: zonedInstant(`${addCalendarDays(brief.endDate, 1)}T00:00`, brief.calendarTimezone, "end"), excludePlanId });
    if (!["available", "partial"].includes(context.status))
        throw new IntegrationError("CALENDAR_UNAVAILABLE");
    const availability = brief.availability.map(day => ({ ...day, freeWindows: (day.freeWindows ?? []).flatMap(original => (context.days.find(d => d.date === day.date)?.freeWindows ?? []).flatMap(fresh => { const start = Math.max(Date.parse(original.start), Date.parse(fresh.start)), end = Math.min(Date.parse(original.end), Date.parse(fresh.end)); return end - start >= 15 * 60000 ? [interval(start, end)] : []; })) }));
    return placeStudyTasks(tasks, { ...brief, availability });
}
export async function lockAndCheckLocalSchedule(tx: Prisma.TransactionClient, userId: string, tasks: Schedulable[], excludePlanId?: string) {
    if (!tasks.some(t => t.scheduledStart))
        return;
    await tx.$queryRaw `SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`calendar-schedule:${userId}`}))`;
    for (const task of tasks) {
        if (!task.scheduledStart || !task.scheduledEnd)
            continue;
        const conflicts = await tx.studyTask.count({ where: { userId, status: { not: "SKIPPED" }, scheduledStart: { lt: task.scheduledEnd }, scheduledEnd: { gt: task.scheduledStart }, ...(excludePlanId ? { OR: [{ studyPlanId: { not: excludePlanId } }, { status: "COMPLETED" as const }] } : {}) } });
        if (conflicts)
            throw new IntegrationError("CALENDAR_CONFLICT");
    }
}
