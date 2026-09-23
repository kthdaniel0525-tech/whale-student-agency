import { api, readJson } from "@/server/api";
import { productFeedbackSchema } from "@/lib/product-analytics/feedback";
import { createProductFeedback, dismissFeedbackPrompt, feedbackPrompt } from "@/server/beta/feedback";
export function POST(request: Request) { return api(request, async userId => createProductFeedback(userId, await readJson(request, productFeedbackSchema)), false); }
export function GET(request: Request) { return api(request, feedbackPrompt, false); }
export function DELETE(request: Request) { return api(request, dismissFeedbackPrompt, false); }
