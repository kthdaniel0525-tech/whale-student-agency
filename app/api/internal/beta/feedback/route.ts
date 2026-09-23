import { api } from "@/server/api";
import { listPrivateFeedback } from "@/server/beta/feedback";
import { z } from "zod";
export function GET(request: Request) { return api(request, async userId => listPrivateFeedback(userId, z.string().max(100).optional().parse(new URL(request.url).searchParams.get("cursor") ?? undefined)), false); }
