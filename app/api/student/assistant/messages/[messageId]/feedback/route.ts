import { api, readJson } from "@/server/api";
import { feedbackSchema, getFeedback, submitFeedback } from "@/server/ai/evaluation/feedback";
type Context = { params: Promise<{ messageId: string }> };
export async function GET(request: Request, context: Context) { return api(request, async userId => getFeedback(userId, (await context.params).messageId)); }
export async function PUT(request: Request, context: Context) { return api(request, async userId => submitFeedback(userId, (await context.params).messageId, await readJson(request, feedbackSchema))); }
