"use client";

import { useState } from "react";
import { Check, Circle, CircleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AssistantWorkflow } from "./types";

function friendly(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function WorkflowCard({ workflow, onResume }: { workflow: AssistantWorkflow; onResume?: (value: string, kind: "student-work" | "career-data") => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const waiting = workflow.waitingFor?.kind;
  async function submit() {
    if (!value.trim() || !onResume || (waiting !== "student-work" && waiting !== "career-data")) return;
    setBusy(true); setError(undefined);
    try { await onResume(value.trim(), waiting); setValue(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The workflow could not continue."); }
    finally { setBusy(false); }
  }
  return (
    <section className="assistant-artifact" aria-label={`${friendly(workflow.workflowId)} workflow`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="eyebrow">Guided activity</p><h3 className="mt-1 text-lg font-semibold">{friendly(workflow.workflowId)}</h3></div><span className={`assistant-status status-${workflow.status}`}>{friendly(workflow.status)}</span></div>
      <p className="mt-3 text-sm">{workflow.summary}</p>
      <ol className="mt-5 space-y-3">
        {workflow.steps.map((step) => {
          const complete = step.status === "completed";
          const failed = step.status === "failed";
          const current = step.status === "running" || (workflow.status === "waiting-for-input" && !complete && !failed && workflow.steps.find((item) => !workflow.completedSteps.includes(item.stepId))?.stepId === step.stepId);
          return <li key={step.stepId} className="flex gap-3 text-sm">{complete ? <Check className="mt-0.5 text-emerald-600" size={18} /> : failed ? <CircleAlert className="mt-0.5 text-amber-600" size={18} /> : current ? <Loader2 className="mt-0.5 animate-spin text-primary" size={18} /> : <Circle className="mt-0.5 muted" size={18} />}<div><p className="font-medium">{friendly(step.stepId)}</p>{step.outputSummary && <p className="muted">{step.outputSummary}</p>}</div></li>;
        })}
      </ol>
      {workflow.warnings.length > 0 && <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Some optional work was unavailable. Completed results are preserved.</div>}
      {(waiting === "student-work" || waiting === "career-data") && onResume && (
        <div className="mt-5 border-t pt-4"><label className="text-sm font-medium" htmlFor={`workflow-${workflow.runId}`}>{waiting === "student-work" ? "Add your current draft" : "Add resume or experience details"}</label><Textarea id={`workflow-${workflow.runId}`} className="mt-2 min-h-28" value={value} onChange={(event) => setValue(event.target.value)} placeholder={waiting === "student-work" ? "Paste your work so far…" : "Share relevant experience, projects, or resume details…"} /><Button className="mt-3" disabled={!value.trim() || busy} onClick={submit}>{busy && <Loader2 className="animate-spin" />} Continue</Button>{error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}</div>
      )}
      <p className="mt-4 text-sm muted">Next: {workflow.recommendedNextAction}</p>
    </section>
  );
}
