"use client";
import { INTEGRATION_HEALTH_LABELS } from "@/lib/student/integrations/health";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/student/client";
import type { CalendarSettings } from "@/lib/student/calendar/types";
import type { ConnectedAccountView, IntegrationCapability } from "@/lib/student/integrations/types";
export function CalendarSettingsPanel({ account, enable, disabled }: {
    account: ConnectedAccountView;
    enable: (capabilities: IntegrationCapability[]) => void;
    disabled: boolean;
}) {
    const [data, setData] = useState<CalendarSettings>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const canRead = account.capabilities.includes("calendar-read"), canWrite = account.capabilities.includes("calendar-write");
    const path = `/api/student/calendar/accounts/${encodeURIComponent(account.id)}`;
    async function load(discover = true) { setBusy(true); setError(""); try {
        setData(await request<CalendarSettings>(`${path}${discover ? "?discover=true" : ""}`, "GET"));
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Could not load calendars.");
    }
    finally {
        setBusy(false);
    } }
    async function save() { if (!data)
        return; setBusy(true); setError(""); try {
        await request(path, "PUT", { calendars: data.calendars.filter(c => c.enabledForAvailability || c.allowStudyWrites).map(c => ({ id: c.id, enabledForAvailability: c.enabledForAvailability, allowStudyWrites: c.allowStudyWrites, blockAllDay: c.blockAllDay })) });
        setMessage("Calendar selection saved. An initial refresh is queued.");
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Could not save calendars.");
    }
    finally {
        setBusy(false);
    } }
    async function refresh() { setBusy(true); setError(""); try {
        await request(`${path}/refresh`, "POST");
        setMessage("Calendar refresh queued. Check sync status in a moment.");
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Could not refresh.");
    }
    finally {
        setBusy(false);
    } }
    function check(id: string, key: "enabledForAvailability" | "allowStudyWrites" | "blockAllDay", value: boolean) { setData(previous => previous ? { ...previous, calendars: previous.calendars.map(c => c.id === id ? { ...c, [key]: value } : c) } : previous); }
    return <div className="mt-4 rounded-lg bg-muted/40 p-3" aria-label="Google Calendar settings">
    <h5 className="font-medium">Google Calendar</h5><p className="mt-1 text-sm text-muted-foreground">{canRead ? "Read access enabled" : "Calendar reading is not enabled"} · {canWrite ? "Write access enabled" : "Write access not enabled"}</p>
    <div className="mt-3 flex flex-wrap gap-2">{!canRead ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => enable(["calendar-read"])}>Enable Calendar reading</Button> : <><Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void load()}>Manage calendars</Button><Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void refresh()}>Refresh Calendar</Button></>}
      {canRead && !canWrite && <Button size="sm" variant="outline" disabled={disabled} onClick={() => enable(["calendar-read", "calendar-write"])}>Enable Calendar write access</Button>}
    </div>
    <p className="mt-2 text-xs text-muted-foreground">Only selected calendars affect study availability. Adding, updating, or removing study events always requires your action.</p>
    {data && <div className="mt-3 space-y-3">{data.calendars.length === 0 && <p className="text-sm">No readable calendars found.</p>}{data.calendars.map(c => <fieldset key={c.id} className="rounded-lg border p-3" disabled={busy}><legend className="max-w-full break-words px-1 text-sm font-medium">{c.title}</legend>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={c.enabledForAvailability} onChange={e => check(c.id, "enabledForAvailability", e.target.checked)}/>Use for availability</label>
      {c.enabledForAvailability && <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={c.blockAllDay} onChange={e => check(c.id, "blockAllDay", e.target.checked)}/>Block all-day events</label>}
      {canWrite && c.canWrite && <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={c.allowStudyWrites} onChange={e => check(c.id, "allowStudyWrites", e.target.checked)}/>Allow study events in this calendar</label>}
    </fieldset>)}<Button size="sm" disabled={busy} onClick={() => void save()}>Save calendars</Button>
      <p className="text-xs text-muted-foreground">Sync: {data.health ? INTEGRATION_HEALTH_LABELS[data.health.state] : "Not synced yet"} · Last success: {data.sync?.lastSuccessfulSyncAt ? new Date(data.sync.lastSuccessfulSyncAt).toLocaleString() : "never"}</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => void load(false)}>Check sync status</Button>
    </div>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}<p role="status" className="mt-2 text-sm">{busy ? "Updating Calendar…" : message}</p>
  </div>;
}
