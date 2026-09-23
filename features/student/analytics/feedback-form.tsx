"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FEATURES, PAGES } from "@/lib/product-analytics/events";
import { productFeedbackSchema } from "@/lib/product-analytics/feedback";
import { setClientAnalyticsEnabled } from "./client";
export function ProductFeedbackForm({ optedOut: initial, analyticsEnabled }: { optedOut: boolean; analyticsEnabled: boolean }) {
  const [optedOut, setOptedOut] = useState(initial), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [submissionId, setSubmissionId] = useState<string>();
  async function submit(form: HTMLFormElement) {
    setBusy(true); setNotice("");
    const data = new FormData(form), id = submissionId ?? crypto.randomUUID(); setSubmissionId(id);
    const survey = data.get("survey") === "on";
    try {
      const input = productFeedbackSchema.parse({ submissionId: id, category: survey ? "beta-survey" : data.get("category"), message: data.get("message"), feature: data.get("feature"), page: data.get("page"), ...(data.get("rating") ? { rating: Number(data.get("rating")) } : {}),
        ...(survey ? { survey: { usefulness: Number(data.get("usefulness")), valuableFeature: data.get("valuableFeature"), confusing: data.get("confusing"), weeklyValue: data.get("weeklyValue"), willingnessToPay: data.get("willingnessToPay"), missing: data.get("missing") } } : {}) });
      const response = await fetch("/api/student/product-feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error("We couldn’t save your feedback. Please try again.");
      form.reset(); setSubmissionId(undefined); setNotice("Thank you. Your feedback has been saved for the beta team.");
    } catch { setNotice("Check the fields and try again. Feedback must be between 1 and 4,000 characters."); }
    finally { setBusy(false); }
  }
  async function toggle() {
    setBusy(true);
    try { const next = !optedOut; const response = await fetch("/api/student/product-analytics", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optedOut: next }) }); if (!response.ok) throw Error(); setOptedOut(next); setClientAnalyticsEnabled(analyticsEnabled && !next); setNotice(next ? "Product usage tracking is off. Stored behavior events were removed." : "Product usage tracking is enabled when the service is configured to collect it."); }
    catch { setNotice("Your preference could not be saved. Please try again."); } finally { setBusy(false); }
  }
  return <div className="space-y-6 max-w-3xl">
    <section className="panel"><h2>Send feedback</h2><p className="my-3 muted">Tell us what worked or what needs fixing. Your message is stored privately for the beta team. Avoid passwords, payment details, or sensitive documents.</p>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }}>
        <label className="block">Category<select name="category" className="block border rounded p-2 w-full"><option value="bug">Bug</option><option value="feature-request">Feature request</option><option value="usability">Ease of use</option><option value="AI-quality">AI quality</option><option value="other">Other</option></select></label>
        <label className="block">Feature<select name="feature" className="block border rounded p-2 w-full">{FEATURES.map(feature => <option key={feature} value={feature}>{feature.replaceAll("-", " ")}</option>)}</select></label>
        <label className="block">Where did this happen?<select name="page" defaultValue="other" className="block border rounded p-2 w-full">{PAGES.map(page => <option key={page} value={page}>{page.replaceAll("-", " ")}</option>)}</select></label>
        <label className="block">Your feedback<textarea name="message" required maxLength={4000} rows={5} className="block border rounded p-2 w-full" /></label>
        <label className="block">Overall satisfaction (optional)<select name="rating" className="block border rounded p-2 w-full"><option value="">Prefer not to rate</option>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} / 5</option>)}</select></label>
        <details className="border rounded p-4"><summary>Optional beta survey</summary><label className="block my-3"><input type="checkbox" name="survey" /> Include these survey answers</label>
          <label className="block my-3">How useful is Student Agency?<select name="usefulness" defaultValue="3" className="block border rounded p-2 w-full">{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} / 5</option>)}</select></label>
          <label className="block my-3">Most valuable feature<select name="valuableFeature" className="block border rounded p-2 w-full">{FEATURES.map(feature => <option key={feature} value={feature}>{feature}</option>)}</select></label>
          <label className="block my-3">What is confusing?<textarea name="confusing" maxLength={1000} className="block border rounded p-2 w-full" /></label>
          <label className="block my-3">What would make you use it every week?<textarea name="weeklyValue" maxLength={1000} className="block border rounded p-2 w-full" /></label>
          <label className="block my-3">Would you pay for it?<select name="willingnessToPay" defaultValue="maybe" className="block border rounded p-2 w-full"><option value="yes">Yes</option><option value="maybe">Maybe</option><option value="no">No</option></select></label>
          <label className="block my-3">What is missing?<textarea name="missing" maxLength={1000} className="block border rounded p-2 w-full" /></label>
        </details>
        <Button disabled={busy} type="submit">{busy ? "Saving…" : "Send feedback"}</Button>
      </form>
    </section>
    <section className="panel"><h2>Product usage privacy</h2><p className="my-3 muted">Optional usage tracking records actions such as finishing a quiz. It does not include your prompts, AI responses, document contents or feedback text. Operational AI usage, security and billing records are managed separately.</p><p className="mb-3">{analyticsEnabled ? optedOut ? "Product usage tracking is off." : "Product usage tracking is on." : "Product usage tracking is currently disabled for this environment."}</p><Button variant="outline" onClick={toggle} disabled={busy}>{optedOut ? "Allow product usage tracking" : "Turn off product usage tracking"}</Button></section>
    <p role="status">{notice}</p>
  </div>;
}
