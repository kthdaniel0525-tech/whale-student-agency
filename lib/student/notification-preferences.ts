import { z } from "zod";
import { isValidTimezone } from "./timezone";
export const LEAD_TIME_OPTIONS = [10, 15, 30, 60, 120] as const;
export const quietTimeSchema = z.union([
  z.number().int().min(0).max(1439),
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time in HH:MM format.")
    .transform((value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))),
]).nullable();
export const notificationPreferenceSchema = z.object({
  remindersEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  assignmentReminders: z.boolean().optional(),
  examReminders: z.boolean().optional(),
  studyReminders: z.boolean().optional(),
  workflowReminders: z.boolean().optional(),
  proactiveRecommendationsEnabled: z.boolean().optional(),
  leadTimeMinutes: z.number().int().min(5).max(1440).optional(),
  notificationFrequency: z.enum(["AS_READY", "HOURLY"]).optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: quietTimeSchema.optional(),
  quietHoursEnd: quietTimeSchema.optional(),
  timezone: z.string().trim().max(100).refine(isValidTimezone, "Choose a valid IANA timezone, such as America/Winnipeg.").optional(),
}).strict();
export type NotificationPreferenceInput = z.input<typeof notificationPreferenceSchema>;
export interface NotificationPreferences {
  remindersEnabled: boolean;
  inAppEnabled: boolean;
  assignmentReminders: boolean;
  examReminders: boolean;
  studyReminders: boolean;
  workflowReminders: boolean;
  proactiveRecommendationsEnabled: boolean;
  leadTimeMinutes: number;
  notificationFrequency: "AS_READY" | "HOURLY";
  quietHoursEnabled: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
}
export function formatQuietTime(value: number | null): string {
  if (value === null) return "";
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
