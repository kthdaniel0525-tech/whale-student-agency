"use client";
import { useEffect, useEffectEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, Clock3, ArrowUpRight, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NotificationItem, NotificationPage } from "@/server/notifications/types";
async function json<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Unable to update notifications. Try again.");
  return body as T;
}
export function NotificationCenter({ initial }: { initial: NotificationPage }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const changed = () => window.dispatchEvent(new Event("notifications-changed"));
  async function load(nextFilter = filter, cursor?: string) {
    const query = new URLSearchParams({ status: nextFilter, ...(cursor ? { cursor } : {}) });
    const result = await json<NotificationPage>(await fetch(`/api/student/notifications?${query}`, { cache: "no-store" }));
    setData((previous) => ({ ...result, notifications: cursor ? [...previous.notifications, ...result.notifications.filter((item) => !previous.notifications.some((old) => old.id === item.id))] : result.notifications }));
    changed();
  }
  const refreshOnFocus = useEffectEvent(() => { if (!busy) load().catch(() => undefined); });
  useEffect(() => {
    const refresh = () => refreshOnFocus();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  async function run(operation: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again."); }
    finally { setBusy(false); }
  }
  async function update(item: NotificationItem, operation: "read" | "dismiss" | "snooze") {
    const previous = data;
    // Only reversible read/dismiss presentation is optimistic; failures restore it.
    if (operation !== "snooze") setData({ ...data,
      unreadCount: Math.max(0, data.unreadCount - Number(item.status === "delivered")),
      notifications: data.notifications.map((row) => row.id === item.id
        ? { ...row, status: operation === "read" ? "read" : "dismissed", ...(operation === "dismiss" ? { canSnooze: false, actionLabel: null } : {}) } : row),
    });
    try {
      await json(await fetch(`/api/student/notifications/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, ...(operation === "snooze" ? { until: new Date(Date.now() + 3600000).toISOString() } : {}) }) }));
    } catch (cause) { setData(previous); throw cause; }
    changed();
    await load();
  }
  const displayed = data.notifications.filter((row) => filter !== "unread" || row.status === "delivered");
  return <div className="mx-auto max-w-3xl space-y-6 py-2">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="eyebrow text-muted-foreground">Your study updates</p><h1 className="text-3xl font-semibold tracking-tight">Notifications</h1><p className="mt-2 text-sm text-muted-foreground">Timely reminders for the work that matters. {data.unreadCount} unread.</p></div>
      <Button variant="outline" disabled={busy} onClick={() => run(() => load())}><RefreshCw size={16} /> Refresh</Button></header>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2" aria-label="Notification filters">
      {(["all", "unread"] as const).map((value) => <Button key={value} variant={filter === value ? "default" : "outline"} aria-pressed={filter === value} disabled={busy} onClick={() => run(async () => { await load(value); setFilter(value); })}>{value === "all" ? "All" : "Unread"}</Button>)}
    </div><Button variant="ghost" disabled={busy || data.unreadCount === 0} onClick={() => run(async () => {
      await json(await fetch("/api/student/notifications/read-all", { method: "POST" })); await load();
    })}><Check size={16} /> Mark all read</Button></div>
    {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">{error}</p>}
    <section aria-label="Notifications" aria-busy={busy} className="space-y-3">
      {displayed.map((item) => <article key={item.id} aria-label={item.title} className={`rounded-2xl border bg-card p-5 shadow-sm ${item.status === "delivered" ? "border-primary/40" : "border-border"}`}>
        <div className="flex items-start justify-between gap-3"><div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full px-2.5 py-1 font-medium ${["high", "critical"].includes(item.priority) ? "bg-amber-500/15 text-amber-800 dark:text-amber-200" : "bg-secondary text-secondary-foreground"}`}>{item.priority === "critical" ? "Time-sensitive" : `${item.priority[0].toUpperCase()}${item.priority.slice(1)} priority`}</span>
          {item.status === "delivered" && <span className="font-medium text-primary">Unread</span>}
          {item.status === "dismissed" && <span className="text-muted-foreground">Handled</span>}
        </div><time dateTime={item.deliveredAt} className="text-xs text-muted-foreground" suppressHydrationWarning>{new Date(item.deliveredAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></div>
        <h2 className="mt-3 text-base font-semibold">{item.title}</h2><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.message}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {item.actionLabel && <Button size="sm" disabled={busy} onClick={() => run(async () => {
            try {
              const result = await json<{ href: string }>(await fetch(`/api/student/notifications/${item.id}/action`, { method: "POST" })); changed(); router.push(result.href);
            } catch (cause) { await load(); throw cause; }
          })}>{item.actionLabel}<ArrowUpRight size={15} /></Button>}
          {item.status === "delivered" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => update(item, "read"))}><Check size={15} />Mark read</Button>}
          {item.canSnooze && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => update(item, "snooze"))}><Clock3 size={15} />Snooze 1 hour</Button>}
          {item.status !== "dismissed" && <Button size="sm" variant="ghost" disabled={busy} aria-label={`Dismiss ${item.title}`} onClick={() => run(() => update(item, "dismiss"))}><X size={15} />Dismiss</Button>}
          {!item.actionLabel && item.status !== "dismissed" && <span className="text-xs text-muted-foreground">This reminder no longer needs action.</span>}
        </div>
      </article>)}
      {!displayed.length && <div className="rounded-2xl border bg-card px-6 py-16 text-center"><Bell className="mx-auto mb-4 text-muted-foreground" /><h2 className="font-semibold">You’re all caught up</h2><p className="mt-2 text-sm text-muted-foreground">{filter === "unread" ? "No unread notifications." : "Your timely study reminders will appear here."}</p></div>}
    </section>
    {data.nextCursor && <Button variant="outline" disabled={busy} onClick={() => run(() => load(filter, data.nextCursor!))}>Load earlier notifications</Button>}
  </div>;
}
