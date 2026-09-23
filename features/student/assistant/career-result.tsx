"use client";

import { BriefcaseBusiness, CheckCircle2, CircleAlert, FileText, FolderKanban } from "lucide-react";
import { AssistantActionBar } from "./action-bar";
import type { AssistantAction } from "./types";

function strings(value: unknown, key?: string) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item) => {
    if (typeof item === "string") return [item];
    if (key && item && typeof item === "object" && typeof (item as Record<string, unknown>)[key] === "string") return [String((item as Record<string, unknown>)[key])];
    return [];
  });
}

function CareerSection({ title, values, icon }: { title: string; values: string[]; icon: React.ReactNode }) {
  if (!values.length) return null;
  return <section className="assistant-structured-section"><h4 className="flex items-center gap-2">{icon}{title}</h4><ul>{values.map((value) => <li key={value}>{value}</li>)}</ul></section>;
}

export function CareerResult({ structuredData, actions, onAction, disabled }: {
  structuredData?: unknown;
  actions: readonly AssistantAction[];
  onAction?: (action: AssistantAction) => void | Promise<void>;
  disabled?: boolean;
}) {
  const data = structuredData && typeof structuredData === "object" ? structuredData as Record<string, unknown> : {};
  return (
    <div className="space-y-3">
      <CareerSection title="Strengths" values={strings(data.strengths)} icon={<CheckCircle2 size={16} />} />
      <CareerSection title="Evidence gaps" values={strings(data.gaps)} icon={<CircleAlert size={16} />} />
      <CareerSection title="Priority improvements" values={strings(data.recommendedSkills)} icon={<BriefcaseBusiness size={16} />} />
      <CareerSection title="Projects" values={strings(data.recommendedProjects, "recommendation")} icon={<FolderKanban size={16} />} />
      <CareerSection title="Resume recommendations" values={strings(data.resumeBullets, "improved")} icon={<FileText size={16} />} />
      <CareerSection title="Next actions" values={strings(data.nextActions)} icon={<BriefcaseBusiness size={16} />} />
      <AssistantActionBar actions={actions} onAction={onAction} disabled={disabled} />
    </div>
  );
}
