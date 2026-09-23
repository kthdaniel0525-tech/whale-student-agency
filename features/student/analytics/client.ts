"use client";
import { clientEventSchema, type ClientEvent } from "@/lib/product-analytics/events";

let enabled = false;
export function setClientAnalyticsEnabled(value: boolean) { enabled = value; }
export function trackClientEvent(event: ClientEvent["event"], extra: Omit<Partial<ClientEvent>, "event"> = {}) {
  if (!enabled) return;
  try {
    const input = clientEventSchema.parse({ event, eventId: crypto.randomUUID(), ...extra });
    void fetch("/api/student/product-analytics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), keepalive: true }).catch(() => {});
  } catch { /* Tracking never interrupts navigation, including disabled storage. */ }
}
