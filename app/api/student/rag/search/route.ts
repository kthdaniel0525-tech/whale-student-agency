import { api, readJson } from "@/server/api";
import { retrievalSchema } from "@/features/documents/validation/schemas";
import { retrieveAcademicContext } from "@/server/documents/retrieval";
export function POST(req: Request) {
  return api(req, async (userId) => ({
    results: await retrieveAcademicContext(
      userId,
      await readJson(req, retrievalSchema),
    ),
  }));
}
