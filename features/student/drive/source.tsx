"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/student/client";
import type { DocumentExternalSource } from "@/lib/student/drive/types";
export function DriveSource({ documentId, source, onChange }: {
    documentId: string;
    source: DocumentExternalSource;
    onChange: () => void;
}) {
    const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
    const refreshing = ["PENDING", "IMPORTING"].includes(source.syncStatus);
    useEffect(() => { if (!refreshing)
        return; const timer = setInterval(onChange, 3000); return () => clearInterval(timer); }, [refreshing, onChange]);
    async function action(refresh: boolean) {
        setBusy(true);
        setMessage("");
        try {
            const result = await request<{
                changed?: boolean;
                available?: boolean;
                syncStatus?: string;
            }>(`/api/student/documents/${documentId}/source${refresh ? "/refresh" : ""}`, "POST");
            setMessage(refresh ? result.syncStatus === "PENDING" || result.syncStatus === "IMPORTING" ? "Refreshing. The current copy remains available until the new version is ready." : result.syncStatus === "UNAVAILABLE" ? "Source unavailable. Your imported copy is preserved." : "Your copy is up to date." : result.available === false ? "Source unavailable. Your imported copy is preserved." : result.changed ? "A newer version is available in Drive." : "Your copy is up to date.");
            onChange();
        }
        catch (e) {
            setMessage(e instanceof Error ? e.message : "Drive could not be checked.");
        }
        finally {
            setBusy(false);
        }
    }
    return <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm"><p>Google Drive{refreshing ? " · Refreshing…" : source.syncStatus === "CHANGED" ? " · New version available" : source.syncStatus === "UNAVAILABLE" ? " · Source unavailable; local copy preserved" : source.syncStatus === "FAILED" ? " · Refresh failed; local copy preserved" : " · Imported copy"}</p>
    <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="ghost" disabled={busy || refreshing} onClick={() => void action(false)}>Check for changes</Button><Button size="sm" variant="outline" disabled={busy || refreshing} onClick={() => void action(true)}>Refresh from Google Drive</Button>{source.webViewLink && <a className="p-2 text-primary underline" href={source.webViewLink} target="_blank" rel="noopener noreferrer">Open in Google Drive</a>}</div>{message && <p role="status" className="mt-2">{message}</p>}</div>;
}
