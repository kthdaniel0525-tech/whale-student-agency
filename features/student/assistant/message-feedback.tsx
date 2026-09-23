"use client";
import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
export function MessageFeedback({ messageId }: { messageId: string }) {
  const [rating, setRating] = useState<number | null>(null), [busy, setBusy] = useState(false), [details, setDetails] = useState(false);
  const [reason, setReason] = useState(""), [comment, setComment] = useState(""), [notice, setNotice] = useState("");
  const url = `/api/student/assistant/messages/${encodeURIComponent(messageId)}/feedback`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal }).then(async r => {
      if (r.ok) { const v = await r.json() as { rating: number; reasonCode: string | null; comment: string | null } | null; if (v) { setRating(v.rating); setReason(v.reasonCode ?? ""); setComment(v.comment ?? ""); } }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [url]);
  async function save(value: number) {
    setBusy(true); setNotice("");
    try {
      const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating: value, reasonCode: reason || null, comment: comment || null }) });
      if (!response.ok) throw new Error();
      setRating(value); setNotice("Feedback saved. Thank you.");
    } catch { setNotice("Could not save feedback. Please try again."); }
    finally { setBusy(false); }
  }
  return <div className="mt-2 text-xs text-muted-foreground">
    <div className="flex items-center gap-3">
      <span>Was this helpful?</span>
      <button type="button" aria-label="Helpful" aria-pressed={rating === 1} disabled={busy} onClick={() => void save(1)} className={rating === 1 ? "text-primary" : ""}><ThumbsUp size={15} /></button>
      <button type="button" aria-label="Not helpful" aria-pressed={rating === -1} disabled={busy} onClick={() => void save(-1)} className={rating === -1 ? "text-primary" : ""}><ThumbsDown size={15} /></button>
      {rating !== null && <button type="button" onClick={() => setDetails(!details)}>Add details (optional)</button>}
    </div>
    {details && <form className="mt-2 grid max-w-sm gap-2" onSubmit={e => { e.preventDefault(); void save(rating!); }}>
      <select aria-label="Feedback reason" value={reason} onChange={e => setReason(e.target.value)} className="rounded border bg-background p-2"><option value="">Choose a reason (optional)</option>{Object.entries({ INCORRECT: "Incorrect", NOT_HELPFUL: "Not helpful", TOO_LONG: "Too long", TOO_DIFFICULT: "Too difficult", WRONG_SOURCE: "Wrong source", USEFUL: "Useful" }).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
      <textarea aria-label="Feedback comment" maxLength={1000} value={comment} onChange={e => setComment(e.target.value)} placeholder="Optional comment" className="rounded border bg-background p-2" />
      <button disabled={busy} type="submit" className="justify-self-start">Save details</button>
    </form>}
    <p role="status" className="mt-1">{notice}</p>
  </div>;
}
