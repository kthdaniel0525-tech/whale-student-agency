import "server-only";
import { z } from "zod";
export const contextSchema = z
  .object({
    request: z
      .string()
      .min(1)
      .max(10000)
      .refine((value) => value.trim().length > 0),
    courseId: z.string().min(1).max(100).optional(),
    documentIds: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(20)
      .transform((ids) => [...new Set(ids)])
      .optional(),
    options: z
      .object({
        profile: z.boolean().default(false),
        course: z.boolean().default(false),
        assignments: z.boolean().default(false),
        exams: z.boolean().default(false),
        documents: z.boolean().default(false),
        memories: z.boolean().default(false),
        learning: z.boolean().default(false),
        memoryKeys: z
          .array(
            z.enum(["explanationStyle", "studySessionMinutes", "academicGoal"]),
          )
          .max(3)
          .default([]),
        deadlineWindowDays: z.number().int().min(1).max(90).default(30),
        limits: z
          .object({
            assignments: z.number().int().min(1).max(20).default(6),
            exams: z.number().int().min(1).max(10).default(4),
            documents: z.number().int().min(1).max(10).default(5),
            memories: z.number().int().min(1).max(3).default(3),
            maxCharacters: z.number().int().min(2048).max(40000).default(24000),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.options.documents &&
      (value.request.trim().length < 3 || value.request.trim().length > 1000)
    )
      ctx.addIssue({
        code: "custom",
        path: ["request"],
        message: "Document retrieval requires a query of 3–1000 characters.",
      });
  });
export type SelectedContext = z.infer<typeof contextSchema>;
export class ContextError extends Error {
  constructor(public readonly code: "UNAUTHENTICATED" | "INVALID_REQUEST") {
    super(
      code === "UNAUTHENTICATED"
        ? "Sign in to prepare personal context."
        : "Check the context request and limits.",
    );
    this.name = "ContextError";
  }
}
