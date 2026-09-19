import "server-only";
/** Feature-specific freshness; explicit manual refreshes may bypass metadata age, never throttling. */
export const INTEGRATION_FRESHNESS = {
  "calendar-read": 5 * 60000,
  "drive-read": 24 * 3600000,
  academic: 180 * 60000,
  academicFiles: 24 * 3600000,
} as const;
