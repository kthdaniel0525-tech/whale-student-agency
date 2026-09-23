"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
export function DocumentActions({
  id,
  failed,
  onChange,
  back = false,
}: {
  id: string;
  failed: boolean;
  onChange?: () => void;
  back?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(action: "delete" | "retry") {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ cleanupPending?: boolean }>(
        `/api/student/documents/${id}${action === "retry" ? "/retry" : ""}`,
        action === "retry" ? "POST" : "DELETE",
        action === "retry" ? {} : undefined,
      );
      toast.success(
        action === "retry"
          ? "Document queued for retry."
          : result.cleanupPending
            ? "Document deleted. File cleanup is queued."
            : "Document and indexed passages deleted.",
      );
      setOpen(false);
      if (back && action === "delete") router.replace("/student/documents");
      else {
        onChange?.();
        router.refresh();
      }
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Unable to update document.";
      setError(message);
      if (action === "retry") toast.error(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex gap-2">
      {failed && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => act("retry")}
        >
          {busy ? "Please wait…" : "Retry processing"}
        </Button>
      )}
      <AlertDialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
      >
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="ghost" disabled={busy}>
            Delete document
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this document?</AlertDialogTitle>
          <AlertDialogDescription>
            The original file, extracted pages and all indexed passages will be
            removed.
          </AlertDialogDescription>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep document</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => act("delete")}
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
