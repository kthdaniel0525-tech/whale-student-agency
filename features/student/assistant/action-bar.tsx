"use client";

import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantAction } from "./types";

export function AssistantActionBar({
  actions,
  onAction,
  disabled = false,
}: {
  actions: readonly AssistantAction[];
  onAction?: (action: AssistantAction) => void | Promise<void>;
  disabled?: boolean;
}) {
  if (!actions.length || !onAction) return null;
  return (
    <div className="assistant-actions" aria-label="Available follow-up actions">
      {actions.map((action, index) => (
        <Button
          key={action.id}
          type="button"
          size="sm"
          variant={action.style === "primary" ? "default" : action.style === "quiet" ? "ghost" : "outline"}
          disabled={disabled}
          onClick={() => onAction(action)}
        >
          {disabled && index === 0 ? <Loader2 className="animate-spin" /> : null}
          {action.label}
          {action.style === "primary" ? <ArrowRight /> : null}
        </Button>
      ))}
    </div>
  );
}
