import "server-only";
import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (maxItems: number, maxLength: number) => z.array(text(maxLength)).max(maxItems);
const url = text(1000).url().refine((value) => /^https?:\/\//i.test(value), "Use an HTTP or HTTPS URL.");
export const careerProfileSchema = z.object({
  careerGoal: text(1000).nullable().default(null),
  targetRoles: list(8, 100).default([]),
  targetIndustries: list(8, 100).default([]),
  experiences: list(10, 1500).default([]),
  portfolioLinks: z.array(url).max(8).default([]),
  resumeText: text(12000).nullable().default(null),
}).strict();
export const projectSchema = z.object({
  courseId: text(100).nullable().default(null),
  name: text(160),
  description: text(2000),
  technologies: list(20, 80).default([]),
  role: text(300).nullable().default(null),
  outcomes: list(8, 500).default([]),
  link: url.nullable().default(null),
  repositoryUrl: url.nullable().default(null),
}).strict();
export const skillSchema = z.object({
  name: text(100),
  category: text(100).nullable().default(null),
  proficiency: text(200).nullable().default(null),
  evidence: list(6, 500).default([]),
}).strict();
export type CareerProfileInput = z.input<typeof careerProfileSchema>;
export type ProjectInput = z.input<typeof projectSchema>;
export type SkillInput = z.input<typeof skillSchema>;
