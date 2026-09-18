"use client";

import { Lightbulb } from "lucide-react";
import { AssistantActionBar } from "./action-bar";
import type { AssistantAction } from "./types";

export function TutorResult({
  structuredData,
  actions,
  onAction,
  disabled,
}: {
  structuredData?: unknown;
  actions: readonly AssistantAction[];
  onAction?: (action: AssistantAction) => void | Promise<void>;
  disabled?: boolean;
}) {
  const data = structuredData && typeof structuredData === "object"
    ? structuredData as Record<string, unknown>
    : null;
  const takeaway = typeof data?.keyTakeaway === "string"
    ? data.keyTakeaway
    : typeof data?.takeaway === "string" ? data.takeaway : null;
  const examples = Array.isArray(data?.examples)
    ? data.examples.filter((item): item is string => typeof item === "string").slice(0, 3)
    : [];
  return (
    <div className="space-y-3">
      {examples.length > 0 && (
        <section className="assistant-structured-section" aria-label="Examples">
          <h4>Examples</h4>
          <ul>{examples.map((example) => <li key={example}>{example}</li>)}</ul>
        </section>
      )}
      {takeaway && (
        <aside className="assistant-takeaway">
          <Lightbulb size={18} />
          <div><strong>Key takeaway</strong><p>{takeaway}</p></div>
        </aside>
      )}
      <AssistantActionBar actions={actions} onAction={onAction} disabled={disabled} />
    </div>
  );
}
