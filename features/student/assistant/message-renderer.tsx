"use client";

import { Bot, Sparkles } from "lucide-react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { MessageFeedback } from "./message-feedback";
import { AIResultRenderer } from "./result-renderer";
import type { AssistantAction, AssistantMessage } from "./types";

const names: Record<string, string> = { tutor: "Tutor", notes: "Notes", quiz: "Quiz", "study-planner": "Study Planner", "academic-manager": "Academic Manager", career: "Career" };

export function AssistantMessageView({ message, onWorkflowResume, onQuizComplete, onAction, actionBusy }: {
  message: AssistantMessage;
  onWorkflowResume?: (runId: string, value: string, kind: "student-work" | "career-data") => Promise<void>;
  onQuizComplete?: (runId: string, attemptId: string) => Promise<void>;
  onAction?: (action: AssistantAction) => void | Promise<void>;
  actionBusy?: boolean;
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
        {!user && presentation && <AIResultRenderer result={presentation} onWorkflowResume={onWorkflowResume} onQuizComplete={onQuizComplete} onAction={onAction} actionBusy={actionBusy} />}
        {!user && message.metadata?.workspaceVisible === true && presentation?.kind !== "error" && <MessageFeedback key={message.id} messageId={message.id} />}
      </MessageContent>
      {user && <MessageAvatar className="h-9 w-9"><Bot size={17} /></MessageAvatar>}
    </Message>
  );
}
