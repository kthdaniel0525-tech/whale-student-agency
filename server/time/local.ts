import { isValidTimezone } from "@/lib/student/timezone";
const DAY = 86_400_000;
export const DEFAULT_APPLICATION_TIMEZONE = "UTC";

export function validTimezone(timezone: string | null | undefined): string {
  const candidate = timezone?.trim() || DEFAULT_APPLICATION_TIMEZONE;
  return isValidTimezone(candidate) ? candidate : DEFAULT_APPLICATION_TIMEZONE;
}

export function localDateParts(now: Date, timezone?: string | null) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    hour: Number(value.hour),
    minute: Number(value.minute),
  };
}

export function localDateKey(now: Date, timezone?: string | null): string {
  const value = localDateParts(now, timezone);
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

export function calendarDayDifference(
  date: Date,
  now: Date,
  timezone?: string | null,
): number {
  const target = localDateParts(date, timezone);
  const current = localDateParts(now, timezone);
  const targetDay = Date.UTC(target.year, target.month - 1, target.day) / DAY;
  const currentDay = Date.UTC(current.year, current.month - 1, current.day) / DAY;
  return targetDay - currentDay;
}

export function localMinuteOfDay(now: Date, timezone?: string | null): number {
  const parts = localDateParts(now, timezone);
  return parts.hour * 60 + parts.minute;
}

export function isUtcDateOnly(value: Date): boolean {
  return value.getUTCHours() === 0 && value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;
}

export function deferPastQuietHours(
  scheduledFor: Date,
  timezone: string,
  quietHoursStart: number | null,
  quietHoursEnd: number | null,
): { scheduledFor: Date; deferred: boolean } {
  if (quietHoursStart === null || quietHoursEnd === null || quietHoursStart === quietHoursEnd)
    return { scheduledFor, deferred: false };
  const minute = localMinuteOfDay(scheduledFor, timezone);
  const overnight = quietHoursStart > quietHoursEnd;
  const quiet = overnight
    ? minute >= quietHoursStart || minute < quietHoursEnd
    : minute >= quietHoursStart && minute < quietHoursEnd;
  if (!quiet) return { scheduledFor, deferred: false };
  // Scan real minutes through the local quiet interval. Adding wall-clock hours
  // directly is incorrect when a daylight-saving transition changes its length.
  const formatter = new Intl.DateTimeFormat("en", { timeZone: validTimezone(timezone), hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const nextMinute = Math.floor(scheduledFor.getTime() / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset < 27 * 60; offset++) {
    const candidate = new Date(nextMinute + offset * 60_000);
    const values = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    const localMinute = Number(values.hour) * 60 + Number(values.minute);
    const stillQuiet = overnight ? localMinute >= quietHoursStart || localMinute < quietHoursEnd
      : localMinute >= quietHoursStart && localMinute < quietHoursEnd;
    if (!stillQuiet) return { scheduledFor: candidate, deferred: true };
  }
  return { scheduledFor: new Date(nextMinute + 27 * 60 * 60_000), deferred: true };
}
