"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/student/client";
import type { CalendarTaskOptions } from "@/lib/student/calendar/types";
export function CalendarTaskActions({ taskId, date, title }: {
    taskId: string;
    date: string;
    title: string;
}) {
    const [data, setData] = useState<CalendarTaskOptions>();
    const [expanded, setExpanded] = useState(false);
    const [target, setTarget] = useState("");
    const [local, setLocal] = useState(`${date}T18:00`);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const path = `/api/student/calendar/tasks/${encodeURIComponent(taskId)}`;
    async function load() {
        const result = await request<CalendarTaskOptions>(path, "GET");
        setData(result);
        if (result.scheduledStart) {
            const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: result.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(result.scheduledStart)).map(part => [part.type, part.value]));
            setLocal(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`);
        }
        return result;
    }
    async function run(fn: () => Promise<unknown>) { setBusy(true); setError(""); try {
        await fn();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Calendar action failed.");
    }
    finally {
        setBusy(false);
    } }
    async function mutate(action: "create" | "update" | "remove", connectedAccountId: string, calendarId: string) { await request(path, "POST", { action, connectedAccountId, calendarId, confirmed: true }); await load(); setMessage(action === "remove" ? "Removed from Google Calendar. Your study task is still here." : action === "update" ? "Calendar event checked and updated if still available." : "Added to Google Calendar."); }
    return <div className="mt-2">
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setExpanded(!expanded); if (!data)
        void run(load); }}>Calendar options</Button>
    {expanded && data && <div className="mt-2 space-y-3 rounded-lg border p-3" aria-label={`Calendar for ${title}`}>
      <p className="text-xs text-muted-foreground">{data.scheduledStart ? `${new Date(data.scheduledStart).toLocaleString(undefined, { timeZone: data.timezone })} – ${new Date(data.scheduledEnd!).toLocaleTimeString(undefined, { timeZone: data.timezone, hour: "2-digit", minute: "2-digit" })}` : "Choose a time for this study session."} ({data.timezone})</p>
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 text-sm">Study session time<input aria-label="Study session time" type="datetime-local" className="mt-1 block max-w-full rounded border bg-background p-2" value={local} onChange={e => setLocal(e.target.value)}/></label><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { setData(await request<CalendarTaskOptions>(path, "PATCH", { localStart: local })); setMessage("Study time saved. Existing Google events change only when you choose Update."); })}>Save study time</Button></div>
      {data.targets.length > 0 ? <div className="flex flex-wrap gap-2"><select aria-label="Calendar destination" className="min-w-0 max-w-full rounded border bg-background p-2 text-sm" value={target} onChange={e => setTarget(e.target.value)}><option value="">Choose a calendar</option>{data.targets.map((t, i) => <option key={i} value={String(i)}>{t.label}</option>)}</select><Button size="sm" disabled={busy || target === "" || !data.scheduledStart} onClick={() => void run(() => { const t = data.targets[Number(target)]; return mutate("create", t.connectedAccountId, t.calendarId); })}>Add to Google Calendar</Button></div> : <p className="text-sm"><Link className="underline" href="/student/settings#integrations">Enable Calendar write access and select a calendar</Link> to add this session.</p>}
      {data.links.map(link => <div key={link.id} className="flex flex-wrap items-center gap-2 text-sm"><span>{link.status === "LINKED" ? link.needsUpdate ? "Calendar event needs an explicit update" : "Added to Google Calendar" : link.status === "MISSING" ? "Event was removed in Google Calendar" : link.status === "REMOVED" ? "Removed from Google Calendar" : "Calendar write pending — retry Add to finish"}</span>
        {link.openUrl && <a href={link.openUrl} target="_blank" rel="noopener noreferrer" className="underline">Open Calendar</a>}
        {link.status === "LINKED" && <><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => mutate("update", link.connectedAccountId, link.calendarId))}>Update Calendar event</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => mutate("remove", link.connectedAccountId, link.calendarId))}>Remove from Google Calendar</Button></>}
      </div>)}
    </div>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}<p role="status" className="mt-1 text-xs text-muted-foreground">{busy ? "Checking Calendar…" : message}</p>
  </div>;
}
