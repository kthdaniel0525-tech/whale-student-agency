import { trackProductEvent } from "../product-analytics/service";
import { checkAIUsageAllowance } from "../entitlements/usage";
import "server-only";
import { z } from "zod";
import { captureUsageContext, withAIUsageContext } from "../ai/usage/context";
import { claimAIRequest } from "../ai/guardrails/requests";
import { guardrails } from "../ai/guardrails/service";
import { AIError } from "../ai/errors";
import { auth } from "../auth/config";
import { db } from "../db/client";
import {
  appendConversationMessage,
  createConversation,
  getConversation,
  getConversationScope,
  listConversations,
  type ConversationMessageRecord,
  type ConversationRecord,
} from "../conversations";
import { handleUserAIRequest, IntelligentDispatcher } from "../dispatcher";
import { getTopRecommendations } from "../recommendations";
import { createQuizAgentService } from "../agents/quiz";
import { createStudyPlannerAgentService } from "../agents/study-planner";
import { createStudentAgentRegistry } from "../agents/student-service";
import { AgentExecutor } from "../agents/executor";
import { TUTOR_INSTRUCTIONS } from "../agents/tutor/instructions";
import { NOTES_INSTRUCTIONS } from "../agents/notes/instructions";
import { WorkflowService } from "../workflows";
import type {
  AssistantBootstrap,
  AssistantConversation,
  AssistantConversationSummary,
  AssistantMessage,
  AssistantPresentation,
  AssistantQuiz,
  AssistantRequestResponse,
} from "@/features/student/assistant/types";
import {
  buildAgentActions,
  buildWorkflowActions,
  parseSources,
  parseStructuredPresentation,
  serializeSources,
  serializeStructuredPresentation,
} from "./presentation";

const id = z.string().min(1).max(100);
const requestSchema = z.object({
  request: z.string().trim().min(1).max(4000),
  conversationId: id.optional(),
  turnId: id,
  courseId: id.optional(),
  documentIds: z.array(id).max(10).transform((items) => [...new Set(items)]).optional(),
  assignmentId: id.optional(),
  examId: id.optional(),
  topicId: id.optional(),
  topicName: z.string().trim().min(1).max(200).optional(),
  studyPlanId: id.optional(),
  projectIds: z.array(id).min(1).max(10).transform((items) => [...new Set(items)]).optional(),
  targetRole: z.string().trim().min(1).max(160).optional(),
  targetIndustry: z.string().trim().min(1).max(120).optional(),
  targetCompanies: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  applicationTimeline: z.string().trim().min(1).max(100).optional(),
  availableWeeklyMinutes: z.number().int().min(30).max(2400).optional(),
  preferredAgentId: z.enum(["tutor", "notes", "quiz", "study-planner", "academic-manager", "career"]).optional(),
  preferredWorkflowId: z.enum(["exam-preparation", "weak-topic-recovery", "lecture-study", "assignment-support", "career-preparation"]).optional(),
}).strict();

const resumeSchema = z.object({
  turnId: id,
  userWork: z.string().trim().min(1).max(6000).optional(),
  quizAttemptId: id.optional(),
  careerData: z.object({
    resumeData: z.string().trim().min(1).max(5000).optional(),
    experienceSummary: z.string().trim().min(1).max(2000).optional(),
    portfolioLinks: z.array(z.string().url().max(500)).max(8).optional(),
  }).strict().optional(),
}).strict().refine((value) => [value.userWork, value.quizAttemptId, value.careerData].filter(Boolean).length === 1, "Supply one workflow response.");

const answerSchema = z.object({
  questionId: id,
  userAnswer: z.string().trim().min(1).max(4000),
  quizAttemptId: id.optional(),
  runId: id.optional(),
}).strict();

const taskSchema = z.enum(["planned", "in-progress", "completed", "skipped"]);

function publicConversation(record: Omit<ConversationRecord, "lastMessageAt" | "createdAt" | "updatedAt"> & {
  lastMessageAt: string | Date;
  createdAt: string | Date;
  updatedAt: string | Date;
}, courseName: string | null = null): AssistantConversationSummary {
  return {
    id: record.id, title: record.title, courseId: record.courseId, courseName,
    messageCount: record.messageCount,
    lastMessageAt: record.lastMessageAt instanceof Date ? record.lastMessageAt.toISOString() : record.lastMessageAt,
  };
}

