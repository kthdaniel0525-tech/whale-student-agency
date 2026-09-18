"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AssistantPendingInteraction } from "./types";

export function PendingInteraction({ interaction, onSubmit }: {
  interaction: AssistantPendingInteraction;
  onSubmit: (value: string, kind: "student-work" | "career-data") => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const kind = interaction.kind;
  if (!kind || interaction.type === "quiz") return null;

  async function submit() {
    const answer = interaction.type === "confirmation" ? "confirmed" : value.trim();
    if (!answer || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(answer, kind!);
      setValue("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workflow could not continue.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="assistant-pending" aria-label={interaction.title}>
      <h4>{interaction.title}</h4>
      {interaction.description && <p>{interaction.description}</p>}
      {interaction.type === "choice" && interaction.choices ? (
        <div className="mt-3 grid gap-2">
          {interaction.choices.map((choice) => <label className="assistant-choice" key={choice}><input type="radio" name={`pending-${interaction.title}`} value={choice} checked={value === choice} onChange={() => setValue(choice)} /><span>{choice}</span></label>)}
        </div>
      ) : interaction.type !== "confirmation" ? (
        <Textarea
          aria-label={interaction.title}
          className={interaction.type === "long-text" ? "mt-3 min-h-32" : "mt-3"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Add your response without losing your current workflow progress…"
        />
      ) : null}
      <Button className="mt-3" disabled={busy || (interaction.type !== "confirmation" && !value.trim())} onClick={submit}>
        {busy && <Loader2 className="animate-spin" />}{interaction.submitLabel}
      </Button>
      {error && <div className="mt-3 flex items-center gap-2" role="alert"><p className="text-sm text-destructive">{error}</p><Button size="sm" variant="ghost" onClick={submit}>Try again</Button></div>}
    </section>
  );
}
