import { api } from "@/server/api";
import { getCareerWorkspace } from "@/server/career-workspace";

export function GET(request: Request) {
  return api(request, (userId) => getCareerWorkspace(userId, request.headers));
}
