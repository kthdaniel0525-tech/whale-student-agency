import { api } from "@/server/api";
import { listDocuments } from "@/server/documents/service";
import { acceptUpload } from "@/server/documents/upload";
import { z } from "zod";
export function GET(request: Request) {
  return api(request, async (userId) => {
    const input = z
      .object({ courseId: z.string().min(1).max(100).optional() })
      .strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    return listDocuments(userId, input.courseId);
  });
}
export function POST(request: Request) {
  return api(request, (userId) => acceptUpload(request, userId));
}