function visibleMessage(message: ConversationMessageRecord): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (message.metadata?.workspaceVisible === true) return true;
  if (message.metadata?.workspaceVisible === false) return false;
  if (message.role === "user" && (message.metadata?.agentId || message.metadata?.workflow)) return false;
  if (message.role === "assistant" && message.metadata?.schemaName) return false;
  return true;
}

function publicMessage(message: ConversationMessageRecord, presentation?: AssistantPresentation): AssistantMessage {
  return {
    id: message.id,
    turnId: message.turnId,
    role: message.role as "user" | "assistant",
    content: message.content,
    agentId: message.agentId,
    createdAt: message.createdAt,
    metadata: message.metadata ? { ...message.metadata } : null,
    ...(presentation ? { presentation } : {}),
  };
}

function metadata(value: Record<string, string | number | boolean | null>) {
  return { workspaceVisible: true, ...value };
}

function agentArtifact(targetId: string, value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object") return {};
  if (targetId === "quiz") return { artifactType: "quiz", artifactId: String((value as { id?: unknown }).id ?? "") };
  if (targetId === "study-planner" && "id" in value) return { artifactType: "study-plan", artifactId: String((value as { id?: unknown }).id ?? "") };
  return { artifactType: targetId };
}

async function hydrateWorkflow(result: Awaited<ReturnType<WorkflowService["getRun"]>>, headers: Headers) {
  const quizId = result.waitingFor?.kind === "quiz"
    ? result.waitingFor.referenceId
    : typeof result.outputs.quizId === "string" ? result.outputs.quizId : undefined;
  const studyPlanId = typeof result.outputs.studyPlanId === "string" ? result.outputs.studyPlanId : undefined;
  const [quiz, studyPlan] = await Promise.all([
    quizId ? hydrateQuizExperience(quizId, headers).catch(() => undefined) : undefined,
    studyPlanId ? createStudyPlannerAgentService().getPlan(studyPlanId, headers).catch(() => undefined) : undefined,
  ]);
  return { ...(quiz ? { quiz } : {}), ...(studyPlan ? { studyPlan } : {}) };
}

async function hydrateQuizExperience(quizId: string, headers: Headers): Promise<AssistantQuiz> {
  const quiz = await createQuizAgentService().getQuiz(quizId, headers);
  const session = await auth().api.getSession({ headers: new Headers(headers), query: { disableRefresh: true } });
  if (!session?.user.id) throw new AssistantWorkspaceError("NOT_FOUND");
  const attempt = await db().quizAttempt.findFirst({
    where: { quizId, userId: session.user.id, quiz: { userId: session.user.id } },
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    include: {
      questionAttempts: {
        orderBy: { attemptedAt: "asc" },
        include: { question: { select: { correctAnswer: true, explanation: true } } },
      },
    },
  });
  return {
    ...quiz,
    sources: [...quiz.sources],
    ...(attempt ? {
      attempt: {
        id: attempt.id,
        completedAt: attempt.completedAt?.toISOString() ?? null,
        evaluations: attempt.questionAttempts.map((answer) => ({
          quizId,
          questionId: answer.questionId,
          quizAttemptId: attempt.id,
          correct: answer.isCorrect,
          score: answer.score,
          userAnswer: answer.userAnswer,
          feedback: answer.isCorrect ? "Correct." : `Incorrect. The correct answer is ${answer.question.correctAnswer}.`,
          explanation: answer.question.explanation,
          method: answer.evaluationMethod === "DETERMINISTIC" ? "deterministic" : "semantic",
        })),
      },
    } : { attempt: null }),
  };
}

export async function getAssistantBootstrap(userId: string): Promise<AssistantBootstrap> {
  const [courses, conversations, recommendations] = await Promise.all([
    db().course.findMany({
      where: { userId },
      orderBy: [{ semester: "desc" }, { courseCode: "asc" }],
      take: 30,
      select: {
        id: true, courseCode: true, courseName: true,
        documents: { where: { userId, processingStatus: "READY" }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, title: true } },
        assignments: { where: { userId, status: { not: "COMPLETED" } }, orderBy: { dueDate: "asc" }, take: 30, select: { id: true, title: true, dueDate: true } },
        exams: { where: { userId, examDate: { gte: new Date() } }, orderBy: { examDate: "asc" }, take: 20, select: { id: true, title: true, examDate: true } },
      },
    }),
    db().conversation.findMany({
      where: { userId }, orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }], take: 30,
      include: { course: { select: { courseCode: true, courseName: true } } },
    }),
    getTopRecommendations({ userId, limit: 5 }),
  ]);
  return {
    courses: courses.map((course) => ({
      id: course.id,
      title: `${course.courseCode} ${course.courseName}`,
      courseCode: course.courseCode,
      courseName: course.courseName,
      documents: course.documents.map((document) => ({ id: document.id, title: document.title, courseId: course.id })),
      assignments: course.assignments.map((assignment) => ({ id: assignment.id, title: assignment.title, subtitle: assignment.dueDate.toISOString(), courseId: course.id })),
      exams: course.exams.map((exam) => ({ id: exam.id, title: exam.title, subtitle: exam.examDate.toISOString(), courseId: course.id })),
    })),
    conversations: conversations.map((conversation) => publicConversation(conversation, conversation.course ? `${conversation.course.courseCode} ${conversation.course.courseName}` : null)),
    recommendations: recommendations.map(({ id, title, message, priority }) => ({ id, title, message, priority })),
  };
}

