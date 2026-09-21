"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Capability, PublicEntitlements } from "@/lib/entitlements/types";
const AccessContext = createContext<{ access: PublicEntitlements; refresh(): Promise<void> } | null>(null);
export function EntitlementProvider({ initial, children }: { initial: PublicEntitlements; children: React.ReactNode }) {
  const [access, setAccess] = useState(initial);
  const refresh = useCallback(async () => {
    const response = await fetch("/api/student/entitlements", { cache: "no-store" });
    if (response.ok) setAccess(await response.json());
  }, []);
  useEffect(() => {
    const update = () => { void refresh().catch(() => {}); };
    window.addEventListener("focus", update);
    const timer = setInterval(update, 30000);
    return () => { window.removeEventListener("focus", update); clearInterval(timer); };
  }, [refresh]);
  return <AccessContext.Provider value={{ access, refresh }}>{children}</AccessContext.Provider>;
}
export function useEntitlements() {
  const value = useContext(AccessContext);
  if (!value) throw new Error("EntitlementProvider is required");
  return { ...value, has: (key: Capability) => value.access.capabilities[key] };
}
export function FeatureAccess({ capability, title, children }: { capability: Capability; title: string; children: React.ReactNode }) {
  const { has } = useEntitlements();
  return has(capability) ? children : <div role="status" className="mt-4 rounded-xl border bg-muted/30 p-4 text-sm"><strong>{title}</strong><p className="mt-1 text-muted-foreground">Currently unavailable with your access. Your saved data is preserved.</p><Link href="/plans" className="mt-2 inline-block font-medium text-primary underline">View plans</Link></div>;
}
export function PlanAccessSummary() {
  const { access } = useEntitlements();
  return <section className="panel mb-6 max-w-4xl"><h2>Your plan: {access.plan.name}</h2><p className="mt-2 text-sm text-muted-foreground">Your access and allowances apply across study tools and connected services.</p><Link href="/plans" className="mt-3 inline-block text-primary underline">View plans</Link></section>;
}
