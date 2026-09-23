"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
export function FeedbackPrompt() {
  const [show, setShow] = useState(false);
  useEffect(() => { const controller = new AbortController(); void fetch("/api/student/product-feedback", { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(value => { if (!controller.signal.aborted && value?.eligible) setShow(true); }).catch(() => {}); return () => controller.abort(); }, []);
  if (!show) return null;
  return <aside className="panel mb-6 flex flex-wrap items-center gap-3" aria-label="Optional beta feedback"><span>How is Student Agency working for you?</span><Button asChild size="sm" variant="outline"><Link href="/student/feedback">Share feedback</Link></Button><Button size="sm" variant="ghost" onClick={() => { setShow(false); void fetch("/api/student/product-feedback", { method: "DELETE" }).catch(() => {}); }}>Dismiss</Button></aside>;
}
