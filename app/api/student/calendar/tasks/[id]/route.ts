import { calendarHttp } from "@/server/calendar/http";
export const runtime = "nodejs";
export async function GET(request: Request, context: {
    params: Promise<{
        id: string;
    }>;
}) { return calendarHttp.task(request, (await context.params).id); }
export async function PATCH(request: Request, context: {
    params: Promise<{
        id: string;
    }>;
}) { return calendarHttp.schedule(request, (await context.params).id); }
export async function POST(request: Request, context: {
    params: Promise<{
        id: string;
    }>;
}) { return calendarHttp.mutate(request, (await context.params).id); }
