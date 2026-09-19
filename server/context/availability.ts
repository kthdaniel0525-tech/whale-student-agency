import "server-only";
import { getUserAvailability } from "../calendar/availability";
import { addCalendarDays, zonedInstant } from "../calendar/time";
import { localDateKey, validTimezone } from "../time/local";
import { inferPlanningEndDate } from "../time/planning-horizon";
import type { ContextData } from "./types";
import { db } from "../db/client";
import type { CategoryInput } from "./categories";
/** Only this authenticated context loader supplies planning availability. */
export async function availabilityContext({ userId, input, now }: CategoryInput, data: ContextData = {}) {
    const profile = await db().profile.findUnique({ where: { userId }, select: { timezone: true } });
    const timezone = validTimezone(profile?.timezone);
    const today = localDateKey(now, timezone);
    const window = input.options.availabilityWindow;
    const startDay = window?.startDate ?? today;
    const endDay = window?.endDate ?? inferPlanningEndDate(startDay, input.request, data);
    try {
        return await getUserAvailability({ userId, start: zonedInstant(`${startDay}T00:00`, timezone), end: zonedInstant(`${addCalendarDays(endDay, 1)}T00:00`, timezone, "end"), excludePlanId: input.options.availabilityExcludePlanId, now });
    }
    catch {
        return { status: "unavailable" as const, timezone, days: [], checkedAt: now.toISOString(), assumptions: ["Calendar availability could not be verified. Existing academic priorities and your stated time budget are used."] };
    }
}
