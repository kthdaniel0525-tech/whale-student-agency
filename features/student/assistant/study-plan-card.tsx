"use client";

import { useState } from "react";
import { CalendarDays, Check, Clock3, Loader2, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantStudyPlan, AssistantStudyTask } from "./types";

function humanDate(value: string) {
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
}

export function StudyPlanCard({ initialPlan }: { initialPlan: AssistantStudyPlan }) {
  const [plan, setPlan] = useState(initialPlan);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const days = plan.days ?? (plan.sessions ? [{ date: plan.date ?? new Date().toISOString().slice(0, 10), totalMinutes: plan.totalMinutes ?? 0, sessions: plan.sessions as AssistantStudyTask[] }] : []);

  async function updateTask(taskId: string, status: "completed" | "skipped") {
    setBusy(taskId);
    setError(undefined);
    try {
      const response = await fetch(`/api/student/assistant/study-tasks/${taskId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      const body = await response.json() as AssistantStudyPlan & { error?: string };
      if (!response.ok) throw new Error(body.error || "The study task could not be updated.");
      setPlan(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The study task could not be updated.");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="assistant-artifact" aria-label="Study plan">
      <p className="eyebrow">Study plan</p>
      {plan.title && <h3 className="mt-1 text-lg font-semibold">{plan.title}</h3>}
      <p className="mt-2 text-sm muted">{plan.summary}</p>
      <div className="mt-3 flex flex-wrap gap-3 text-sm muted">
        {(plan.startDate || plan.date) && <span className="flex items-center gap-1"><CalendarDays size={15} /> {plan.startDate ? `${humanDate(plan.startDate)}${plan.endDate && plan.endDate !== plan.startDate ? ` – ${humanDate(plan.endDate)}` : ""}` : humanDate(plan.date!)}</span>}
        <span className="flex items-center gap-1"><Clock3 size={15} /> {plan.totalPlannedMinutes ?? plan.totalMinutes ?? 0} minutes</span>
      </div>
      <div className="mt-5 space-y-4">
        {days.map((day) => (
          <div key={day.date}>
            <div className="flex items-center justify-between border-b pb-2"><h4 className="font-medium">{humanDate(day.date)}</h4><span className="text-xs muted">{day.totalMinutes} min</span></div>
            <div className="divide-y">
              {day.sessions.map((task, index) => (
                <div key={task.id ?? `${day.date}-${index}`} className="py-3">
                  <div className="flex items-start gap-3">
                    <span className="assistant-activity">{task.activityType}</span>
                    <div className="min-w-0 flex-1"><p className="font-medium">{task.title}</p><p className="text-sm muted">{task.topic ?? task.courseName} · {task.durationMinutes} min</p><p className="mt-1 text-xs muted">{task.reason}</p></div>
                  </div>
                  {task.id && task.status !== "completed" && task.status !== "skipped" && (
                    <div className="mt-2 flex gap-2 pl-0 sm:pl-20">
                      <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => updateTask(task.id, "completed")}>{busy === task.id ? <Loader2 className="animate-spin" /> : <Check />} Complete</Button>
                      <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => updateTask(task.id, "skipped")}><SkipForward /> Skip</Button>
                    </div>
                  )}
                  {task.status === "completed" && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-300">Completed</p>}
                  {task.status === "skipped" && <p className="mt-2 text-sm muted">Skipped</p>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {plan.assumptions?.length ? <p className="mt-4 text-xs muted">Assumption: {plan.assumptions.join(" ")}</p> : null}
      {error && <p className="mt-4 text-sm text-destructive" role="alert">{error}</p>}
    </section>
  );
}
