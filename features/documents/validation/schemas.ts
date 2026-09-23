import { z } from "zod";
const id = z.string().min(1).max(100);
export const uploadMetadata = z
  .object({ title: z.string().trim().min(1).max(200), courseId: id.optional() })
  .strict();
export const retrievalSchema = z
  .object({
    query: z.string().trim().min(3).max(1000),
    courseId: id.optional(),
    documentIds: z.array(id).min(1).max(20).optional(),
    maxResults: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export const sectionSchema = z
  .object({
    fromPage: z.coerce.number().int().min(1).default(1),
    toPage: z.coerce.number().int().min(1).max(200).default(10),
  })
  .strict()
  .refine(
    (v) => v.toPage >= v.fromPage && v.toPage - v.fromPage < 20,
    "Request up to 20 consecutive pages.",
  );
