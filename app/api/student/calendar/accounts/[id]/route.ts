import { calendarHttp } from "@/server/calendar/http";
export const runtime = "nodejs";
export async function GET(request: Request, context: {
    params: Promise<{
        id: string;
    }>;
}) { return calendarHttp.settings(request, (await context.params).id); }
export async function PUT(request: Request, context: {
    params: Promise<{
        id: string;
    }>;
}) { return calendarHttp.select(request, (await context.params).id); }
