import { calendarHttp } from "@/server/calendar/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: {
    params: Promise<{
        id: string;
    }>;
}) { return calendarHttp.refresh(request, (await context.params).id); }
