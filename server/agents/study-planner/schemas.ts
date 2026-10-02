import "server-only";
import { z } from "zod";
import { STUDY_ACTIVITY_TYPES } from "./types";

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)));

const scope = {
  examId: z.string().min(1).max(100).optional(),
  request: z.string().trim().min(3).max(1000),
  conversation: z.object({
    id: z.string().min(1).max(100),
    turnId: z.string().min(1).max(100).optional(),
  }).strict().optional(),
  courseId: z.string().min(1).max(100).optional(),
  documentIds: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(20)
    .transform((ids) => [...new Set(ids)])
    .optional(),
  preferredSessionMinutes: z.number().int().min(15).max(180).optional(),
} as const;

const availabilitySchema = z
  .array(
    z
      .object({
        date: dateOnly,
        availableMinutes: z.number().int().min(0).max(720),
      })
      .strict(),
  )
  .min(1)
  .max(91)
  .superRefine((items, context) => {
    if (new Set(items.map((item) => item.date)).size !== items.length) {
      context.addIssue({
        code: "custom",
        message: "Availability dates must be unique.",
      });
    }
  });

export const studyPlanRequestSchema = z
  .object({
    ...scope,
    startDate: dateOnly.optional(),
    endDate: dateOnly.optional(),
    availability: availabilitySchema.optional(),
    intensive: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startDate && value.endDate && value.endDate < value.startDate) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "The end date must be on or after the start date.",
      });
    }
  });

export const studyPlanUpdateRequestSchema = studyPlanRequestSchema
  .innerType()
  .extend({ planId: z.string().min(1).max(100) })
  .strict();

export const studyNowRequestSchema = z
  .object({
    ...scope,
    availableMinutes: z.number().int().min(15).max(720).optional(),
  })
  .strict();

export const studyTaskStatusSchema = z.enum([
  "planned",
  "in-progress",
  "completed",
  "skipped",
]);

const generatedSessionSchema = z
  .object({
    signalId: z.string().trim().min(1).max(150),
    title: z.string().trim().min(1).max(200),
    topic: z.string().trim().min(1).max(160).nullable(),
    activityType: z.enum(STUDY_ACTIVITY_TYPES),
    durationMinutes: z.number().int().min(15).max(180),
  })
  .strict();

export const generatedStudyPlanWireSchema = z.object({
    title: z.string().trim().min(1).max(200),
    startDate: dateOnly,
    endDate: dateOnly,
    summary: z.string().trim().min(1).max(1000),
    totalPlannedMinutes: z.number().int().min(15).max(65520),
    days: z
      .array(
        z
          .object({
            date: dateOnly,
            totalMinutes: z.number().int().min(15).max(720),
            sessions: z.array(generatedSessionSchema).min(1).max(24),
          })
          .strict(),
      )
      .min(1)
      .max(91),
  }).strict();

export const generatedStudyPlanSchema = generatedStudyPlanWireSchema
  .superRefine((plan, context) => {
    if (plan.endDate < plan.startDate) {
      context.addIssue({ code: "custom", path: ["endDate"], message: "Invalid range." });
    }
    if (new Set(plan.days.map((day) => day.date)).size !== plan.days.length) {
      context.addIssue({ code: "custom", path: ["days"], message: "Plan dates must be unique." });
    }
    const total = plan.days.reduce((sum, day) => sum + day.totalMinutes, 0);
    if (total !== plan.totalPlannedMinutes) {
      context.addIssue({ code: "custom", path: ["totalPlannedMinutes"], message: "Plan totals do not match." });
    }
    plan.days.forEach((day, index) => {
      const dayTotal = day.sessions.reduce(
        (sum, session) => sum + session.durationMinutes,
        0,
      );
      if (dayTotal !== day.totalMinutes) {
        context.addIssue({ code: "custom", path: ["days", index, "totalMinutes"], message: "Day totals do not match." });
      }
    });
  });

export type GeneratedStudyPlanWire = z.infer<typeof generatedStudyPlanWireSchema>;
export type GeneratedStudyPlan = z.infer<typeof generatedStudyPlanSchema>;

/** Model-authored arithmetic is redundant and error-prone. Session durations
 * remain model output, while day/plan totals are deterministically derived
 * before the full cross-field schema and planning constraints are applied. */
export function normalizeGeneratedStudyPlan(
  plan: GeneratedStudyPlanWire,
): GeneratedStudyPlan {
  const days = plan.days.map((day) => ({
    ...day,
    totalMinutes: day.sessions.reduce(
      (sum, session) => sum + session.durationMinutes,
      0,
    ),
  }));
  return generatedStudyPlanSchema.parse({
    ...plan,
    days,
    totalPlannedMinutes: days.reduce(
      (sum, day) => sum + day.totalMinutes,
      0,
    ),
  });
}
