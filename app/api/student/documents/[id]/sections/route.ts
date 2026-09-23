import { api } from "@/server/api";
import { documentSections } from "@/server/documents/retrieval";
import { sectionSchema } from "@/features/documents/validation/schemas";
export function GET(req: Request, c: { params: Promise<{ id: string }> }) {
  return api(req, async (userId) => {
    const input = sectionSchema.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    return documentSections(
      userId,
      (await c.params).id,
      input.fromPage,
      input.toPage,
    );
  });
}
