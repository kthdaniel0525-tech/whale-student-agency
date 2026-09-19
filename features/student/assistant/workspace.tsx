"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  BookOpen, CalendarDays, CheckCircle2, ChevronLeft, FileText,
  GraduationCap, History, Loader2, MessageSquarePlus, PanelLeft, Paperclip, Send,
  Sparkles, Target, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { AssistantMessageView } from "./message-renderer";
import type {
  AssistantAgentId, AssistantBootstrap, AssistantConversation, AssistantConversationSummary,
  AssistantAction, AssistantLaunch, AssistantMessage, AssistantRequestPayload, AssistantRequestResponse,
  AssistantQuiz, AssistantStudyPlan, AssistantWorkflow,
} from "./types";

const agents: Array<[AssistantAgentId, string]> = [
  ["auto", "Auto"], ["tutor", "Tutor"], ["notes", "Notes"], ["quiz", "Quiz"],
  ["study-planner", "Planner"], ["academic-manager", "Academic Manager"], ["career", "Career"],
];

const generalPrompts = [
  ["Study today", "What should I focus on today?", CalendarDays],
  ["Quiz me", "Quiz me on a topic I need to practice.", Target],
  ["Weakest topic", "Explain my weakest topic and give me one example.", BookOpen],
  ["Deadlines", "Review my upcoming deadlines and tell me what to do first.", CheckCircle2],
] as const;

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Something went wrong. Please try again.");
  return body;
}

function updateHistory(items: AssistantConversationSummary[], value: AssistantConversationSummary) {
  return [value, ...items.filter((item) => item.id !== value.id)].slice(0, 30);
}

function temporaryMessage(role: "user" | "assistant", content: string, turnId: string): AssistantMessage {
  return { id: `temporary-${role}-${turnId}`, turnId, role, content, agentId: null, createdAt: new Date().toISOString(), metadata: null };
}

