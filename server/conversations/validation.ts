import { z } from "zod";
import { CONVERSATION_CONFIG } from "./config";

export const conversationIdSchema = z.string().min(1).max(100);
export const conversationRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "internal",
]);
export const conversationMetadataSchema = z
  .record(z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 20)
  .refine(
    (value) =>
      !Object.keys(value).some((key) =>
        /chain.?of.?thought|private.?reasoning|internal.?reasoning/i.test(key),
      ),
    "Private model reasoning cannot be stored.",
  );

export const createConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    courseId: conversationIdSchema.optional(),
  })
  .strict();

export const appendConversationMessageSchema = z
  .object({
    conversationId: conversationIdSchema,
    role: conversationRoleSchema,
    content: z
      .string()
      .trim()
      .min(1)
      .max(CONVERSATION_CONFIG.maximumMessageCharacters),
    turnId: conversationIdSchema.optional(),
    agentId: z.string().min(1).max(100).optional(),
    metadata: conversationMetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.role !== "assistant" && value.agentId) {
      context.addIssue({
        code: "custom",
        path: ["agentId"],
        message: "Only assistant messages have an agent ID.",
      });
    }
  });
