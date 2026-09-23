"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { setClientAnalyticsEnabled, trackClientEvent } from "./client";
import type { ClientEvent } from "@/lib/product-analytics/events";
/** Only explicitly annotated controls are observed; no text, href, search string,
 * DOM snapshots or generic click capture leaves the browser. */
export function ProductActivityObserver() {
  const path = usePathname();
  useEffect(() => {
    const controller = new AbortController();
    let cleanup = () => {};
    setClientAnalyticsEnabled(false);
    void fetch("/api/student/product-analytics", { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(preference => {
    if (controller.signal.aborted || !preference?.enabled || preference.optedOut) return;
    setClientAnalyticsEnabled(true);
    const pageEvent = path === "/student/progress" ? "progress_page_viewed" : /^\/student\/courses\/[^/]+$/.test(path) ? "course_opened" : path === "/plans" ? "plans_viewed" : undefined;
    if (pageEvent) {
      // Repeated visits count; StrictMode/hydration within the same navigation do not.
      const key = `product-view:${path}`;
      try { const old = Number(sessionStorage.getItem(key)); if (Date.now() - old > 1000) { sessionStorage.setItem(key, String(Date.now())); trackClientEvent(pageEvent); } } catch { /* Optional analytics. */ }
    }
    document.addEventListener("click", event => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-product-event]") : null;
      if (element) trackClientEvent(element.dataset.productEvent as ClientEvent["event"]);
    }, { signal: controller.signal });
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        const id = (entry.target as HTMLElement).dataset.recommendationId;
        if (!id) continue;
        observer.unobserve(entry.target);
        const key = `product-impression:${id}`;
        try { if (sessionStorage.getItem(key)) continue; sessionStorage.setItem(key, "1"); } catch { /* Server also deduplicates. */ }
        trackClientEvent("recommendation_shown", { recommendationId: id, page: path === "/student/progress" ? "progress" : path.startsWith("/student/courses/") ? "course-workspace" : "dashboard" });
      }
    }, { threshold: 0.5 });
    const seen = new WeakMap<Element, string>();
    const scan = () => document.querySelectorAll<HTMLElement>("[data-recommendation-id]").forEach(el => { const id = el.dataset.recommendationId; if (id && seen.get(el) !== id) { seen.set(el, id); observer.observe(el); } });
    scan();
    const mutations = new MutationObserver(scan); mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-recommendation-id"] });
    cleanup = () => { observer.disconnect(); mutations.disconnect(); };
    }).catch(() => {});
    return () => { controller.abort(); cleanup(); setClientAnalyticsEnabled(false); };
  }, [path]);
  return null;
}
