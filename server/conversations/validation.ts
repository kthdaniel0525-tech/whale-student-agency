import { z } from "zod";
import { CONVERSATION_CONFIG } from "./config";

export const conversationIdSchema = z.string().min(1).max(100);
export const conversationRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "internal",
]);
const metadataValueSchema = z.union([
  // Rich presentation/source payloads are bounded by their dedicated parsers
  // below. Other metadata strings remain intentionally small.
  z.string().max(24_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const conversationMetadataSchema = z
  .record(metadataValueSchema)
  .refine((value) => Object.keys(value).length <= 20)
  .superRefine((value, context) => {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "string") continue;
      const maximum = key === "sourceRefs" ? 20_000
        : key === "presentationData" ? 24_000
          : 500;
      if (item.length > maximum) context.addIssue({
        code: "custom",
        path: [key],
        message: "Conversation metadata value is too large.",
      });
    }
  })
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
