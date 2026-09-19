import { z } from "zod";
import { api } from "@/server/api";
import { getAgentUsage, getDailyUsage, getModelUsage, getOperationUsage, getRequestUsage, getUserUsageSummary, getWorkflowUsage } from "@/server/ai/usage/analytics";

const querySchema = z.object({
  group: z.enum(["summary", "agent", "workflow", "model", "operation", "day", "request"]).default("summary"),
  start: z.string().datetime().optional(), end: z.string().datetime().optional(),
  requestId: z.string().min(1).max(200).optional(),
}).strict().refine(q => (!q.start || !q.end || new Date(q.start) < new Date(q.end)) && (q.group !== "request" || !!q.requestId));
export async function GET(request: Request) {
  return api(request, async userId => {
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    if (query.group === "summary") return getUserUsageSummary(userId);
    if (query.group === "request") return getRequestUsage(userId, query.requestId!);
    const start = query.start ? new Date(query.start) : undefined;
    const end = query.end ? new Date(query.end) : undefined;
    if (query.group === "day") z.number().max(366 * 86400000).parse((end ?? new Date()).getTime() - (start ?? new Date(Date.now() - 30 * 86400000)).getTime());
    return { agent: getAgentUsage, workflow: getWorkflowUsage, model: getModelUsage, operation: getOperationUsage, day: getDailyUsage }[query.group]({ userId, start, end });
  }, false);
}