export async function createAssistantConversation(raw: unknown, headers: Headers) {
  const parsed = z.object({ courseId: id.optional() }).strict().safeParse(raw);
  if (!parsed.success) throw new AssistantWorkspaceError("INVALID_REQUEST");
  return publicConversation(await createConversation(parsed.data, headers));
}

export async function listAssistantConversations(headers: Headers) {
  const conversations = await listConversations(headers, 30);
  return conversations.map((conversation) => publicConversation(conversation));
}

export async function getAssistantConversation(conversationId: string, headers: Headers): Promise<AssistantConversation> {
  const conversation = await getConversation(conversationId, headers, 100);
  const messages = conversation.messages.filter(visibleMessage);
  const latestWorkflowMessage = new Map<string, number>();
  messages.forEach((message, index) => {
    const runId = typeof message.metadata?.workflowRunId === "string" ? message.metadata.workflowRunId : undefined;
    if (message.role === "assistant" && runId) latestWorkflowMessage.set(runId, index);
  });
  const presentations = await Promise.all(messages.map(async (message, index): Promise<AssistantPresentation | undefined> => {
    if (message.role !== "assistant" || !message.metadata) return undefined;
    const targetId = typeof message.metadata.targetId === "string" ? message.metadata.targetId : undefined;
    const targetName = typeof message.metadata.targetName === "string" ? message.metadata.targetName : undefined;
    const runId = typeof message.metadata.workflowRunId === "string" ? message.metadata.workflowRunId : undefined;
    if (runId) {
      if (latestWorkflowMessage.get(runId) !== index) return undefined;
      const workflow = await new WorkflowService().getRun(runId, headers).catch(() => undefined);
      if (!workflow) return undefined;
      return {
        mode: "workflow", kind: "workflow", targetId, targetName, workflow,
        status: workflow.status,
        actions: buildWorkflowActions(workflow, { ...(conversation.courseId ? { courseId: conversation.courseId } : {}) }),
        ...(await hydrateWorkflow(workflow, headers)),
      };
    }
    const artifactType = message.metadata.artifactType;
    const artifactId = typeof message.metadata.artifactId === "string" ? message.metadata.artifactId : undefined;
    if (artifactType === "quiz" && artifactId) {
      const quiz = await getAssistantQuiz(artifactId, headers).catch(() => undefined);
      return quiz ? { mode: "agent", kind: "agent", targetId, targetName, quiz, structuredData: quiz, sources: [...(quiz.sources ?? [])], actions: [] } : undefined;
    }
    if (artifactType === "study-plan" && artifactId) {
      const studyPlan = await createStudyPlannerAgentService().getPlan(artifactId, headers).catch(() => undefined);
      return studyPlan ? { mode: "agent", kind: "agent", targetId, targetName, studyPlan, structuredData: studyPlan, actions: buildAgentActions("study-planner", studyPlan, { studyPlanId: artifactId, ...(conversation.courseId ? { courseId: conversation.courseId } : {}) }) } : undefined;
    }
    const kind = message.metadata.presentationKind;
    if (kind === "agent" || kind === "clarification" || kind === "error") {
      const structuredData = parseStructuredPresentation(message.metadata.presentationData);
      const sources = parseSources(message.metadata.sourceRefs);
      return {
        mode: "agent", kind, targetId, targetName,
        ...(structuredData !== undefined ? { structuredData } : {}),
        ...(sources.length ? { sources } : {}),
        actions: targetId ? buildAgentActions(targetId, structuredData, { ...(conversation.courseId ? { courseId: conversation.courseId } : {}) }) : [],
      };
    }
    return undefined;
  }));
  return {
    ...publicConversation(conversation),
    messages: messages.map((message, index) => publicMessage(message, presentations[index])),
  };
}

