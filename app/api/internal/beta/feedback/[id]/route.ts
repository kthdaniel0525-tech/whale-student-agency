import { api, readJson } from "@/server/api";
import { triageSchema } from "@/lib/product-analytics/feedback";
import { triageFeedback } from "@/server/beta/feedback";
export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) { return api(request, async userId => triageFeedback(userId, (await context.params).id, await readJson(request, triageSchema)), false); }
