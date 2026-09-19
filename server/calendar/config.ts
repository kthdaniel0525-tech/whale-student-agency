import "server-only";
import { INTEGRATION_FRESHNESS } from "../integrations/freshness";
/** Server-owned operational bounds; no calendar feature may expand them from client input. */
export const CALENDAR_CONFIG = {
    pastDays: 3, futureDays: 61, maxRangeDays: 65,
    freshMs: INTEGRATION_FRESHNESS["calendar-read"], pollCron: "*/15 * * * *", leaseMs: 180000,
    maxCalendars: 10, maxPages: 20, pageSize: 250, maxEvents: 5000,
    minimumMinutes: 15, defaultStartMinute: 9 * 60, defaultEndMinute: 22 * 60,
} as const;