function assistantText(result: Awaited<ReturnType<typeof handleUserAIRequest>>) {
  if (result.needsClarification) return result.clarificationQuestion;
  if (result.mode === "workflow") return result.result.summary;
  return result.result.ok ? result.result.response.content : result.result.error.message;
}

export async function executeAssistantRequest(
  raw: unknown,
  headers: Headers,
  options: { execute?: typeof handleUserAIRequest } = {},
): Promise<AssistantRequestResponse> {
  return guardedAssistant(raw, headers, false, requested => executeAssistantRequestCore(requested, headers, options)) as Promise<AssistantRequestResponse>;
}

async function executeAssistantRequestCore(
  raw: unknown, headers: Headers, options: { execute?: typeof handleUserAIRequest } = {},
): Promise<AssistantRequestResponse> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new AssistantWorkspaceError("INVALID_REQUEST");
  const requested = parsed.data;
  const conversationId = requested.conversationId
    ? await getConversationScope(requested.conversationId, headers).then(() => requested.conversationId!)
    : (await createConversation({ ...(requested.courseId ? { courseId: requested.courseId } : {}) }, headers)).id;
  let conversation = await getConversation(conversationId, headers, 100);
  if (requested.courseId && conversation.courseId && requested.courseId !== conversation.courseId) throw new AssistantWorkspaceError("CONTEXT_MISMATCH");

  const existing = conversation.messages;
  const existingAssistant = existing.find((message) => message.role === "assistant" && message.turnId === requested.turnId && message.metadata?.workspaceVisible === true);
  const existingUser = existing.find((message) => message.role === "user" && message.turnId === requested.turnId && message.metadata?.workspaceVisible === true);
  if (existingAssistant && existingUser) {
    const hydrated = await getAssistantConversation(conversation.id, headers);
    return {
      conversation: publicConversation(conversation),
      userMessage: hydrated.messages.find((message) => message.id === existingUser.id) ?? publicMessage(existingUser),
      assistantMessage: hydrated.messages.find((message) => message.id === existingAssistant.id) ?? publicMessage(existingAssistant),
    };
  }

  const execution = await (options.execute ?? handleUserAIRequest)({
    ...requested,
    conversationId: conversation.id,
    turnId: undefined,
  }, headers);
  const content = assistantText(execution);
  const userMessage = await appendConversationMessage({
    conversationId: conversation.id,
    role: "user",
    content: requested.request,
    turnId: requested.turnId,
    metadata: metadata({ ...(requested.courseId ? { courseId: requested.courseId } : {}) }),
  }, headers);
  let presentation: AssistantPresentation;
  let assistantMetadata: Record<string, string | number | boolean | null>;
  const actionContext = {
    ...(requested.courseId ? { courseId: requested.courseId } : {}),
    ...(requested.documentIds ? { documentIds: requested.documentIds } : {}),
    ...(requested.assignmentId ? { assignmentId: requested.assignmentId } : {}),
    ...(requested.examId ? { examId: requested.examId } : {}),
    ...(requested.topicId ? { topicId: requested.topicId } : {}),
    ...(requested.topicName ? { topicName: requested.topicName } : {}),
    ...(requested.studyPlanId ? { studyPlanId: requested.studyPlanId } : {}),
    ...(requested.projectIds ? { projectIds: requested.projectIds } : {}),
    ...(requested.targetRole ? { targetRole: requested.targetRole } : {}),
    ...(requested.targetIndustry ? { targetIndustry: requested.targetIndustry } : {}),
    ...(requested.targetCompanies ? { targetCompanies: requested.targetCompanies } : {}),
    ...(requested.applicationTimeline ? { applicationTimeline: requested.applicationTimeline } : {}),
    ...(requested.availableWeeklyMinutes ? { availableWeeklyMinutes: requested.availableWeeklyMinutes } : {}),
  };
  if (execution.needsClarification) {
    presentation = { mode: "agent", kind: "clarification", actions: [] };
    assistantMetadata = metadata({ presentationKind: "clarification" });
  } else if (execution.mode === "workflow") {
    const related = await hydrateWorkflow(execution.result, headers);
    presentation = { mode: "workflow", kind: "workflow", targetId: execution.target.id, targetName: execution.target.name, workflow: execution.result, status: execution.result.status, actions: buildWorkflowActions(execution.result, actionContext), ...related };
    assistantMetadata = metadata({ presentationKind: "workflow", targetId: execution.target.id, targetName: execution.target.name, workflowRunId: execution.result.runId });
  } else if (execution.result.ok) {
    const structuredData = execution.result.response.structuredData;
    const sources = [...execution.result.response.sources];
    const artifact = agentArtifact(execution.target.id, structuredData);
    const sourceRefs = serializeSources(sources);
    const presentationData = serializeStructuredPresentation(execution.target.id, structuredData);
    presentation = {
      mode: "agent", kind: "agent", targetId: execution.target.id, targetName: execution.target.name,
      ...(structuredData !== undefined ? { structuredData } : {}),
      ...(execution.target.id === "quiz" && structuredData ? { quiz: structuredData as AssistantPresentation["quiz"] } : {}),
      ...(execution.target.id === "study-planner" && structuredData ? { studyPlan: structuredData as AssistantPresentation["studyPlan"] } : {}),
      sources,
      actions: buildAgentActions(execution.target.id, structuredData, actionContext),
    };
    assistantMetadata = metadata({ presentationKind: "agent", targetId: execution.target.id, targetName: execution.target.name, ...artifact, ...(sourceRefs ? { sourceRefs } : {}), ...(presentationData ? { presentationData } : {}) });
  } else {
    presentation = { mode: "agent", kind: "error", targetId: execution.target.id, targetName: execution.target.name, actions: [] };
    assistantMetadata = metadata({ presentationKind: "error", targetId: execution.target.id, targetName: execution.target.name });
  }
  const assistantMessage = await appendConversationMessage({
    conversationId: conversation.id,
    role: "assistant",
    content,
    turnId: requested.turnId,
    ...(!execution.needsClarification && execution.mode === "agent" ? { agentId: execution.target.id } : {}),
    metadata: assistantMetadata,
  }, headers);
  conversation = await getConversation(conversation.id, headers, 0);
  return {
    conversation: publicConversation(conversation),
    userMessage: publicMessage(userMessage),
    assistantMessage: publicMessage(assistantMessage, presentation),
  };
}

