"use client";
import { INTEGRATION_HEALTH_LABELS } from "@/lib/student/integrations/health";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/student/client";
import type { ConnectedAccountView } from "@/lib/student/integrations/types";
import type { DriveSettings } from "@/lib/student/drive/types";
import { DriveBrowser } from "./browser";
export function DriveSettingsPanel({ account, disabled, enable }: {
    account: ConnectedAccountView;
    disabled: boolean;
    enable: () => void;
}) {
    const [settings, setSettings] = useState<DriveSettings | null>(null), [error, setError] = useState("");
    useEffect(() => { let current = true; void request<DriveSettings>(`/api/student/drive/accounts/${account.id}`, "GET").then(value => { if (current)
        setSettings(value); }).catch(e => { if (current)
        setError(e.message); }); return () => { current = false; }; }, [account.id, account.status, account.capabilities]);
    const enabled = account.capabilities.includes("drive-read"), reconnect = ["needs-reconnect", "disconnected"].includes(account.status);
    return <section className="mt-4 rounded-lg border p-4" aria-label="Google Drive settings"><h4 className="font-medium">Google Drive</h4><p className="mt-1 text-sm text-muted-foreground">Drive access: {settings?.health && enabled ? INTEGRATION_HEALTH_LABELS[settings.health.state] : reconnect ? "Needs reconnect" : enabled ? "Connected" : "Needs permission"}</p>
    <p className="mt-2 text-sm text-muted-foreground">Browse your Drive and copy selected study files into a course. Read access is required; this app does not edit your Drive files.</p>
    {enabled && settings && <p className="mt-2 text-sm">{settings.importedCount} imported files · Last access: {settings.lastSuccessfulAccess ? new Date(settings.lastSuccessfulAccess).toLocaleString() : "Not accessed yet"}</p>}
    {error && <p className="field-error mt-2">{error}</p>}
    <div className="mt-3">{enabled && !reconnect ? <DriveBrowser accountId={account.id} label="Browse Drive"/> : <Button size="sm" variant="outline" disabled={disabled} onClick={enable}>{reconnect ? "Reconnect Drive" : "Enable Drive"}</Button>}</div></section>;
}
