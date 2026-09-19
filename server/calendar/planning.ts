import "server-only";
import type { AvailabilityContext, TimeWindow } from "@/lib/student/calendar/types";
import type { PlanningBrief } from "../agents/study-planner/types";
import type { PersonalizationProfile } from "../personalization/types";
import { localMinuteOfDay } from "../time/local";
import { interval } from "./time";
import { IntegrationError } from "../integrations/errors";
/** Calendar is a time constraint, not an academic priority signal. */
export function constrainPlanningBrief(brief: PlanningBrief, calendar: AvailabilityContext | undefined, personalization?: Readonly<PersonalizationProfile>): PlanningBrief {
    if (!calendar || calendar.status === "not-connected")
        return brief;
    if (calendar.status === "unavailable")
        return { ...brief, assumptions: [...brief.assumptions, ...calendar.assumptions] };
    const preference = personalization?.preferredStudyTime?.value.toLowerCase();
    const hours = preference?.includes("morning") ? [9 * 60, 12 * 60] : preference?.includes("afternoon") ? [12 * 60, 18 * 60] : preference?.match(/evening|night/) ? [18 * 60, 22 * 60] : null;
    const availability = brief.availability.map(day => {
        let freeWindows = calendar.days.find(d => d.date === day.date)?.freeWindows ?? [];
        if (hours)
            freeWindows = freeWindows.flatMap(w => {
                const parts: TimeWindow[] = [];
                for (let t = Date.parse(w.start); t + 60000 <= Date.parse(w.end); t += 60000) {
                    const m = localMinuteOfDay(new Date(t), calendar.timezone);
                    if (m < hours[0] || m >= hours[1])
                        continue;
                    const last = parts.at(-1);
                    if (last && Date.parse(last.end) === t) {
                        last.end = new Date(t + 60000).toISOString();
                        last.durationMinutes++;
                    }
                    else
                        parts.push(interval(t, t + 60000));
                }
                return parts;
            }).filter(w => w.durationMinutes >= 15);
        // Tiny gaps stay excluded; allowance includes a short break after a continuous block.
        const usable = freeWindows.reduce((sum, w) => sum + w.durationMinutes - Math.floor(w.durationMinutes / (brief.maximumSessionMinutes + 5)) * 5, 0);
        return { ...day, availableMinutes: Math.min(day.availableMinutes, usable), freeWindows };
    });
    return { ...brief, availability, totalAvailableMinutes: availability.reduce((n, d) => n + d.availableMinutes, 0), calendarTimezone: calendar.timezone,
        assumptions: [...brief.assumptions, ...calendar.assumptions, calendar.status === "available" ? "Calendar availability considered. Session times are checked before saving." : "Only verified calendars were considered; review unavailable accounts before studying.", ...(hours ? [`Applied preferred study time: ${preference}.`] : [])] };
}
/** Place sessions into verified windows; split overlong sessions into meaningful
 * blocks on the same date. Never move work past a deadline to make it fit. */
export function placeStudyTasks<T extends {
    date: Date;
    durationMinutes: number;
    examId?: string | null;
    sourceDueDate?: Date | null;
}>(tasks: T[], brief: PlanningBrief): (T & {
    scheduledStart?: Date;
    scheduledEnd?: Date;
    scheduledTimezone?: string;
})[] {
    if (!brief.calendarTimezone)
        return tasks;
    const days = new Map(brief.availability.map(d => [d.date, (d.freeWindows ?? []).map(w => ({ s: Date.parse(w.start), e: Date.parse(w.end) }))]));
    const result: (T & {
        scheduledStart: Date;
        scheduledEnd: Date;
        scheduledTimezone: string;
    })[] = [];
    const continuous = new Map<string, number>();
    for (const task of tasks) {
        let remaining = task.durationMinutes;
        const windows = days.get(task.date.toISOString().slice(0, 10)) ?? [];
        for (const w of windows) {
            while (remaining >= 15) {
                const key = task.date.toISOString().slice(0, 10);
                let used = continuous.get(key) ?? 0;
                if (used >= brief.maximumSessionMinutes) {
                    w.s += 5 * 60000;
                    used = 0;
                    continuous.set(key, 0);
                }
                const deadline = task.examId && task.sourceDueDate ? task.sourceDueDate.getTime() : Infinity;
                const available = Math.floor((Math.min(w.e, deadline) - w.s) / 60000);
                let minutes = Math.min(remaining, available, brief.maximumSessionMinutes - used);
                if (remaining - minutes > 0 && remaining - minutes < 15)
                    minutes -= 15 - (remaining - minutes);
                if (minutes < 15) {
                    if (brief.maximumSessionMinutes - used < 15) {
                        w.s += 5 * 60000;
                        continuous.set(key, 0);
                        continue;
                    }
                    break;
                }
                result.push({ ...task, durationMinutes: minutes, scheduledStart: new Date(w.s), scheduledEnd: new Date(w.s + minutes * 60000), scheduledTimezone: brief.calendarTimezone });
                w.s += minutes * 60000;
                remaining -= minutes;
                continuous.set(key, used + minutes);
                if (!remaining)
                    break;
            }
            if (!remaining)
                break;
            continuous.set(task.date.toISOString().slice(0, 10), 0);
        }
        if (remaining)
            throw new IntegrationError("CALENDAR_CONFLICT");
    }
    return result;
}