function streamError(error: unknown): string {
  if (error instanceof AIError) return error.message;
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (["CONFIGURATION", "AUTHENTICATION", "RATE_LIMIT", "PROVIDER_FAILURE", "INVALID_RESPONSE", "SOURCE_CONTEXT_UNAVAILABLE", "CONVERSATION_NOT_FOUND", "CONTEXT_FAILURE"].includes(code) && error instanceof Error) return error.message;
  return "The AI request could not be completed. Please try again.";
}

function ndjsonStream(run: (send: (value: unknown) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => { if (cancelled) throw new AIError("CANCELLED"); controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); };
      try { await run(send); }
      catch (error) { if (!cancelled) send({ type: "error", message: streamError(error) }); }
      finally { if (!cancelled) controller.close(); }
    },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

/** Uses provider streaming only for ordinary Tutor/Notes text. Structured Agents
 * and Workflows retain their validated execution path and emit one final event. */
export async function streamAssistantRequest(raw: unknown, headers: Headers): Promise<Response> {
  return guardedAssistant(raw, headers, true, requested => streamAssistantRequestCore(requested, headers)) as Promise<Response>;
}
async function streamAssistantRequestCore(raw: unknown, headers: Headers): Promise<Response> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new AssistantWorkspaceError("INVALID_REQUEST");
  const requested = parsed.data;
  const conversationId = requested.conversationId
    ? await getConversationScope(requested.conversationId, headers).then(() => requested.conversationId!)
    : (await createConversation({ ...(requested.courseId ? { courseId: requested.courseId } : {}) }, headers)).id;
  const conversation = await getConversation(conversationId, headers, 100);
  if (requested.courseId && conversation.courseId && requested.courseId !== conversation.courseId) throw new AssistantWorkspaceError("CONTEXT_MISMATCH");
  const replay = conversation.messages.some((message) => message.role === "assistant" && message.turnId === requested.turnId && message.metadata?.workspaceVisible === true);
  if (replay) return ndjsonStream(async (send) => {
    send({ type: "result", data: await executeAssistantRequestCore({ ...requested, conversationId }, headers) });
  });

  const decision = await new IntelligentDispatcher().dispatch({ ...requested, conversationId, turnId: undefined }, headers);
  const streamable = !("needsClarification" in decision) && decision.targetType === "agent" && (decision.targetId === "tutor" || decision.targetId === "notes");
  if (!streamable) return ndjsonStream(async (send) => {
    send({ type: "status", message: "Building the right academic response…" });
    // Reuse the decision already made above. An explicit target still passes
    // through the unified dispatcher execution path, but cannot trigger a
    // second model-based classification call.
    const executeResolved: typeof handleUserAIRequest = async (input, requestHeaders) => {
      if ("needsClarification" in decision) {
        return {
          ...decision,
          metrics: {
            dispatchDurationMs: 0,
            executionDurationMs: 0,
            totalDurationMs: 0,
            aiCalls: 0,
            ragCalls: 0,
            contextCharacters: 0,
            contextEstimatedTokens: 0,
            workflowSteps: 0,
            success: true,
          },
        };
      }
      return handleUserAIRequest(
        {
          ...input,
          ...(decision.targetType === "agent"
            ? {
                preferredAgentId: decision.targetId,
                preferredWorkflowId: undefined,
              }
            : {
                preferredAgentId: undefined,
                preferredWorkflowId: decision.targetId,
              }),
        },
        requestHeaders,
      );
    };
    send({
      type: "result",
      data: await executeAssistantRequestCore(
        { ...requested, conversationId },
        headers,
        { execute: executeResolved },
      ),
    });
  });

  return ndjsonStream(async (send) => {
    send({ type: "status", message: requested.documentIds?.length ? "Reading the selected course material…" : "Reviewing your academic context…" });
    const registry = createStudentAgentRegistry();
    const executor = new AgentExecutor(registry, { instructions: { tutor: TUTOR_INSTRUCTIONS, notes: NOTES_INSTRUCTIONS } });
    const iterator = executor.stream({
      agentId: decision.targetId,
      request: requested.request,
      ...(requested.courseId ? { courseId: requested.courseId } : {}),
      ...(requested.examId ? { examId: requested.examId } : {}),
      ...(requested.assignmentId ? { assignmentId: requested.assignmentId } : {}),
      ...(requested.projectIds ? { projectIds: requested.projectIds } : {}),
      ...(requested.documentIds?.length ? { documentIds: requested.documentIds } : {}),
      conversation: { id: conversationId },
    }, headers);
    let execution;
    try { while (true) {
      const next = await iterator.next();
      if (next.done) { execution = next.value; break; }
      send({ type: "delta", text: next.value.text });
    } } finally { await iterator.return(undefined as never); }
    const userMessage = await appendConversationMessage({ conversationId, role: "user", content: requested.request, turnId: requested.turnId, metadata: metadata({ ...(requested.courseId ? { courseId: requested.courseId } : {}) }) }, headers);
    const sources = [...(execution.sources ?? [])];
    const sourceRefs = serializeSources(sources);
    const assistantMetadata = metadata({ presentationKind: "agent", targetId: decision.targetId, targetName: registry.get(decision.targetId).name, ...(sourceRefs ? { sourceRefs } : {}) });
    const assistantMessage = await appendConversationMessage({ conversationId, role: "assistant", content: execution.content, turnId: requested.turnId, agentId: decision.targetId, metadata: assistantMetadata }, headers);
    const updated = await getConversation(conversationId, headers, 0);
    const presentation: AssistantPresentation = {
      mode: "agent", kind: "agent", targetId: decision.targetId,
      targetName: registry.get(decision.targetId).name,
      sources,
      actions: buildAgentActions(decision.targetId, undefined, {
        ...(requested.courseId ? { courseId: requested.courseId } : {}),
        ...(requested.documentIds ? { documentIds: requested.documentIds } : {}),
        ...(requested.assignmentId ? { assignmentId: requested.assignmentId } : {}),
        ...(requested.examId ? { examId: requested.examId } : {}),
      }),
    };
    const data: AssistantRequestResponse = { conversation: publicConversation(updated), userMessage: publicMessage(userMessage), assistantMessage: publicMessage(assistantMessage, presentation) };
    send({ type: "result", data });
  });
}

