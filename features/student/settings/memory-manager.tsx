"use client";

import { useState } from "react";
import { Archive, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { request } from "@/lib/student/client";
import type { MemoryRecord } from "@/server/memory/types";

function displayValue(value: MemoryRecord["value"]) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function MemoryManager({ initial }: { initial: MemoryRecord[] }) {
  const [items, setItems] = useState(initial);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<{ id: string; message: string }>();

  async function archive(id: string) {
    setBusyId(id); setError(undefined);
    try {
      const updated = await request<MemoryRecord>(`/api/student/memories/${encodeURIComponent(id)}`, "PATCH", { action: "archive" });
      setItems((current) => current.map((item) => item.id === id ? updated : item));
    } catch (cause) { setError({ id, message: cause instanceof Error ? cause.message : "Memory could not be archived." }); }
    finally { setBusyId(undefined); }
  }

  async function remove(id: string) {
    setBusyId(id); setError(undefined);
    try {
      await request<{ success: true }>(`/api/student/memories/${encodeURIComponent(id)}`, "DELETE");
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (cause) { setError({ id, message: cause instanceof Error ? cause.message : "Memory could not be deleted." }); throw cause; }
    finally { setBusyId(undefined); }
  }

  return (
    <div className="mt-5" aria-labelledby="saved-memory-heading">
      <div className="flex items-end justify-between gap-3"><div><h3 id="saved-memory-heading" className="font-semibold">Saved memory</h3><p className="text-sm text-muted-foreground">Archived items stay stored but are excluded from active personalization.</p></div><span className="text-sm text-muted-foreground">{items.length} saved</span></div>
      {error && <p className="field-error mt-3" role="alert">{error.message}</p>}
      {items.length ? <ul className="mt-4 divide-y rounded-lg border" aria-label="Saved memories">{items.map((memory) => <li key={memory.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="break-words">{memory.key}</strong><span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{memory.category}</span><span className="text-xs capitalize text-muted-foreground">{memory.status}</span></div><p className="mt-1 break-words text-sm">{displayValue(memory.value)}</p><p className="mt-1 text-xs text-muted-foreground">{memory.explanation}</p></div><div className="flex shrink-0 flex-wrap gap-2">{memory.status !== "archived" && <Button size="sm" variant="outline" disabled={busyId === memory.id} onClick={() => void archive(memory.id)}><Archive aria-hidden="true" />{busyId === memory.id ? "Archiving…" : "Archive"}</Button>}<AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="ghost" disabled={busyId === memory.id}><Trash2 aria-hidden="true" />Delete</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete this saved memory?</AlertDialogTitle><AlertDialogDescription>It will be removed from personalization along with its supporting observations. This cannot be undone.</AlertDialogDescription></AlertDialogHeader>{error?.id === memory.id && <p role="alert" className="field-error">{error.message}</p>}<AlertDialogFooter><AlertDialogCancel disabled={busyId === memory.id}>Keep memory</AlertDialogCancel><Button variant="destructive" disabled={busyId === memory.id} onClick={() => void remove(memory.id).catch(() => undefined)}>{busyId === memory.id ? "Deleting…" : "Delete memory"}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog></div></li>)}</ul> : <p className="mt-4 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No saved long-term memory.</p>}
    </div>
  );
}
