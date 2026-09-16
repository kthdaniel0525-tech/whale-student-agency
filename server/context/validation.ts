import "server-only";
import { z } from "zod";
import { MEMORY_CATEGORIES } from "../memory/types";
export const contextSchema = z
  .object({
    request: z
      .string()
      .min(1)
      .max(10000)
      .refine((value) => value.trim().length > 0),
    courseId: z.string().min(1).max(100).optional(),
    examId: z.string().min(1).max(100).optional(),
    assignmentId: z.string().min(1).max(100).optional(),
    projectIds: z.array(z.string().min(1).max(100)).min(1).max(10).transform((ids) => [...new Set(ids)]).optional(),
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
        selectedDocumentCoverage: z.boolean().default(false),
        memories: z.boolean().default(false),
        learning: z.boolean().default(false),
        career: z.boolean().default(false),
        academicOverview: z.boolean().default(false),
        memoryKeys: z
          .array(
            z.enum([
              "explanationStyle", "answerLength", "studySessionMinutes",
              "quizDifficulty", "questionType", "noteStyle", "planningIntensity",
              "preferredStudyTime", "academicGoal", "targetGrade", "courseGoal",
              "examGoal", "targetRole", "targetIndustry", "targetCompanies",
              "internshipTimeline", "portfolioGoal",
            ]),
          )
          .max(12)
          .default([]),
        memoryCategories: z.array(z.enum(MEMORY_CATEGORIES)).max(6).default([]),
        deadlineWindowDays: z.number().int().min(1).max(90).default(30),
        limits: z
          .object({
            assignments: z.number().int().min(1).max(20).default(6),
            exams: z.number().int().min(1).max(10).default(4),
            documents: z.number().int().min(1).max(10).default(5),
            memories: z.number().int().min(1).max(10).default(5),
            learning: z.number().int().min(1).max(10).default(5),
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
    if (value.options.selectedDocumentCoverage && (!value.options.documents || !value.documentIds?.length || value.documentIds.length > value.options.limits.documents))
      ctx.addIssue({ code: "custom", path: ["options", "selectedDocumentCoverage"], message: "Selected document coverage requires at least one retrieval slot per selected document." });
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