async function guardedAssistant(raw: unknown, headers: Headers, streaming: boolean,
  execute: (input: z.infer<typeof requestSchema>) => Promise<Response | AssistantRequestResponse>) {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new AssistantWorkspaceError("INVALID_REQUEST");
  const input = parsed.data;
  const session = await auth().api.getSession({ headers: new Headers(headers), query: { disableRefresh: true } });
  if (!session) throw new AssistantWorkspaceError("UNAUTHENTICATED");
  const userId = session.user.id;
  const context = captureUsageContext({ userId, ...(input.preferredAgentId ? { agentId: input.preferredAgentId } : {}), ...(input.preferredWorkflowId ? { guardProfile: "WORKFLOW" as const, workflowId: input.preferredWorkflowId } : {}) });
  await checkAIUsageAllowance(userId, context);
  // Normalize only set-like references; all meaningful constraints remain in the hash.
  const normalized = { ...input, documentIds: input.documentIds?.slice().sort(), projectIds: input.projectIds?.slice().sort() };
  const claim = await claimAIRequest(context, input.turnId, normalized);
  if (claim.replay) {
    if (!claim.conversationId) throw new AIError("AI_DUPLICATE_REQUEST");
    const conversation = await getAssistantConversation(claim.conversationId, headers);
    const rows = await db().conversationMessage.findMany({ where: { userId, conversationId: claim.conversationId, turnId: input.turnId, role: { in: ["USER", "ASSISTANT"] } } });
    const messages = rows.map(row => conversation.messages.find(m => m.id === row.id) ?? {
      id: row.id, turnId: row.turnId, role: row.role.toLowerCase() as "user" | "assistant", content: row.content, agentId: row.agentId,
      createdAt: row.createdAt.toISOString(), metadata: row.metadata as AssistantMessage["metadata"],
    });
    const userMessage = messages.find(m => m.role === "user"), assistantMessage = messages.find(m => m.role === "assistant");
    if (!userMessage || !assistantMessage) throw new AIError("AI_DUPLICATE_REQUEST");
    const data = { conversation, userMessage, assistantMessage };
    return streaming ? ndjsonStream(async send => { send({ type: "result", data }); }) : data;
  }
  trackProductEvent(userId, "ai_request_sent", { requestId: context.requestId }, input.turnId);
  const complete = async (conversationId?: string) => {
    try {
      const savedId = conversationId ?? (await db().conversationMessage.findFirst({ where: { userId, turnId: input.turnId, role: "ASSISTANT", metadata: { path: ["workspaceVisible"], equals: true } }, select: { conversationId: true } }))?.conversationId;
      await claim.complete(savedId);
      const message = savedId ? await db().conversationMessage.findFirst({ where: { userId, conversationId: savedId, turnId: input.turnId, role: "ASSISTANT", metadata: { path: ["presentationKind"], equals: "agent" } }, select: { agentId: true } }).catch(() => null) : null;
      if (message) trackProductEvent(userId, "ai_request_completed", { requestId: context.requestId, ...(message.agentId ? { agentId: message.agentId } : {}) }, input.turnId);
    } catch {
      // Saved output stays usable when the guard-store completion write fails.
      // The original claim still prevents automatic duplicate execution.
      await guardrails.emit({ context, type: "AI_GUARD_STORAGE_UNAVAILABLE" }).catch(() => {});
    }
  };
  try {
    await guardrails.admit(context);
    const result = await withAIUsageContext(context, () => execute(input));
    if (!(result instanceof Response)) { await complete(result.conversation.id); return result; }
    const reader = result.body!.getReader();
    return new Response(new ReadableStream({
      async pull(controller) {
        try { const next = await reader.read(); if (next.done) { await complete(); controller.close(); } else controller.enqueue(next.value); }
        catch (error) { await claim.complete().catch(() => {}); controller.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason); await claim.complete().catch(() => {}); },
    }), { status: result.status, headers: result.headers });
  } catch (error) { await claim.complete().catch(() => {}); throw error; }
}

