import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { AIError } from "@/server/ai/errors";
import { appendConversationMessage, createConversation } from "@/server/conversations";
import type { DispatcherInput, UnifiedAIResult } from "@/server/dispatcher";
import {
  executeAssistantRequest,
  getAssistantBootstrap,
  getAssistantConversation,
} from "@/server/assistant";

type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor;
let other: Actor;
let courseId: string;

async function actor(label: string): Promise<Actor> {
  const email = `assistant-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({ body: { name: label, email, password: "Assistant-workspace-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const value = { id: body.user.id, email, headers: new Headers({ cookie: response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ") }) };
  actors.push(value);
  await db().profile.create({ data: { userId: value.id, school: "Workspace University", program: "Computer Science", currentYear: 2, semester: "Fall 2026", academicGoal: "Learn well", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return value;
}

const metrics = { dispatchDurationMs: 1, executionDurationMs: 2, totalDurationMs: 3, aiCalls: 1, ragCalls: 0, contextCharacters: 0, contextEstimatedTokens: 0, workflowSteps: 0, success: true };

function agentResult(overrides: { targetId?: "tutor" | "quiz" | "study-planner"; content?: string; structuredData?: unknown } = {}): UnifiedAIResult {
  const id = overrides.targetId ?? "tutor";
  const name = id === "study-planner" ? "Study Planner" : id[0].toUpperCase() + id.slice(1);
  return {
    needsClarification: false, mode: "agent", target: { id, name }, dispatch: { confidence: .95, method: "rule" },
    result: { ok: true, agent: { id, name }, routing: { agentId: id, confidence: .95, method: "rule" }, response: { content: overrides.content ?? "Use the base case, then prove the inductive step.", sources: [], ...(overrides.structuredData !== undefined ? { structuredData: overrides.structuredData } : {}) }, metadata: { totalDurationMs: 2 } },
    metrics,
  };
}

function workflowResult(): UnifiedAIResult {
  return {
    needsClarification: false, mode: "workflow", target: { id: "assignment-support", name: "Assignment Support" }, dispatch: { confidence: .95, method: "rule" }, metrics: { ...metrics, workflowSteps: 2 },
    result: {
      runId: "run-visible", workflowId: "assignment-support", status: "waiting-for-input", summary: "I reviewed the assignment. Add your draft to continue.", completedSteps: ["understand"],
      steps: [{ stepId: "understand", agentId: "notes", status: "completed", attempts: 1, inputSummary: null, outputSummary: "Requirements identified.", errorCode: null }, { stepId: "review", agentId: "tutor", status: "pending", attempts: 0, inputSummary: null, outputSummary: null, errorCode: null }],
      outputs: {}, warnings: [], errorCode: null, recommendedNextAction: "Add your draft.", waitingFor: { kind: "student-work", referenceId: "assignment-one" },
    },
  };
}

beforeAll(async () => {
  owner = await actor("Workspace Owner");
  other = await actor("Workspace Other");
  courseId = (await db().course.create({ data: { userId: owner.id, courseCode: "MATH 1240", courseName: "Discrete Mathematics", semester: "Fall 2026" } })).id;
});

afterAll(async () => {
  for (const value of actors) await db().user.deleteMany({ where: { id: value.id, email: value.email } });
  await db().$disconnect();
});

describe.sequential("Main AI workspace service", () => {
  it("creates a conversation on the first natural-language request and persists one visible turn", async () => {
    const execute = vi.fn(async () => agentResult());
    const response = await executeAssistantRequest({ request: "Explain induction.", turnId: "turn-create", courseId }, owner.headers, { execute });
    expect(response.conversation).toMatchObject({ courseId, title: "Explain induction.", messageCount: expect.any(Number) });
    expect(response.userMessage).toMatchObject({ role: "user", content: "Explain induction." });
    expect(response.assistantMessage).toMatchObject({ role: "assistant", agentId: "tutor", presentation: { kind: "agent", targetId: "tutor" } });
    const loaded = await getAssistantConversation(response.conversation.id, owner.headers);
    expect(loaded.messages.map((message) => message.content)).toEqual(["Explain induction.", "Use the base case, then prove the inductive step."]);
  });

  it("passes optional course, document, assignment, and explicit Agent selections through the unified entry point", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    const execute = vi.fn(async (input: DispatcherInput) => {
      expect(input.request).toBe("Help with this material.");
      return agentResult();
    });
    await executeAssistantRequest({ request: "Help with this material.", turnId: "turn-context", conversationId: conversation.id, courseId, documentIds: ["document-one"], assignmentId: "assignment-one", preferredAgentId: "tutor" }, owner.headers, { execute });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ request: "Help with this material.", conversationId: conversation.id, courseId, documentIds: ["document-one"], assignmentId: "assignment-one", preferredAgentId: "tutor" }), expect.any(Headers));
  });

  it("replays a completed idempotent turn without a second AI execution", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    const execute = vi.fn(async () => agentResult());
    const input = { request: "Explain recursion.", turnId: "same-turn", conversationId: conversation.id, courseId };
    const first = await executeAssistantRequest(input, owner.headers, { execute });
    const replay = await executeAssistantRequest(input, owner.headers, { execute });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(replay.userMessage.id).toBe(first.userMessage.id);
    expect(replay.assistantMessage.id).toBe(first.assistantMessage.id);
  });

  it("returns interactive Quiz data as a structured presentation", async () => {
    const quiz = { id: "quiz-one", title: "Recursion check", topic: "Recursion", courseId, difficulty: "medium", questions: [{ id: "question-one", type: "multiple-choice", prompt: "What is a base case?", choices: ["A", "B", "C", "D"], topics: ["Recursion"] }], sources: [], metadata: {} };
    const response = await executeAssistantRequest({ request: "Quiz me on recursion.", turnId: "turn-quiz", courseId }, owner.headers, { execute: async () => agentResult({ targetId: "quiz", content: "Created one question.", structuredData: quiz }) });
    expect(response.assistantMessage.presentation).toMatchObject({ kind: "agent", targetId: "quiz", quiz: { id: "quiz-one", questions: [{ id: "question-one" }] } });
    expect(response.assistantMessage.metadata).toMatchObject({ artifactType: "quiz", artifactId: "quiz-one" });
  });

  it("returns a persisted Study Plan as a task-oriented presentation", async () => {
    const plan = { id: "plan-one", title: "Midterm plan", startDate: "2026-09-15", endDate: "2026-09-16", summary: "Repair induction, then review logic.", totalPlannedMinutes: 90, assumptions: [], days: [] };
    const response = await executeAssistantRequest({ request: "Plan my week.", turnId: "turn-plan", courseId }, owner.headers, { execute: async () => agentResult({ targetId: "study-planner", content: "Midterm plan", structuredData: plan }) });
    expect(response.assistantMessage.presentation).toMatchObject({ studyPlan: { id: "plan-one", totalPlannedMinutes: 90 } });
    expect(response.assistantMessage.metadata).toMatchObject({ artifactType: "study-plan", artifactId: "plan-one" });
  });

  it("renders Workflow progress and a waiting-for-user checkpoint without exposing dispatch internals", async () => {
    const response = await executeAssistantRequest({ request: "Help me finish Assignment 2.", turnId: "turn-workflow", courseId }, owner.headers, { execute: async () => workflowResult() });
    expect(response.assistantMessage.content).toBe("I reviewed the assignment. Add your draft to continue.");
    expect(response.assistantMessage.presentation).toMatchObject({ kind: "workflow", targetName: "Assignment Support", workflow: { status: "waiting-for-input", completedSteps: ["understand"], waitingFor: { kind: "student-work" } } });
    expect(JSON.stringify(response.assistantMessage)).not.toMatch(/confidence|internal prompt|system prompt/i);
  });

  it("persists clarification as a normal visible assistant turn", async () => {
    const clarification: UnifiedAIResult = { needsClarification: true, confidence: .5, method: "llm-fallback", reason: "Two paths", clarificationQuestion: "Which exam would you like to prepare for?", metrics };
    const response = await executeAssistantRequest({ request: "Prepare me for an exam.", turnId: "turn-clarify" }, owner.headers, { execute: async () => clarification });
    expect(response.assistantMessage).toMatchObject({ content: "Which exam would you like to prepare for?", presentation: { kind: "clarification" } });
  });

  it("filters internal workflow and structured generation messages from visible chat history", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    await appendConversationMessage({ conversationId: conversation.id, role: "user", content: "Internal step prompt", turnId: "internal-user", metadata: { workspaceVisible: false, workflow: true } }, owner.headers, { embeddingProvider: null });
    await appendConversationMessage({ conversationId: conversation.id, role: "assistant", content: "Raw structured output", turnId: "internal-user", agentId: "quiz", metadata: { workspaceVisible: false, schemaName: "quiz_generation" } }, owner.headers, { embeddingProvider: null });
    const execute = vi.fn(async () => agentResult());
    await executeAssistantRequest({ request: "Visible question", turnId: "visible-turn", conversationId: conversation.id, courseId }, owner.headers, { execute });
    const visible = await getAssistantConversation(conversation.id, owner.headers);
    expect(visible.messages.map((message) => message.content)).toEqual(["Visible question", "Use the base case, then prove the inductive step."]);
  });

  it("enforces conversation ownership", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    await expect(getAssistantConversation(conversation.id, other.headers)).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
    await expect(executeAssistantRequest({ request: "Read another user's chat", turnId: "forbidden", conversationId: conversation.id }, other.headers, { execute: async () => agentResult() })).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
  });

  it("does not persist a fake assistant response when the provider fails", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    await expect(executeAssistantRequest({ request: "Explain logic.", turnId: "failed-turn", conversationId: conversation.id }, owner.headers, { execute: async () => { throw new AIError("PROVIDER_FAILURE"); } })).rejects.toThrow("temporarily unavailable");
    expect((await getAssistantConversation(conversation.id, owner.headers)).messages).toHaveLength(0);
  });

  it("returns only owned metadata in the lightweight bootstrap payload", async () => {
    const bootstrap = await getAssistantBootstrap(owner.id);
    expect(bootstrap.courses.some((course) => course.id === courseId)).toBe(true);
    expect(bootstrap.courses.every((course) => course.id !== "forged-course")).toBe(true);
    expect(bootstrap.conversations.every((conversation) => typeof conversation.lastMessageAt === "string")).toBe(true);
  });
});
