"use client";

import { Ban, Check, Circle, CircleAlert, Clock3, Loader2 } from "lucide-react";
import { workflowPendingInteraction } from "./interaction-contract";
import { PendingInteraction } from "./pending-interaction";
import type { AssistantWorkflow } from "./types";

function friendly(value: string) {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function WorkflowCard({ workflow, onResume }: { workflow: AssistantWorkflow; onResume?: (value: string, kind: "student-work" | "career-data") => Promise<void> }) {
  const interaction = workflowPendingInteraction(workflow);
  const waiting = workflow.status === "waiting-for-input" || workflow.status === "waiting-for-user";
  const statusLabel = waiting ? "Waiting for you" : friendly(workflow.status);
  return (
    <section className="assistant-artifact" aria-label={`${friendly(workflow.workflowId)} workflow`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="eyebrow">Guided activity</p><h3 className="mt-1 text-lg font-semibold">{friendly(workflow.workflowId)}</h3></div><span className={`assistant-status status-${workflow.status}`} aria-label={`Workflow status: ${statusLabel}`}>{workflow.status === "completed" ? <Check size={13} /> : workflow.status === "failed" ? <CircleAlert size={13} /> : workflow.status === "cancelled" ? <Ban size={13} /> : waiting ? <Clock3 size={13} /> : <Loader2 className={workflow.status === "running" ? "animate-spin" : ""} size={13} />}{statusLabel}</span></div>
      <p className="mt-3 text-sm">{workflow.summary}</p>
      <ol className="mt-5 space-y-3">
        {workflow.steps.map((step) => {
          const complete = step.status === "completed";
          const failed = step.status === "failed";
          const current = step.status === "running" || ((workflow.status === "waiting-for-input" || workflow.status === "waiting-for-user") && !complete && !failed && workflow.steps.find((item) => !workflow.completedSteps.includes(item.stepId))?.stepId === step.stepId);
          return <li key={step.stepId} className="flex gap-3 text-sm">{complete ? <Check className="mt-0.5 text-emerald-600" size={18} aria-label="Completed" /> : failed ? <CircleAlert className="mt-0.5 text-amber-600" size={18} aria-label="Failed" /> : current ? <Loader2 className="mt-0.5 animate-spin text-primary" size={18} aria-label="Current step" /> : <Circle className="mt-0.5 muted" size={18} aria-label="Pending" />}<div className="min-w-0 flex-1"><p className="font-medium">{friendly(step.stepId)}</p>{step.outputSummary && <details className="assistant-step-details"><summary>View result</summary><p>{step.outputSummary}</p></details>}{failed && step.errorCode && <p className="mt-1 text-amber-700 dark:text-amber-300">This step failed. Earlier completed results are still available.</p>}</div></li>;
        })}
      </ol>
      {workflow.warnings.length > 0 && <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">Some optional work was unavailable. Completed results are preserved.</div>}
      {interaction && interaction.type !== "quiz" && onResume && <PendingInteraction interaction={interaction} onSubmit={onResume} />}
      {workflow.status === "completed" && <div className="assistant-workflow-complete" role="status"><Check size={18} /><div><strong>{friendly(workflow.workflowId)} complete</strong><p>{workflow.completedSteps.length} steps completed. {workflow.recommendedNextAction}</p></div></div>}
      {workflow.status === "failed" && <div className="assistant-workflow-failed" role="alert"><CircleAlert size={18} /><div><strong>Workflow stopped at a failed step</strong><p>Successful earlier steps remain saved. {workflow.recommendedNextAction}</p></div></div>}
      {workflow.status !== "completed" && workflow.status !== "failed" && <p className="mt-4 text-sm muted">Next: {workflow.recommendedNextAction}</p>}
    </section>
  );
}