export async function getAssistantWorkflowMessage(runId: string, headers: Headers): Promise<AssistantMessage> {
  const workflow = await new WorkflowService().getRun(runId, headers);
  return {
    id: `workflow-${workflow.runId}`, role: "assistant", turnId: null,
    content: workflow.summary, agentId: null, createdAt: new Date().toISOString(), metadata: null,
    presentation: { mode: "workflow", kind: "workflow", targetId: workflow.workflowId,
      targetName: workflow.workflowId, workflow, status: workflow.status,
      actions: buildWorkflowActions(workflow), ...(await hydrateWorkflow(workflow, headers)) },
  };
}

export async function getAssistantQuiz(quizId: string, headers: Headers) {
  return hydrateQuizExperience(quizId, headers);
}

export async function evaluateAssistantQuizAnswer(quizId: string, raw: unknown, headers: Headers) {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success || parsed.data.questionId.length < 1) throw new AssistantWorkspaceError("INVALID_REQUEST");
  if (parsed.data.runId) {
    return new WorkflowService().submitWorkflowAnswer({
      runId: parsed.data.runId,
      questionId: parsed.data.questionId,
      userAnswer: parsed.data.userAnswer,
      ...(parsed.data.quizAttemptId ? { quizAttemptId: parsed.data.quizAttemptId } : {}),
    }, headers);
  }
  return createQuizAgentService().evaluateAnswer({
    quizId,
    questionId: parsed.data.questionId,
    userAnswer: parsed.data.userAnswer,
    ...(parsed.data.quizAttemptId ? { quizAttemptId: parsed.data.quizAttemptId } : {}),
  }, headers);
}

