"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { BillingSummary, BillingSelection, PublicPrice } from "@/lib/billing/types";
export const formatPrice = (price: PublicPrice) => `${new Intl.NumberFormat("en-US", { style: "currency", currency: price.currency }).format(price.amount / 100)} / ${price.interval === "yearly" ? "year" : "month"}`;
export function BillingAction({ kind, selection, children }: { kind: "checkout" | "change" | "portal"; selection?: BillingSelection; children: React.ReactNode }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setPending(true); setError("");
    try {
      const response = await fetch(`/api/student/billing/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection ?? {}) });
      const result = await response.json() as { url: string; error?: string };
      if (!response.ok) { if (response.status === 401) { window.location.assign("/sign-in"); return; } throw new Error(result.error ?? "Billing is unavailable. Please try again."); }
      window.location.assign(result.url);
    } catch (error) { setError(error instanceof Error ? error.message : "Please try again."); setPending(false); }
  }
  return <div><button className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={pending} onClick={() => void go()}>{pending ? "Opening secure billing…" : children}</button>{error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}</div>;
}
export function PlanPurchase({ planCode, prices, current }: { planCode: string; prices: PublicPrice[]; current: BillingSummary | null }) {
  const options = prices.filter(p => p.planCode === planCode);
  const [interval, setInterval] = useState<"monthly" | "yearly">(options[0]?.interval ?? "monthly");
  const price = options.find(p => p.interval === interval);
  if (!price) return null;
  const same = current?.price?.planCode === planCode && current.price.interval === interval && ["active", "trialing", "past-due"].includes(current.status);
  return <div className="mt-4 border-t pt-4"><label className="text-sm">Billing interval <select aria-label={`${planCode} billing interval`} className="ml-2 rounded border bg-background p-1" value={interval} onChange={e => setInterval(e.target.value as typeof interval)}>{options.map(p => <option key={p.interval} value={p.interval}>{p.interval === "monthly" ? "Monthly" : "Yearly"}</option>)}</select></label><p className="mt-3 text-lg font-semibold">{formatPrice(price)}</p><p className="text-xs text-muted-foreground">Applicable taxes are shown by Stripe before confirmation.</p>{same ? <p className="mt-4 text-sm font-medium">Current subscription</p> : <BillingAction kind={current?.canManage && current.price && !["expired", "cancelled"].includes(current.status) ? "change" : "checkout"} selection={{ planCode, billingInterval: interval }}>{current?.canManage && current.price && !["expired", "cancelled"].includes(current.status) ? "Change plan securely" : "Subscribe"}</BillingAction>}</div>;
}
const day = (value: string) => new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
export function BillingDetails({ initial, confirming = false }: { initial: BillingSummary; confirming?: boolean }) {
  const [state, setState] = useState(initial);
  const [refreshError, setRefreshError] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/student/billing", { cache: "no-store" });
        if (!response.ok) throw new Error();
        const data = await response.json() as BillingSummary;
        if (active) { setState(data); setRefreshError(false); }
      } catch { if (active) setRefreshError(true); }
    };
    const tick = () => void refresh();
    const timer = setInterval(tick, confirming ? 5000 : 30000);
    window.addEventListener("focus", tick);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", tick); };
  }, [confirming]);
  return <section className="rounded-2xl border p-6">
    {confirming && <p role="status" className="mb-4">{state.confirmed ? "Your current subscription is confirmed. Your access is up to date." : "Your subscription is being confirmed. This page will update automatically. Returning from checkout alone does not confirm payment."}</p>}
    <h2 className="text-xl font-semibold">Current Plan: {state.plan.name}</h2><p className="mt-2 capitalize">{state.status === "past-due" ? "Payment needs attention" : state.status === "trialing" ? "Trial" : state.status}</p>
    {state.price && <p className="mt-2">{formatPrice(state.price)}</p>}
    {state.trialEndsAt && state.status === "trialing" && <p className="mt-2">Trial ends {day(state.trialEndsAt)}</p>}
    {state.renewsAt && ["active", "trialing", "past-due"].includes(state.status) && <p className="mt-2">{state.cancelAtPeriodEnd ? "Cancels on" : "Current period ends"} {day(state.renewsAt)}</p>}
    {state.pendingChange && <p className="mt-2">Scheduled change: {state.pendingChange.planCode} ({state.pendingChange.interval}) on {day(state.pendingChange.effectiveAt)}</p>}
    {state.status === "past-due" && <p className="mt-2 text-sm">Update your payment method in billing. {state.graceUntil ? `Grace period ends ${day(state.graceUntil)}.` : "Paid access is paused until payment recovers."} Your saved work is preserved.</p>}
    {state.enabled && state.canManage && <BillingAction kind="portal">Manage Billing</BillingAction>}
    {!state.enabled && <p className="mt-4 text-sm text-muted-foreground">Online billing is not available yet. Your existing plan access remains in place.</p>}
    <p className="mt-4 text-sm text-muted-foreground">Manage payment details, invoices, cancellation and scheduled cancellation renewal securely through Stripe.</p>
    <Link className="mt-4 inline-block text-primary underline" href="/plans">View plans</Link>
    {refreshError && <p role="status" className="mt-3 text-sm">Unable to refresh billing status. We will retry automatically.</p>}
  </section>;
}
