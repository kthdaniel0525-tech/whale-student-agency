import { z } from "zod";
import { isValidTimezone } from "@/lib/student/timezone";
const text = (max: number) =>
  z.string().trim().min(1, "This field is required.").max(max);
const optionalText = (max: number) => z.string().trim().max(max).default("");
export const profileSchema = z
  .object({
    name: text(100),
    school: text(160),
    program: text(160),
    currentYear: z.number().int().min(1).max(12),
    semester: text(80),
    academicGoal: text(1000),
    studySessionMinutes: z.number().int().min(10).max(180),
    explanationDifficulty: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]),
    timezone: z.string().trim().max(100).refine(isValidTimezone, "Choose a valid IANA timezone."),
  })
  .strict();
export const courseSchema = z
  .object({
    courseCode: text(30),
    courseName: text(160),
    professor: optionalText(160),
    semester: text(80),
    description: optionalText(3000),
  })
  .strict();
const date = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= 2000 && year <= 2100;
  }, "Choose a date between 2000 and 2100.");
export const assignmentSchema = z
  .object({
    title: text(200),
    description: optionalText(5000),
    dueDate: date,
    status: z.enum(["TODO", "IN_PROGRESS", "COMPLETED"]),
    priority: z.enum(["LOW", "MEDIUM", "HIGH"]),
    estimatedHours: z.number().finite().min(0).max(1000),
  })
  .strict();
export const statusSchema = z
  .object({ status: assignmentSchema.shape.status })
  .strict();
export const examSchema = z
  .object({
    title: text(200),
    examDate: date,
    topics: z.array(text(120)).max(40),
    notes: optionalText(5000),
  })
  .strict();
export const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(128),
});
export type CourseInput = z.infer<typeof courseSchema>;
export type AssignmentInput = z.infer<typeof assignmentSchema>;
export type ExamInput = z.infer<typeof examSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
