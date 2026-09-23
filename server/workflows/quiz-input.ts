import "server-only";
import { z } from "zod";
const id = z.string().min(1).max(100);
export const workflowResumeSchema = z.object({ runId: id, quizAttemptId: id }).strict();
export const workflowAnswerSchema = z.object({ runId: id, questionId: id, userAnswer: z.string().trim().min(1).max(4000), quizAttemptId: id.optional() }).strict();
