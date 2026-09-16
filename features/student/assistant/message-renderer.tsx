"use client";

import Link from "next/link";
import { BookOpen, Bot, ExternalLink, Sparkles } from "lucide-react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { QuizCard } from "./quiz-card";
import { StudyPlanCard } from "./study-plan-card";
import { WorkflowCard } from "./workflow-card";
import type { AssistantMessage, AssistantPresentation } from "./types";

const names: Record<string, string> = { tutor: "Tutor", notes: "Notes", quiz: "Quiz", "study-planner": "Study Planner", "academic-manager": "Academic Manager", career: "Career" };

function StructuredSections({ presentation }: { presentation: AssistantPresentation }) {
  const value = presentation.structuredData;
  if (!value || typeof value !== "object" || presentation.quiz || presentation.studyPlan) return null;
  const data = value as Record<string, unknown>;
  const sections = [
    ["Top priorities", data.topPriorities], ["Academic risks", data.risks], ["Recommended actions", data.recommendedActions],
    ["Strengths", data.strengths], ["Gaps", data.gaps], ["Recommended projects", data.recommendedProjects],
    ["Next actions", data.nextActions], ["Resume suggestions", data.resumeBullets],
  ] as const;
  return <>{sections.map(([label, raw]) => {
    if (!Array.isArray(raw) || !raw.length) return null;
    return <section key={label} className="assistant-structured-section"><h4>{label}</h4><ul>{raw.slice(0, 6).map((item, index) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
      const text = typeof item === "string" ? item : String(record?.action ?? record?.title ?? record?.recommendation ?? record?.improved ?? record?.reason ?? "");
      return text ? <li key={index}>{text}</li> : null;
    })}</ul></section>;
  })}</>;
}

export function AssistantMessageView({ message, onWorkflowResume, onQuizComplete }: {
  message: AssistantMessage;
  onWorkflowResume?: (runId: string, value: string, kind: "student-work" | "career-data") => Promise<void>;
  onQuizComplete?: (runId: string, attemptId: string) => Promise<void>;
}) {
  const user = message.role === "user";
  const presentation = message.presentation;
  const agent = presentation?.targetName ?? (message.agentId ? names[message.agentId] ?? message.agentId : "Academic AI");
  return (
    <Message align={user ? "end" : "start"}>
      {!user && <MessageAvatar className="h-9 w-9 bg-primary text-primary-foreground"><Sparkles size={17} /></MessageAvatar>}
      <MessageContent className={user ? "max-w-[86%] sm:max-w-[75%]" : "max-w-full"}>
        {!user && <MessageHeader className="gap-2"><span>{agent}</span>{presentation?.kind === "workflow" && <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px]">Guided activity</span>}</MessageHeader>}
        <Bubble align={user ? "end" : "start"} variant={user ? "default" : presentation?.kind === "error" ? "destructive" : "outline"} className={user ? "" : "w-full max-w-full"}>
          <BubbleContent className={`${user ? "" : "w-full bg-card p-4 sm:p-5"} whitespace-pre-wrap`}>{message.content}</BubbleContent>
        </Bubble>
        {!user && presentation && <div className="mt-2 space-y-3">
          {presentation.workflow && <WorkflowCard workflow={presentation.workflow} onResume={onWorkflowResume ? (value, kind) => onWorkflowResume(presentation.workflow!.runId, value, kind) : undefined} />}
          {presentation.quiz && <QuizCard quiz={presentation.quiz} runId={presentation.workflow?.runId} onComplete={presentation.workflow?.waitingFor?.kind === "quiz" && onQuizComplete ? (attemptId) => onQuizComplete(presentation.workflow!.runId, attemptId) : undefined} />}
          {presentation.studyPlan && <StudyPlanCard initialPlan={presentation.studyPlan} />}
          <StructuredSections presentation={presentation} />
          {presentation.sources && presentation.sources.length > 0 && <section className="assistant-sources"><h4 className="flex items-center gap-2 text-sm font-medium"><BookOpen size={16} /> Sources</h4><div className="mt-2 flex flex-wrap gap-2">{[...new Map(presentation.sources.map((source) => [`${source.documentId}:${source.pageNumber ?? ""}:${source.pageEnd ?? ""}`, source])).values()].map((source) => <Link className="assistant-source-link" href={`/student/documents/${source.documentId}`} key={`${source.documentId}-${source.chunkIndex}`}>{source.documentTitle}{source.pageNumber ? ` · p. ${source.pageNumber}${source.pageEnd && source.pageEnd !== source.pageNumber ? `–${source.pageEnd}` : ""}` : ""}<ExternalLink size={12} /></Link>)}</div></section>}
        </div>}
      </MessageContent>
      {user && <MessageAvatar className="h-9 w-9"><Bot size={17} /></MessageAvatar>}
    </Message>
  );
}
