import { api } from "@/server/api";
import { getStudentProgress, type ProgressRange } from "@/server/progress";

const ranges = new Set<ProgressRange>(["7d", "30d", "semester"]);

export function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("range") as ProgressRange | null;
  const range = requested && ranges.has(requested) ? requested : "semester";
  return api(request, (userId) => getStudentProgress(userId, request.headers, { range }));
}
