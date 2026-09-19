"use client";
import { DriveSettingsPanel } from "@/features/student/drive/settings";
import { AcademicIntegrationSettings } from "@/features/student/academic-integrations/settings";
import { CalendarSettingsPanel } from "@/features/student/calendar/settings";
import type { IntegrationCapability } from "@/lib/student/integrations/types";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { request } from "@/lib/student/client";
import { CAPABILITY_LABELS, type ConnectedAccountView, type IntegrationSettingsView, type IntegrationProviderId } from "@/lib/student/integrations/types";
const statuses = { connected: "Connected", "needs-reconnect": "Needs reconnect", disconnected: "Disconnected", error: "Error — reconnect or try again later" };
export function IntegrationSettings({ initial, result }: { initial: IntegrationSettingsView; result?: string }) {
  const router = useRouter(); const [data, setData] = useState(initial); const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConnectedAccountView | null>(null); const [error, setError] = useState(""); const [success, setSuccess] = useState("");
  // Query parameters select only fixed text; arbitrary provider errors never render.
  const callbackMessage = result === "connected" ? "Account connected successfully." : result === "ACCESS_DENIED" ? "Connection cancelled. No new access was saved."
    : result === "UNAUTHENTICATED" ? "Sign in again and restart the connection."
    : result ? "The account could not be connected. Please start again from this section." : "";
  async function connect(provider: IntegrationProviderId, account?: ConnectedAccountView, capabilities?: IntegrationCapability[]) {
    setError(""); setSuccess(""); setBusy(account?.id ?? provider);
    try {
      const value = await request<{ authorizationUrl: string }>("/api/student/integrations/connect", "POST", {
        provider, capabilities: capabilities ?? (account?.capabilities.length ? account.capabilities : ["account-profile"]), redirectPath: "/student/settings", ...(account ? { connectedAccountId: account.id } : {}),
      });
      window.location.assign(value.authorizationUrl);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Connection could not be started."); setBusy(null); }
  }
  async function disconnect(account: ConnectedAccountView) {
    setError(""); setSuccess(""); setBusy(account.id);
    try {
      const updated = await request<ConnectedAccountView>(`/api/student/integrations/accounts/${encodeURIComponent(account.id)}`, "DELETE");
      setData((previous) => ({ ...previous, accounts: previous.accounts.map((row) => row.id === updated.id ? updated : row) }));
      setSuccess(updated.revocationFailed ? "Disconnected from this app. The service could not confirm revocation; you can also remove access in your provider account permissions." : "Account disconnected. Future access from this app has stopped.");
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not disconnect. Please try again."); }
    finally { setBusy(null); }
  }
  return <section id="integrations" className="panel mt-6 max-w-4xl scroll-mt-20" aria-labelledby="integrations-title">
    <div className="flex items-start justify-between gap-4"><div><p className="eyebrow">Connected services</p><h2 id="integrations-title" className="mt-1">Integrations</h2><p className="mt-2 text-sm text-muted-foreground">Connect Google Calendar for scheduling and Google Drive for importing course materials.</p></div><Link2 className="shrink-0 text-primary" size={22} /></div>
    {callbackMessage && <p role={result === "connected" ? "status" : "alert"} className="mt-4 rounded-lg bg-muted p-3 text-sm">{callbackMessage}</p>}
    {data.providers.map((provider) => <div key={provider.id} className="mt-5 rounded-xl border p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{provider.name}</h3><p className="mt-1 text-sm text-muted-foreground">Account identity only when connecting a new account. Additional permissions require your approval.</p></div>
        <Button variant="outline" disabled={Boolean(busy) || !provider.available} onClick={() => connect(provider.id)}>{busy === provider.id ? "Connecting…" : `Connect ${provider.name}`}</Button></div>
      {!provider.available && <p className="mt-3 text-sm text-muted-foreground">Connection setup is not available yet. Your administrator needs to enable this service.</p>}
      {!data.accounts.some((account) => account.provider === provider.id) && <p className="mt-4 text-sm text-muted-foreground">Not connected</p>}
      {data.accounts.filter((account) => account.provider === provider.id).map((account) => <article key={account.id} aria-label={`${provider.name} account ${account.email ?? account.displayName ?? "connected account"}`} className="mt-4 border-t pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h4 className="break-all font-medium">{account.email ?? account.displayName ?? `${provider.name} account`}</h4><p className="mt-1 text-sm text-muted-foreground">{statuses[account.status]}</p></div>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={Boolean(busy) || !provider.available} onClick={() => connect(provider.id, account)}>{account.status === "connected" ? "Reconnect account" : "Reconnect"}</Button>
            {account.status !== "disconnected" && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => setConfirm(account)}>Disconnect</Button>}</div></div>
        {account.status !== "disconnected" && <ul className="mt-3 space-y-2">{account.capabilities.map((capability) => <li key={capability} className="text-sm"><strong>{CAPABILITY_LABELS[capability].title}</strong><p className="text-muted-foreground">{CAPABILITY_LABELS[capability].description}</p></li>)}</ul>}
        {account.provider === "google" && account.status !== "disconnected" && <CalendarSettingsPanel account={account} disabled={Boolean(busy) || !provider.available || account.status === "needs-reconnect"} enable={(capabilities) => void connect(provider.id, account, capabilities)} />}
        {account.provider === "google" && account.status !== "disconnected" && <DriveSettingsPanel account={account} disabled={Boolean(busy) || !provider.available} enable={() => void connect(provider.id, account, ["drive-read"])} />}
        {account.revocationFailed && account.status === "disconnected" && <p className="mt-3 text-sm text-muted-foreground">Local access is disabled. Review this app in your {provider.name} account permissions if you also want to verify external revocation.</p>}
      </article>)}
    </div>)}
    {error && <p role="alert" className="field-error mt-4">{error}</p>}
    <p role="status" className="mt-4 text-sm text-muted-foreground">{success || (busy ? "Updating your connection…" : "")}</p>
    <AcademicIntegrationSettings />
    <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => { if (!open) setConfirm(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Disconnect {data.providers.find((provider) => provider.id === confirm?.provider)?.name}?</AlertDialogTitle><AlertDialogDescription>This will stop future access to connected services from this app. It will not delete your external calendar, files, or emails.</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Keep connected</AlertDialogCancel><AlertDialogAction onClick={() => { if (confirm) void disconnect(confirm); }}>Disconnect account</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </section>;
}
