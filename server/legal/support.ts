import "server-only";
import { z } from "zod";

const valueSchema = z.object({
  SUPPORT_CONTACT_LABEL: z.string().trim().min(2).max(80),
  SUPPORT_CONTACT_URL: z.string().trim().url().max(500).refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }),
}).strict();

export type PublicSupportContact =
  | { available: true; label: string; url: string }
  | { available: false; reason: "not-configured" | "invalid-configuration" };

/** Invalid or incomplete configuration never publishes a guessed contact. */
export function publicSupportContact(): PublicSupportContact {
  const label = process.env.SUPPORT_CONTACT_LABEL?.trim();
  const url = process.env.SUPPORT_CONTACT_URL?.trim();
  if (!label && !url) return { available: false, reason: "not-configured" };
  const parsed = valueSchema.safeParse({
    SUPPORT_CONTACT_LABEL: label,
    SUPPORT_CONTACT_URL: url,
  });
  if (!parsed.success) return { available: false, reason: "invalid-configuration" };
  return {
    available: true,
    label: parsed.data.SUPPORT_CONTACT_LABEL,
    url: parsed.data.SUPPORT_CONTACT_URL,
  };
}
