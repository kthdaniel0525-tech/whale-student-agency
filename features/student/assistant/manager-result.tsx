"use client";

import { AlertTriangle, Gauge, ListChecks, ShieldCheck } from "lucide-react";
import { AssistantActionBar } from "./action-bar";
import type { AssistantAction } from "./types";

function list(value: unknown, keys: string[]) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const text = keys.map((key) => record[key]).find((entry) => typeof entry === "string");
    return typeof text === "string" ? [text] : [];
  });
}

function Section({ title, items, icon }: { title: string; items: string[]; icon: React.ReactNode }) {
  if (!items.length) return null;
  return <section className="assistant-structured-section"><h4 className="flex items-center gap-2">{icon}{title}</h4><ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></section>;
}

export function AcademicManagerResult({ structuredData, actions, onAction, disabled }: {
  structuredData?: unknown;
  actions: readonly AssistantAction[];
  onAction?: (action: AssistantAction) => void | Promise<void>;
  disabled?: boolean;
}) {
  if (!structuredData || typeof structuredData !== "object") {
    return <AssistantActionBar actions={actions} onAction={onAction} disabled={disabled} />;
  }
  const data = structuredData as Record<string, unknown>;
  const status = typeof data.overallStatus === "string" ? data.overallStatus : null;
  const readiness = Array.isArray(data.examReadiness) ? data.examReadiness.slice(0, 4) : [];
  return (
    <div className="space-y-3">
      {status && <section className="assistant-manager-status"><ShieldCheck size={19} /><div><p className="eyebrow">Overall status</p><strong>{status.replaceAll("-", " ")}</strong></div></section>}
      <Section title="Top priorities" icon={<ListChecks size={16} />} items={list(data.topPriorities, ["reason", "action"])} />
      <Section title="Risks" icon={<AlertTriangle size={16} />} items={list(data.risks, ["reason"])} />
      {readiness.length > 0 && <section className="assistant-structured-section"><h4 className="flex items-center gap-2"><Gauge size={16} />Exam readiness</h4><div className="mt-3 grid gap-2 sm:grid-cols-2">{readiness.map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        return <div className="assistant-readiness" key={String(row.examId ?? index)}><strong>{String(row.title ?? "Exam")}</strong><span>{String(row.readinessLevel ?? "insufficient data").replaceAll("-", " ")}</span>{typeof row.explanation === "string" && <small>{row.explanation}</small>}</div>;
      })}</div></section>}
      <Section title="Recommended actions" icon={<ListChecks size={16} />} items={list(data.recommendedActions, ["action", "reason"])} />
      <AssistantActionBar actions={actions} onAction={onAction} disabled={disabled} />
    </div>
  );
}
