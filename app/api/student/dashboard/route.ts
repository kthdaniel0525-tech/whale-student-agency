import { api } from "@/server/api";
import { dashboard } from "@/server/services/academic";
export function GET(req: Request) {
  return api(req, dashboard);
}
