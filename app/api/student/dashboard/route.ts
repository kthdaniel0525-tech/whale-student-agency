import { api } from "@/server/api";
import { getStudentDashboard } from "@/server/dashboard";

export function GET(request: Request) {
  return api(request, (userId) => getStudentDashboard(userId, request.headers));
}
