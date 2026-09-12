"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { request } from "@/lib/student/client";
export function DeleteItem({
  kind,
  id,
}: {
  kind: "course" | "assignment" | "exam";
  id: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ cleanupPending?: boolean }>(
        `/api/student/${kind}s/${id}`,
        "DELETE",
      );
      toast.success(
        result.cleanupPending
          ? `${kind} deleted. File cleanup is queued.`
          : `${kind} deleted.`,
      );
      setOpen(false);
      if (kind === "course") router.push("/student/courses");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to delete.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) setOpen(value);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Delete ${kind}`}>
          <Trash2 size={16} />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Delete this {kind}?</AlertDialogTitle>
        <AlertDialogDescription>
          {kind === "course"
            ? "Its assignments, exams, documents and indexed passages will also be permanently deleted."
            : "This cannot be undone."}
        </AlertDialogDescription>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep {kind}</AlertDialogCancel>
          <Button variant="destructive" onClick={remove} disabled={busy}>
            {busy ? "Deleting…" : `Delete ${kind}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
export function CompleteAssignment({
  id,
  completed,
}: {
  id: string;
  completed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try {
      await request(`/api/student/assignments/${id}`, "PATCH", {
        status: completed ? "TODO" : "COMPLETED",
      });
      toast.success(
        completed ? "Assignment reopened." : "Assignment completed.",
      );
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button
      variant={completed ? "secondary" : "outline"}
      size="sm"
      disabled={busy}
      onClick={toggle}
    >
      {!busy && <Check size={14} />}
      {busy ? "Saving…" : completed ? "Reopen" : "Complete"}
    </Button>
  );
}