export async function resumeAssistantWorkflow(userId: string, runId: string, raw: unknown, headers: Headers) {
  const parsed = resumeSchema.safeParse(raw);
  if (!parsed.success) throw new AssistantWorkspaceError("INVALID_REQUEST");
  const run = await db().workflowRun.findFirst({ where: { id: runId, userId }, select: { id: true, context: true } });
  if (!run) throw new AssistantWorkspaceError("NOT_FOUND");
  const context = run.context as { conversationId?: string; courseId?: string };
  if (context.conversationId) {
    const conversation = await getConversation(context.conversationId, headers, 100);
    const existingUser = conversation.messages.find((message) => message.role === "user" && message.turnId === parsed.data.turnId && message.metadata?.workspaceVisible === true);
    const existingAssistant = conversation.messages.find((message) => message.role === "assistant" && message.turnId === parsed.data.turnId && message.metadata?.workspaceVisible === true);
    if (existingUser && existingAssistant) {
      const current = await new WorkflowService().getRun(runId, headers);
      const currentRelated = await hydrateWorkflow(current, headers);
      return {
        workflow: current,
        ...currentRelated,
        userMessage: publicMessage(existingUser),
        assistantMessage: publicMessage(existingAssistant, {
          mode: "workflow", kind: "workflow", targetId: current.workflowId,
          targetName: current.workflowId, workflow: current, status: current.status,
          actions: buildWorkflowActions(current, { ...(context.courseId ? { courseId: context.courseId } : {}) }),
          ...currentRelated,
        }),
      };
    }
  }
  const input = parsed.data.userWork
    ? { runId, userWork: parsed.data.userWork }
    : parsed.data.quizAttemptId
      ? { runId, quizAttemptId: parsed.data.quizAttemptId }
      : { runId, careerData: parsed.data.careerData! };
  const result = await new WorkflowService().resumeWorkflow(input, headers);
  const related = await hydrateWorkflow(result, headers);
  if (!context.conversationId) return { workflow: result, ...related };
  await getConversationScope(context.conversationId, headers);
  const userText = parsed.data.userWork ?? (parsed.data.quizAttemptId ? "Completed the quiz." : "Added my career information.");
  const userMessage = await appendConversationMessage({ conversationId: context.conversationId, role: "user", content: userText, turnId: parsed.data.turnId, metadata: metadata({ workflowResume: true }) }, headers);
  const assistantMessage = await appendConversationMessage({ conversationId: context.conversationId, role: "assistant", content: result.summary, turnId: parsed.data.turnId, metadata: metadata({ presentationKind: "workflow", workflowRunId: result.runId, targetId: result.workflowId, targetName: result.workflowId }) }, headers);
  return {
    workflow: result,
    ...related,
    userMessage: publicMessage(userMessage),
    assistantMessage: publicMessage(assistantMessage, {
      mode: "workflow", kind: "workflow", targetId: result.workflowId,
      targetName: result.workflowId, workflow: result, status: result.status,
      actions: buildWorkflowActions(result, { ...(context.courseId ? { courseId: context.courseId } : {}) }),
      ...related,
    }),
  };
}

export async function updateAssistantStudyTask(taskId: string, rawStatus: unknown, headers: Headers) {
  const status = taskSchema.safeParse(rawStatus);
  if (!status.success) throw new AssistantWorkspaceError("INVALID_REQUEST");
  return createStudyPlannerAgentService().updateTaskStatus(taskId, status.data, headers);
}

export type AssistantWorkspaceErrorCode = "INVALID_REQUEST" | "CONTEXT_MISMATCH" | "NOT_FOUND" | "UNAUTHENTICATED";
export class AssistantWorkspaceError extends Error {
  constructor(readonly code: AssistantWorkspaceErrorCode) {
    super({ UNAUTHENTICATED: "Sign in to continue.", INVALID_REQUEST: "Check your message and selected context.", CONTEXT_MISMATCH: "Start a new chat to use a different course.", NOT_FOUND: "This workspace item is no longer available." }[code]);
    this.name = "AssistantWorkspaceError";
  }
}
