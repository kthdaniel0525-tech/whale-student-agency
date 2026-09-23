"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Clock3, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { FormError, request } from "@/lib/student/client";
import { formatQuietTime, LEAD_TIME_OPTIONS, notificationPreferenceSchema, type NotificationPreferences, type NotificationPreferenceInput } from "@/lib/student/notification-preferences";

type ToggleKey = "remindersEnabled" | "inAppEnabled" | "assignmentReminders" | "examReminders" | "studyReminders" | "workflowReminders" | "proactiveRecommendationsEnabled" | "quietHoursEnabled";
function Toggle({ name, label, description, checked, onChange }: { name: string; label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex items-center justify-between gap-5 py-4"><div className="min-w-0"><label htmlFor={`automation-${name}`} className="block text-sm font-medium">{label}</label><p id={`automation-${name}-description`} className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p></div>
    <input id={`automation-${name}`} name={name} type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} aria-describedby={`automation-${name}-description`}
      className="relative h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-full border border-border bg-muted transition-colors before:absolute before:left-0.5 before:top-0.5 before:h-4 before:w-4 before:rounded-full before:bg-background before:shadow-sm before:transition-transform checked:border-primary checked:bg-primary checked:before:translate-x-5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary disabled:cursor-wait" />
  </div>;
}
export function NotificationSettings({ initial }: { initial: NotificationPreferences }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [start, setStart] = useState(formatQuietTime(initial.quietHoursStart));
  const [end, setEnd] = useState(formatQuietTime(initial.quietHoursEnd));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [success, setSuccess] = useState(false);
  const changed = () => { setSuccess(false); setError(""); };
  function toggle(name: ToggleKey, value: boolean) {
    changed(); setDraft((previous) => ({ ...previous, [name]: value }));
    if (name === "quietHoursEnabled" && value) { if (!start) setStart("22:00"); if (!end) setEnd("08:00"); }
  }
  function control(name: ToggleKey, label: string, description: string) {
    return <Toggle name={name} label={label} description={description} checked={draft[name]} onChange={(value) => toggle(name, value)} />;
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setFields({}); setSuccess(false);
    const parsed = notificationPreferenceSchema.safeParse({ ...draft, quietHoursStart: start || null, quietHoursEnd: end || null });
    if (!parsed.success) { setFields(parsed.error.flatten().fieldErrors); setError("Please check the highlighted settings."); return; }
    const data = parsed.data;
    if (data.quietHoursEnabled && (!start || !end || start === end)) {
      setFields({ quietHoursEnd: ["Choose a start and a different end time."] }); setError("Please check your quiet hours."); return;
    }
    // Send only edited fields so a stale form cannot overwrite unrelated settings
    // saved from another device. Timezone is edited in the existing profile form.
    const patch = Object.fromEntries(Object.entries(data).filter(([key, value]) => key !== "timezone" && value !== saved[key as keyof NotificationPreferences])) as NotificationPreferenceInput;
    setBusy(true);
    try {
      const result = await request<NotificationPreferences>("/api/student/notification-preferences", "PATCH", patch);
      setSaved(result); setDraft(result); setStart(formatQuietTime(result.quietHoursStart)); setEnd(formatQuietTime(result.quietHoursEnd));
      setSuccess(true); router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your settings could not be saved.");
      if (cause instanceof FormError) setFields(cause.fields);
    } finally { setBusy(false); }
  }
  return <section className="panel mt-6 max-w-4xl" aria-labelledby="notification-settings-title">
    <div className="flex items-start justify-between gap-4"><div><p className="eyebrow">Your preferences</p><h2 id="notification-settings-title" className="mt-1">Notifications &amp; Automation</h2><p className="mt-2 text-sm text-muted-foreground">Choose the reminders and suggestions that fit your study routine.</p></div><Bell size={22} className="shrink-0 text-primary" /></div>
    <form onSubmit={submit} noValidate className="mt-6">
      <fieldset disabled={busy} className="min-w-0">
        <legend className="sr-only">Notification and automation preferences</legend>
        <div className="rounded-xl border bg-background px-4 sm:px-5"><h3 className="pt-5 text-sm font-semibold">Notifications</h3>
          {control("inAppEnabled", "In-app notifications", "Add new notifications to your notification center. Your existing history stays available.")}
        </div>
        <div className="mt-5 rounded-xl border bg-background px-4 sm:px-5"><h3 className="pt-5 text-sm font-semibold">Academic reminders</h3>
          {control("remindersEnabled", "Enable reminders", "Stay aware of important academic work. Turning this off pauses all reminder categories.")}
          {!draft.remindersEnabled && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Reminders are paused. Your category choices are saved for when you turn them back on.</p>}
          <div className="divide-y border-t">
            {control("assignmentReminders", "Assignments", "Due dates and overdue work that still needs attention.")}
            {control("examReminders", "Exams", "Upcoming exams and relevant review or diagnostic practice.")}
            {control("studyReminders", "Study sessions", "Scheduled sessions, important missed tasks, and plans falling behind.")}
            {control("workflowReminders", "Workflow follow-ups", "Guided activities waiting for your quiz answers, draft, or other input.")}
          </div>
        </div>
        <div className="mt-5 rounded-xl border bg-background p-4 sm:p-5"><h3 className="flex items-center gap-2 text-sm font-semibold"><Clock3 size={16} /> Timing</h3>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <div className="field"><label htmlFor="reminder-lead-time">Study reminder lead time</label><NativeSelect id="reminder-lead-time" value={draft.leadTimeMinutes} aria-describedby={fields.leadTimeMinutes ? "reminder-lead-description reminder-lead-error" : "reminder-lead-description"} aria-invalid={Boolean(fields.leadTimeMinutes)} onChange={(event) => { changed(); setDraft({ ...draft, leadTimeMinutes: Number(event.target.value) }); }}>
              {!LEAD_TIME_OPTIONS.some((value) => value === draft.leadTimeMinutes) && <option value={draft.leadTimeMinutes}>{draft.leadTimeMinutes} minutes</option>}
              {LEAD_TIME_OPTIONS.map((value) => <option key={value} value={value}>{value < 60 ? `${value} minutes` : `${value / 60} ${value === 60 ? "hour" : "hours"}`}</option>)}
            </NativeSelect><p id="reminder-lead-description" className="mt-1 text-xs text-muted-foreground">Study reminders become ready {draft.leadTimeMinutes} minutes before a timed session. Assignment and exam reminders use deadline-based timing.</p>{fields.leadTimeMinutes && <p id="reminder-lead-error" className="field-error">{fields.leadTimeMinutes[0]}</p>}</div>
            <div className="field"><label htmlFor="notification-frequency">Notification frequency</label><NativeSelect id="notification-frequency" value={draft.notificationFrequency} aria-describedby="notification-frequency-description" onChange={(event) => { changed(); setDraft({ ...draft, notificationFrequency: event.target.value as NotificationPreferences["notificationFrequency"] }); }}>
              <option value="AS_READY">As reminders become ready</option><option value="HOURLY">At the next hour</option>
            </NativeSelect><p id="notification-frequency-description" className="mt-1 text-xs text-muted-foreground">“At the next hour” holds newly ready notifications until the next hour in your timezone. They may appear a few minutes after the hour.</p></div>
          </div>
          <div className="mt-4 border-t">{control("quietHoursEnabled", "Quiet hours", "In-app notifications are saved silently. Quiet hours reserve uninterrupted time for any future alerts that interrupt you.")}</div>
          {draft.quietHoursEnabled && <div className="grid gap-4 sm:grid-cols-2">
            <div className="field"><label htmlFor="quiet-hours-start">Quiet hours start</label><Input id="quiet-hours-start" type="time" value={start} onChange={(event) => { changed(); setStart(event.target.value); }} aria-invalid={Boolean(fields.quietHoursStart)} aria-describedby={fields.quietHoursStart ? "quiet-hours-start-error" : "quiet-hours-note"} />{fields.quietHoursStart && <p id="quiet-hours-start-error" className="field-error">{fields.quietHoursStart[0]}</p>}</div>
            <div className="field"><label htmlFor="quiet-hours-end">Quiet hours end</label><Input id="quiet-hours-end" type="time" value={end} onChange={(event) => { changed(); setEnd(event.target.value); }} aria-invalid={Boolean(fields.quietHoursEnd)} aria-describedby={fields.quietHoursEnd ? "quiet-hours-end-error" : "quiet-hours-note"} />{fields.quietHoursEnd && <p id="quiet-hours-end-error" className="field-error">{fields.quietHoursEnd[0]}</p>}</div>
            <p id="quiet-hours-note" className="text-xs text-muted-foreground sm:col-span-2">Quiet hours may cross midnight. Urgent reminders will also respect this choice for interruptive alerts.</p>
          </div>}
          <p className="mt-4 text-sm text-muted-foreground">Timezone: <strong className="text-foreground">{initial.timezone}</strong>. <a href="#timezone" className="underline underline-offset-4">Change in Academic profile</a>.</p>
        </div>
        <div className="mt-5 rounded-xl border bg-background px-4 sm:px-5"><h3 className="flex items-center gap-2 pt-5 text-sm font-semibold"><Sparkles size={16} /> AI assistance</h3>
          {control("proactiveRecommendationsEnabled", "Proactive recommendations", "Show personalized suggestion cards. You can always ask the AI Assistant for help, even when this is off.")}
        </div>
        {error && <p role="alert" className="field-error mt-5">{error}</p>}
        <div className="mt-6 flex flex-wrap items-center gap-4"><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save notification settings"}</Button><span role="status" className="text-sm text-muted-foreground">{success ? "Settings saved." : busy ? "Saving your preferences…" : ""}</span></div>
      </fieldset>
    </form>
  </section>;
}
