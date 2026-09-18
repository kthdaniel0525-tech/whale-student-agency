"use client";

import { BookMarked, Sigma } from "lucide-react";
import { AssistantActionBar } from "./action-bar";
import type { AssistantAction } from "./types";

type NoteConcept = {
  topic: string;
  complexity?: string;
  keyIdea?: string;
  definitions?: string[];
  formulasOrProcedures?: string[];
  notes?: string;
};

function concepts(value: unknown): NoteConcept[] {
  if (!value || typeof value !== "object") return [];
  const items = (value as { concepts?: unknown }).concepts;
  if (!Array.isArray(items)) return [];
  return items.slice(0, 12).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const data = item as Record<string, unknown>;
    if (typeof data.topic !== "string") return [];
    return [{
      topic: data.topic,
      ...(typeof data.complexity === "string" ? { complexity: data.complexity } : {}),
      ...(typeof data.keyIdea === "string" ? { keyIdea: data.keyIdea } : {}),
      ...(Array.isArray(data.definitions) ? { definitions: data.definitions.filter((entry): entry is string => typeof entry === "string").slice(0, 5) } : {}),
      ...(Array.isArray(data.formulasOrProcedures) ? { formulasOrProcedures: data.formulasOrProcedures.filter((entry): entry is string => typeof entry === "string").slice(0, 5) } : {}),
      ...(typeof data.notes === "string" ? { notes: data.notes } : {}),
    }];
  });
}

export function NotesResult({ structuredData, actions, onAction, disabled }: {
  structuredData?: unknown;
  actions: readonly AssistantAction[];
  onAction?: (action: AssistantAction) => void | Promise<void>;
  disabled?: boolean;
}) {
  const data = structuredData && typeof structuredData === "object" ? structuredData as Record<string, unknown> : null;
  const title = typeof data?.title === "string" ? data.title : null;
  const items = concepts(structuredData);
  return (
    <div className="space-y-3">
      {items.length > 0 && (
        <section className="assistant-artifact assistant-notes" aria-label={title ?? "Structured study notes"}>
          <div className="flex items-center gap-2"><BookMarked size={18} /><div><p className="eyebrow">Study notes</p>{title && <h3 className="text-lg font-semibold">{title}</h3>}</div></div>
          <div className="mt-4 space-y-4">
            {items.map((concept) => (
              <article key={concept.topic} className="assistant-note-concept">
                <div className="flex flex-wrap items-center gap-2"><h4>{concept.topic}</h4>{concept.complexity && <span className="assistant-status">{concept.complexity}</span>}</div>
                {concept.keyIdea && <p className="mt-2 font-medium">{concept.keyIdea}</p>}
                {concept.notes && <p className="mt-2 text-sm muted whitespace-pre-wrap">{concept.notes}</p>}
                {concept.definitions?.length ? <div className="mt-3"><strong className="text-sm">Definitions</strong><ul>{concept.definitions.map((entry) => <li key={entry}>{entry}</li>)}</ul></div> : null}
                {concept.formulasOrProcedures?.length ? <div className="mt-3"><strong className="flex items-center gap-1 text-sm"><Sigma size={14} /> Formulas & steps</strong><ul>{concept.formulasOrProcedures.map((entry) => <li key={entry}>{entry}</li>)}</ul></div> : null}
              </article>
            ))}
          </div>
        </section>
      )}
      <AssistantActionBar actions={actions} onAction={onAction} disabled={disabled} />
    </div>
  );
}
