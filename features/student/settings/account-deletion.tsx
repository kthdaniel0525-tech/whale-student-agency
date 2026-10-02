"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export function AccountDeletion() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function removeAccount() {
    setBusy(true);
    setError("");
    try {
      const result = await request<{ accepted: true; message: string }>(
        "/api/student/account",
        "DELETE",
        { password, confirmation },
      );
      setPassword("");
      setConfirmation("");
      setPending(result.accepted);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account deletion could not be requested.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel mt-6 max-w-4xl" aria-labelledby="account-data-heading">
      <div className="flex items-start gap-3">
        <Trash2 className="mt-1 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Account &amp; data</p>
          <h2 id="account-data-heading">Delete your account</h2>
          {pending ? (
            <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4" role="status">
              <strong>Deletion requested</strong>
              <p className="mt-1 text-sm text-muted-foreground">Your account is disabled and deletion is scheduled. This page will no longer be available after you leave it.</p>
            </div>
          ) : (
            <>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">This permanently removes your account and owned local academic data, conversations, memory, indexed document passages, and private uploaded files. Provider and backup records follow their separate processes.</p>
              <AlertDialog open={open} onOpenChange={(value) => { if (!busy) { setOpen(value); setError(""); if (!value) { setPassword(""); setConfirmation(""); } } }}>
                <AlertDialogTrigger asChild><Button className="mt-4" variant="destructive">Delete account</Button></AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete your account permanently?</AlertDialogTitle>
                    <AlertDialogDescription>This disables access immediately and queues deletion of your owned local data. This action cannot be undone.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-2"><Label htmlFor="account-delete-password">Current password</Label><Input id="account-delete-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></div>
                    <div className="space-y-2"><Label htmlFor="account-delete-confirmation">Type DELETE to confirm</Label><Input id="account-delete-confirmation" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} /></div>
                    {error && <p role="alert" className="field-error">{error}</p>}
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Keep account</AlertDialogCancel>
                    <Button variant="destructive" disabled={busy || !password || confirmation !== "DELETE"} onClick={() => void removeAccount()}>{busy ? "Requesting deletion…" : "Delete account permanently"}</Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
