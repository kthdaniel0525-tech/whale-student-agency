"use client";

import { useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
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
import type { ConversationRecord } from "@/server/conversations/types";

export function ConversationManager({ initial }: { initial: ConversationRecord[] }) {
  const [items, setItems] = useState(initial);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<{ id: string; message: string }>();

  async function remove(id: string) {
    setBusyId(id); setError(undefined);
    try {
      await request<{ success: true }>(`/api/student/assistant/conversations/${encodeURIComponent(id)}`, "DELETE");
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (cause) { setError({ id, message: cause instanceof Error ? cause.message : "Conversation could not be deleted." }); throw cause; }
    finally { setBusyId(undefined); }
  }

  return (
    <section className="panel mt-6 max-w-4xl" aria-labelledby="conversation-data-heading">
      <p className="eyebrow">Conversation data</p>
      <h2 id="conversation-data-heading">AI conversations</h2>
      <p className="mt-2 text-sm text-muted-foreground">Open or permanently delete recent conversations. Deleting one removes its messages, summary, and owned conversation vectors. Conversation archive is not supported.</p>
      {error && <p className="field-error mt-3" role="alert">{error.message}</p>}
      {items.length ? <ul className="mt-4 divide-y rounded-lg border" aria-label="AI conversations">{items.map((conversation) => <li key={conversation.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><Link className="font-medium text-primary underline underline-offset-4" href={`/student/assistant?conversationId=${encodeURIComponent(conversation.id)}`}>{conversation.title || "Untitled conversation"}</Link><p className="mt-1 text-xs text-muted-foreground">{conversation.messageCount} messages · Updated {new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(conversation.lastMessageAt))}</p></div><AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="ghost" disabled={busyId === conversation.id}><Trash2 aria-hidden="true" />Delete</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete this conversation?</AlertDialogTitle><AlertDialogDescription>Its messages, summary, feedback links, and conversation search vectors will be removed. This cannot be undone.</AlertDialogDescription></AlertDialogHeader>{error?.id === conversation.id && <p role="alert" className="field-error">{error.message}</p>}<AlertDialogFooter><AlertDialogCancel disabled={busyId === conversation.id}>Keep conversation</AlertDialogCancel><Button variant="destructive" disabled={busyId === conversation.id} onClick={() => void remove(conversation.id).catch(() => undefined)}>{busyId === conversation.id ? "Deleting…" : "Delete conversation"}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog></li>)}</ul> : <p className="mt-4 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No saved conversations.</p>}
    </section>
  );
}