export function AssistantWorkspace({
  initial,
  initialLaunch,
  initialConversation,
  initialWorkflow,
}: {
  initial: AssistantBootstrap;
  initialLaunch?: AssistantLaunch;
  initialConversation?: AssistantConversation;
  initialWorkflow?: AssistantMessage;
}) {
  const [conversations, setConversations] = useState(() => initialConversation
    ? updateHistory(initial.conversations, initialConversation)
    : initial.conversations);
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversation?.id);
  const [messages, setMessages] = useState<AssistantMessage[]>(initialConversation?.messages ?? (initialWorkflow ? [initialWorkflow] : []));
  const [courseId, setCourseId] = useState(initialLaunch?.courseId ?? initialConversation?.courseId ?? "");
  const [documentIds, setDocumentIds] = useState<string[]>(initialLaunch?.documentIds ?? []);
  const [assignmentId, setAssignmentId] = useState(initialLaunch?.assignmentId ?? "");
  const [examId, setExamId] = useState(initialLaunch?.examId ?? "");
  const [agentId, setAgentId] = useState<AssistantAgentId>("auto");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Reviewing your academic context…");
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [error, setError] = useState<string>();
  const activeRequest = useRef(false);
  const launchStarted = useRef(false);

  const course = initial.courses.find((item) => item.id === courseId);
  const conversation = conversations.find((item) => item.id === conversationId);
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const activeName = String(lastAssistant?.metadata?.targetName ?? "Academic AI");
  const suggestions = useMemo(() => {
    if (documentIds.length) return ["Summarize this lecture.", "Teach me this material, then quiz me."];
    if (examId) return ["Prepare me for this exam.", "Make a realistic exam study plan."];
    if (courseId) return ["Explain my weakest topic in this course.", "Quiz me on this course.", "What should I study next?"];
    return generalPrompts.map((item) => item[1]);
  }, [courseId, documentIds.length, examId]);

  function resetContext(nextCourse = "") {
    setCourseId(nextCourse); setDocumentIds([]); setAssignmentId(""); setExamId("");
  }

  function updateConversationUrl(id?: string) {
    window.history.replaceState(
      window.history.state,
      "",
      id ? `/student/assistant?conversationId=${encodeURIComponent(id)}` : "/student/assistant",
    );
  }

  function newConversation() {
    setConversationId(undefined); setMessages([]); resetContext(); setAgentId("auto"); setError(undefined); setHistoryOpen(false);
    updateConversationUrl();
  }

  async function openConversation(id: string) {
    if (busy || loadingConversation) return;
    setLoadingConversation(true); setError(undefined);
    try {
      const loaded = await json<AssistantConversation>(await fetch(`/api/student/assistant/conversations/${id}`));
      setConversationId(loaded.id); setMessages(loaded.messages); resetContext(loaded.courseId ?? ""); setHistoryOpen(false);
      updateConversationUrl(loaded.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The conversation could not be loaded."); }
    finally { setLoadingConversation(false); }
  }

  function applyCourse(nextCourse: string) {
    if (conversationId && nextCourse !== (conversation?.courseId ?? "")) {
      setConversationId(undefined); setMessages([]);
      updateConversationUrl();
    }
    resetContext(nextCourse);
  }

  async function sendPrompt(text = draft, overrides: Partial<AssistantRequestPayload> = {}) {
    const request = text.trim();
    if (!request || activeRequest.current) return;
    activeRequest.current = true; setBusy(true); setError(undefined); setDraft("");
    const turnId = crypto.randomUUID();
    const optimistic = temporaryMessage("user", request, turnId);
    const streamingId = `temporary-assistant-${turnId}`;
    setMessages((current) => [...current, optimistic]);
    const payload: AssistantRequestPayload = {
      request, turnId,
      ...(conversationId ? { conversationId } : {}),
      ...(courseId ? { courseId } : {}),
      ...(documentIds.length ? { documentIds } : {}),
      ...(assignmentId ? { assignmentId } : {}),
      ...(examId ? { examId } : {}),
      ...(agentId !== "auto" ? { preferredAgentId: agentId } : {}),
      ...overrides,
    };
    try {
      const response = await fetch("/api/student/assistant/requests/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok || !response.body) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || "The AI request could not be completed.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamed = "";
      let result: AssistantRequestResponse | undefined;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = done ? "" : lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type: string; text?: string; message?: string; data?: AssistantRequestResponse };
          if (event.type === "status" && event.message) setStatusMessage(event.message);
          if (event.type === "delta" && event.text) {
            streamed += event.text;
            const partial = { ...temporaryMessage("assistant", streamed, turnId), id: streamingId, presentation: { mode: "agent" as const, kind: "agent" as const, targetName: "Academic AI" } };
            setMessages((current) => current.some((message) => message.id === streamingId) ? current.map((message) => message.id === streamingId ? partial : message) : [...current, partial]);
          }
          if (event.type === "error") throw new Error(event.message || "The AI request could not be completed.");
          if (event.type === "result" && event.data) result = event.data;
        }
        if (done) break;
      }
      if (!result) throw new Error("The AI response ended before it was complete.");
      setConversationId(result.conversation.id);
      updateConversationUrl(result.conversation.id);
      setConversations((current) => updateHistory(current, result.conversation));
      setMessages((current) => [...current.filter((message) => message.id !== optimistic.id && message.id !== streamingId), result.userMessage, result.assistantMessage]);
    } catch (cause) {
      setMessages((current) => current.filter((message) => message.id !== optimistic.id && message.id !== streamingId));
      setDraft(request);
      setError(cause instanceof Error ? cause.message : "The AI request could not be completed.");
    } finally { activeRequest.current = false; setBusy(false); setStatusMessage("Reviewing your academic context…"); }
  }

  const launchPrompt = useEffectEvent((launch: AssistantLaunch) => {
    void sendPrompt(launch.request, launch);
  });
  useEffect(() => {
    if (!initialLaunch || launchStarted.current) return;
    launchStarted.current = true;
    launchPrompt(initialLaunch);
  }, [initialLaunch]);

  async function startRecommendation(id: string, title: string, message: string) {
    if (busy) return;
    try {
      const action = await json<{ target: { type: "agent" | "workflow"; id: string }; payload: Record<string, string | number | boolean | null> }>(await fetch(`/api/student/recommendations/${id}/action`, { method: "POST" }));
      const selectedCourse = typeof action.payload.courseId === "string" ? action.payload.courseId : courseId;
      const startsNewConversation = Boolean(
        conversationId && conversation?.courseId && selectedCourse && selectedCourse !== conversation.courseId,
      );
      if (selectedCourse) {
        if (startsNewConversation) applyCourse(selectedCourse);
        else resetContext(selectedCourse);
      }
      const override: Partial<AssistantRequestPayload> = {
        ...(startsNewConversation ? { conversationId: undefined } : {}),
        ...(selectedCourse ? { courseId: selectedCourse } : {}),
        documentIds: typeof action.payload.documentId === "string" ? [action.payload.documentId] : [],
        assignmentId: typeof action.payload.assignmentId === "string" ? action.payload.assignmentId : undefined,
        examId: typeof action.payload.examId === "string" ? action.payload.examId : undefined,
        projectIds: typeof action.payload.projectId === "string" ? [action.payload.projectId] : undefined,
        ...(action.target.type === "agent" ? { preferredAgentId: action.target.id as Exclude<AssistantAgentId, "auto"> } : { preferredWorkflowId: action.target.id }),
      };
      await sendPrompt(`${title}. ${message}`, override);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This recommendation could not be started."); }
  }

  async function runResultAction(action: AssistantAction) {
    if (busy) return;
    if (action.confirmationRequired && !window.confirm(`Continue with “${action.label}”?`)) return;
    const payload = action.payload ?? {};
    const selectedCourse = payload.courseId ?? courseId;
    const startsNewConversation = Boolean(conversationId && conversation?.courseId && selectedCourse && selectedCourse !== conversation.courseId);
    if (payload.courseId && payload.courseId !== courseId) {
      if (startsNewConversation) applyCourse(payload.courseId);
      else resetContext(payload.courseId);
    }
    const allowedAgent = agents.some(([id]) => id === action.targetId && id !== "auto");
    const overrides: Partial<AssistantRequestPayload> = {
      ...(startsNewConversation ? { conversationId: undefined } : {}),
      ...(selectedCourse ? { courseId: selectedCourse } : {}),
      ...(payload.documentIds ? { documentIds: payload.documentIds } : {}),
      ...(payload.assignmentId ? { assignmentId: payload.assignmentId } : {}),
      ...(payload.examId ? { examId: payload.examId } : {}),
      ...(payload.topicId ? { topicId: payload.topicId } : {}),
      ...(payload.topicName ? { topicName: payload.topicName } : {}),
      ...(payload.studyPlanId ? { studyPlanId: payload.studyPlanId } : {}),
      ...(payload.projectIds ? { projectIds: payload.projectIds } : {}),
      ...(payload.targetRole ? { targetRole: payload.targetRole } : {}),
      ...(payload.targetIndustry ? { targetIndustry: payload.targetIndustry } : {}),
      ...(payload.targetCompanies ? { targetCompanies: payload.targetCompanies } : {}),
      ...(payload.applicationTimeline ? { applicationTimeline: payload.applicationTimeline } : {}),
      ...(payload.availableWeeklyMinutes ? { availableWeeklyMinutes: payload.availableWeeklyMinutes } : {}),
      ...(action.targetType === "agent" && allowedAgent
        ? { preferredAgentId: action.targetId as Exclude<AssistantAgentId, "auto"> }
        : action.targetType === "workflow" ? { preferredWorkflowId: action.targetId } : {}),
    };
    if (action.targetType === "agent" && !allowedAgent) {
      setError("This action is no longer available.");
      return;
    }
    await sendPrompt(action.prompt, overrides);
  }

  function applyWorkflowResponse(result: {
    workflow?: AssistantWorkflow;
    quiz?: AssistantQuiz;
    studyPlan?: AssistantStudyPlan;
    userMessage?: AssistantMessage;
    assistantMessage?: AssistantMessage;
  }, runId: string) {
    if (!result.userMessage || !result.assistantMessage) {
      if (result.workflow) setMessages((current) => current.map((message) => message.presentation?.workflow?.runId === runId
        ? { ...message, content: result.workflow!.summary, presentation: { ...message.presentation,
          workflow: result.workflow, quiz: result.quiz, studyPlan: result.studyPlan } } : message));
      return;
    }
    setMessages((current) => [
      ...current.map((message) => message.presentation?.workflow?.runId === runId
        ? { ...message, presentation: undefined }
        : message),
      result.userMessage!,
      result.assistantMessage!,
    ]);
  }

  async function resumeWorkflow(runId: string, value: string, kind: "student-work" | "career-data") {
    const turnId = crypto.randomUUID();
    const body = kind === "student-work" ? { turnId, userWork: value } : { turnId, careerData: { experienceSummary: value } };
    const result = await json<{ workflow?: AssistantWorkflow; quiz?: AssistantQuiz; studyPlan?: AssistantStudyPlan; userMessage?: AssistantMessage; assistantMessage?: AssistantMessage }>(await fetch(`/api/student/assistant/workflows/${runId}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    applyWorkflowResponse(result, runId);
  }

  async function completeWorkflowQuiz(runId: string, quizAttemptId: string) {
    const turnId = crypto.randomUUID();
    const result = await json<{ workflow?: AssistantWorkflow; quiz?: AssistantQuiz; studyPlan?: AssistantStudyPlan; userMessage?: AssistantMessage; assistantMessage?: AssistantMessage }>(await fetch(`/api/student/assistant/workflows/${runId}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnId, quizAttemptId }) }));
    applyWorkflowResponse(result, runId);
  }

  function addDocument(id: string) {
    if (id && !documentIds.includes(id)) setDocumentIds((current) => [...current, id].slice(0, 10));
  }

  return (
    <div className="assistant-workspace">
      <aside className={`assistant-history ${historyOpen ? "is-open" : ""}`} aria-label="Conversation history">
        <div className="flex items-center justify-between gap-2 px-3 pb-4"><div className="flex items-center gap-2 font-semibold"><History size={18} /> Conversations</div><Button size="icon-sm" variant="ghost" className="lg:hidden" aria-label="Close conversation history" onClick={() => setHistoryOpen(false)}><ChevronLeft /></Button></div>
        <Button className="w-full justify-start" variant="outline" onClick={newConversation}><MessageSquarePlus /> New chat</Button>
        <div className="mt-4 space-y-1 overflow-y-auto">
          {conversations.length ? conversations.map((item) => <button key={item.id} className={`assistant-history-item ${item.id === conversationId ? "is-active" : ""}`} onClick={() => openConversation(item.id)}><span>{item.title || "New conversation"}</span><small>{item.courseName ?? new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(item.lastMessageAt))}</small></button>) : <p className="px-2 py-5 text-sm muted">Your conversations will appear here.</p>}
        </div>
      </aside>
      {historyOpen && <button className="assistant-backdrop lg:hidden" aria-label="Close conversation history" onClick={() => setHistoryOpen(false)} />}

      <section className="assistant-chat" aria-label="AI conversation">
        <header className="assistant-chat-header">
          <Button size="icon-sm" variant="ghost" className="lg:hidden" aria-label="Open conversation history" onClick={() => setHistoryOpen(true)}><PanelLeft /></Button>
          <div className="min-w-0"><h1 className="truncate text-lg font-semibold">{conversation?.title ?? (course ? course.courseCode : "Academic AI")}</h1><p className="truncate text-xs muted">{course ? `${course.courseCode} ${course.courseName} · ` : ""}{activeName}</p></div>
          <Button className="ml-auto" size="sm" variant="outline" onClick={newConversation}><MessageSquarePlus /> <span className="hidden sm:inline">New chat</span></Button>
        </header>

        <div className="assistant-messages" aria-live="polite" aria-busy={busy || loadingConversation}>
          {loadingConversation ? <div className="flex min-h-72 items-center justify-center gap-2 muted"><Loader2 className="animate-spin" /> Loading conversation…</div> : messages.length ? (
            <div className="mx-auto w-full max-w-3xl space-y-7 py-7">{messages.map((message) => <AssistantMessageView key={message.id} message={message} onWorkflowResume={resumeWorkflow} onQuizComplete={completeWorkflowQuiz} onAction={runResultAction} actionBusy={busy} />)}{busy && <div className="assistant-thinking"><span /><span /><span /> <p>{statusMessage}</p></div>}</div>
          ) : (
            <div className="assistant-welcome"><span className="assistant-welcome-icon"><Sparkles /></span><h2>What can I help you accomplish?</h2><p>Ask naturally. I’ll choose the right academic support and use only the context you allow.</p><div className="assistant-prompt-grid">{generalPrompts.map(([label, prompt, Icon]) => <button key={label} onClick={() => sendPrompt(prompt)}><Icon size={18} /><span><strong>{label}</strong><small>{prompt}</small></span></button>)}</div>{initial.recommendations.length > 0 && <div className="assistant-recommendations"><p className="eyebrow">Recommended for you</p>{initial.recommendations.slice(0, 3).map((recommendation) => <button key={recommendation.id} onClick={() => startRecommendation(recommendation.id, recommendation.title, recommendation.message)}><span className={`recommendation-dot priority-${recommendation.priority}`} /><span><strong>{recommendation.title}</strong><small>{recommendation.message}</small></span></button>)}</div>}</div>
          )}
        </div>

        <div className="assistant-composer-wrap">
          <div className="mx-auto w-full max-w-3xl">
            {(courseId || documentIds.length || assignmentId || examId) && <div className="assistant-chips" aria-label="Selected context">{course && <button onClick={() => applyCourse("")}><GraduationCap /> {course.courseCode}<X /></button>}{documentIds.map((id) => { const document = course?.documents.find((item) => item.id === id); return document ? <button key={id} onClick={() => setDocumentIds((current) => current.filter((item) => item !== id))}><FileText /> {document.title}<X /></button> : null; })}{assignmentId && <button onClick={() => setAssignmentId("")}><CheckCircle2 /> {course?.assignments.find((item) => item.id === assignmentId)?.title}<X /></button>}{examId && <button onClick={() => setExamId("")}><CalendarDays /> {course?.exams.find((item) => item.id === examId)?.title}<X /></button>}</div>}
            {error && <div className="assistant-error" role="alert"><span>{error}</span><Button size="sm" variant="ghost" onClick={() => setError(undefined)}>Dismiss</Button></div>}
            <form className="assistant-composer" onSubmit={(event) => { event.preventDefault(); sendPrompt(); }}>
              <Textarea aria-label="Message Academic AI" placeholder="Ask your academic AI…" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendPrompt(); } }} disabled={busy} className="min-h-14 max-h-48 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0" />
              <div className="assistant-composer-tools"><Button type="button" size="sm" variant={contextOpen ? "secondary" : "ghost"} onClick={() => setContextOpen((value) => !value)} aria-expanded={contextOpen}><Paperclip /> Context</Button><NativeSelect value={agentId} onChange={(event) => setAgentId(event.target.value as AssistantAgentId)} aria-label="Preferred AI specialist">{agents.map(([id, label]) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}</NativeSelect><Button type="submit" size="icon" aria-label="Send message" disabled={busy || !draft.trim()}>{busy ? <Loader2 className="animate-spin" /> : <Send />}</Button></div>
            </form>
            {contextOpen && <div className="assistant-context-panel"><div className="field"><label htmlFor="assistant-course">Course</label><NativeSelect id="assistant-course" value={courseId} onChange={(event) => applyCourse(event.target.value)}><NativeSelectOption value="">Any course</NativeSelectOption>{initial.courses.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.courseCode} · {item.courseName}</NativeSelectOption>)}</NativeSelect></div><div className="field"><label htmlFor="assistant-document">Document</label><NativeSelect id="assistant-document" value="" disabled={!course} onChange={(event) => addDocument(event.target.value)}><NativeSelectOption value="">{course ? "Add a document" : "Select a course first"}</NativeSelectOption>{course?.documents.filter((item) => !documentIds.includes(item.id)).map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.title}</NativeSelectOption>)}</NativeSelect></div><div className="field"><label htmlFor="assistant-assignment">Assignment</label><NativeSelect id="assistant-assignment" value={assignmentId} disabled={!course} onChange={(event) => setAssignmentId(event.target.value)}><NativeSelectOption value="">None</NativeSelectOption>{course?.assignments.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.title}</NativeSelectOption>)}</NativeSelect></div><div className="field"><label htmlFor="assistant-exam">Exam</label><NativeSelect id="assistant-exam" value={examId} disabled={!course} onChange={(event) => setExamId(event.target.value)}><NativeSelectOption value="">None</NativeSelectOption>{course?.exams.map((item) => <NativeSelectOption key={item.id} value={item.id}>{item.title}</NativeSelectOption>)}</NativeSelect></div></div>}
            <div className="assistant-suggestions" aria-label="Suggested prompts">{suggestions.slice(0, 3).map((prompt) => <button key={prompt} onClick={() => sendPrompt(prompt)} disabled={busy}>{prompt}</button>)}</div>
            <p className="assistant-disclaimer">AI can make mistakes. Check important course requirements and deadlines.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
