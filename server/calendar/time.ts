import { isValidTimezone } from "@/lib/student/timezone";
import type { TimeWindow, AvailabilityDay } from "@/lib/student/calendar/types";
import { IntegrationError } from "../integrations/errors";
import { CALENDAR_CONFIG } from "./config";
const MINUTE = 60000;
export function addCalendarDays(day: string, count: number) {
    return new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
}
export function validDay(day: string) {
    return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}
/** Resolve wall time against IANA offsets, including both fall-back occurrences.
 * Nonexistent spring-forward times are rejected. Callers cannot silently shift a booking. */
export function zonedInstant(local: string, timezone: string, edge: "start" | "end" = "start"): Date {
    if (!isValidTimezone(timezone) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local) || !validDay(local.slice(0, 10)))
        throw new IntegrationError("INVALID_REQUEST");
    const canonical = local.length === 16 ? `${local}:00` : local;
    const wall = Date.parse(`${canonical}Z`);
    if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== canonical)
        throw new IntegrationError("INVALID_REQUEST");
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const wallAt = (ms: number) => {
        const p = Object.fromEntries(formatter.formatToParts(ms).map((x) => [x.type, x.value]));
        return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    };
    const matches = new Set<number>();
    for (const offset of [-36, -12, 0, 12, 36]) {
        const sample = wall + offset * 3600000;
        const zoneOffset = Date.parse(`${wallAt(sample)}Z`) - sample;
        const candidate = wall - zoneOffset;
        if (wallAt(candidate) === canonical)
            matches.add(candidate);
    }
    if (!matches.size)
        throw new IntegrationError("INVALID_REQUEST");
    return new Date(edge === "start" ? Math.min(...matches) : Math.max(...matches));
}
export function interval(start: number, end: number): TimeWindow {
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), durationMinutes: (end - start) / MINUTE };
}
export function mergeBusy(windows: readonly Pick<TimeWindow, "start" | "end">[]): TimeWindow[] {
    const sorted = windows.map((w) => [Date.parse(w.start), Date.parse(w.end)]).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).sort((a, b) => a[0] - b[0]);
    const result: number[][] = [];
    for (const [s, e] of sorted) {
        const last = result.at(-1);
        if (last && s <= last[1])
            last[1] = Math.max(e, last[1]);
        else
            result.push([s, e]);
    }
    return result.map(([s, e]) => interval(s, e));
}
export function subtractBusy(windows: readonly TimeWindow[], busy: readonly Pick<TimeWindow, "start" | "end">[], minimumMinutes = 15): TimeWindow[] {
    const merged = mergeBusy(busy);
    const result: TimeWindow[] = [];
    for (const window of windows) {
        let cursor = Date.parse(window.start);
        const end = Date.parse(window.end);
        for (const b of merged) {
            const bs = Date.parse(b.start), be = Date.parse(b.end);
            if (be <= cursor)
                continue;
            if (bs >= end)
                break;
            if (bs > cursor)
                result.push(interval(cursor, Math.min(bs, end)));
            cursor = Math.max(cursor, be);
            if (cursor >= end)
                break;
        }
        if (cursor < end)
            result.push(interval(cursor, end));
    }
    return result.filter(w => w.durationMinutes >= minimumMinutes);
}
export function overlaps(a: Pick<TimeWindow, "start" | "end">, b: Pick<TimeWindow, "start" | "end">) { return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end); }
/** Iterate real minutes, then apply local wall-clock rules. DST gaps/folds cannot
 * invent or lose elapsed time. Quiet hours constrain study even with notifications off. */
export function studyWindows(input: {
    start: Date;
    end: Date;
    timezone: string;
    busy: readonly Pick<TimeWindow, "start" | "end">[];
    minimumMinutes?: number;
    startMinute?: number;
    endMinute?: number;
    quietStart?: number | null;
    quietEnd?: number | null;
}): AvailabilityDay[] {
    if (!Number.isFinite(input.start.getTime()) || !Number.isFinite(input.end.getTime()) || input.end <= input.start || input.end.getTime() - input.start.getTime() > CALENDAR_CONFIG.maxRangeDays * 86400000 || !isValidTimezone(input.timezone))
        throw new IntegrationError("INVALID_REQUEST");
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: input.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const days = new Map<string, TimeWindow[]>();
    for (let t = Math.ceil(input.start.getTime() / MINUTE) * MINUTE; t + MINUTE <= input.end.getTime(); t += MINUTE) {
        const p = Object.fromEntries(formatter.formatToParts(t).map(x => [x.type, x.value]));
        const date = `${p.year}-${p.month}-${p.day}`;
        const minute = Number(p.hour) * 60 + Number(p.minute);
        const windows = days.get(date) ?? [];
        days.set(date, windows);
        const qs = input.quietStart, qe = input.quietEnd;
        const quiet = qs != null && qe != null && qs !== qe && (qs > qe ? minute >= qs || minute < qe : minute >= qs && minute < qe);
        if (quiet || minute < (input.startMinute ?? CALENDAR_CONFIG.defaultStartMinute) || minute >= (input.endMinute ?? CALENDAR_CONFIG.defaultEndMinute))
            continue;
        const last = windows.at(-1);
        if (last && Date.parse(last.end) === t) {
            last.end = new Date(t + MINUTE).toISOString();
            last.durationMinutes++;
        }
        else
            windows.push(interval(t, t + MINUTE));
    }
    return [...days].map(([date, windows]) => { const freeWindows = subtractBusy(windows, input.busy, input.minimumMinutes ?? CALENDAR_CONFIG.minimumMinutes); return { date, freeWindows, availableMinutes: freeWindows.reduce((n, w) => n + w.durationMinutes, 0) }; });
}
