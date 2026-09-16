import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import { IntelligentDispatcher } from "@/server/dispatcher";
import { createStudentWorkflowRegistry } from "@/server/workflows";

type Actor = { id: string; headers: Headers };
let student: Actor;

async function actor(): Promise<Actor> {
  const response = await auth().api.signUpEmail({ body: {
    name: "Dispatcher Student", email: `dispatcher-${randomUUID()}@example.test`, password: "Dispatcher-fixture-passphrase!",
  }, asResponse: true });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const result = { id: body.user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ") }) };
  await db().profile.create({ data: { userId: result.id, school: "Dispatch University", program: "Computer Science", currentYear: 2,
    semester: "Fall 2026", academicGoal: "Learn effectively", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return result;
}

function boundary(classification: unknown = { targetType: "agent", targetId: "tutor", confidence: .76, needsClarification: false, clarificationQuestion: null }) {
  const structured = vi.fn(async (request: AIStructuredRequest<unknown>) => {
    if (request.schemaName !== "intelligent_dispatch") throw new Error(`Unexpected structured execution: ${request.schemaName}`);
    return classification;
  });
  const text = vi.fn(async () => ({ id: "answer", model: "fixture", text: "Mathematical induction starts with a base case and an inductive step.", usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } }));
  const provider: AIProvider = {
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      const data = await structured(request as AIStructuredRequest<unknown>);
      return { id: "dispatch", model: "fixture", text: JSON.stringify(data), data: data as T };
    },
    generateText: text,
    streamText() { throw new Error("Streaming is not used by Dispatcher."); },
    generateEmbedding() { throw new Error("Dispatcher never embeds or retrieves."); },
  };
  const getProvider = vi.fn(() => provider);
  return { structured, text, getProvider, dispatcher: new IntelligentDispatcher({ getProvider }) };
}

beforeAll(async () => { student = await actor(); });
afterAll(async () => { await db().user.deleteMany({ where: { id: student.id } }); await db().$disconnect(); });

describe.sequential("Intelligent Dispatcher", () => {
  it("exposes all registered workflow metadata through the existing registry", () => {
    const workflows = createStudentWorkflowRegistry().list();
    expect(workflows.map((item) => item.id)).toEqual(["exam-preparation", "weak-topic-recovery", "lecture-study", "assignment-support", "career-preparation"]);
    expect(workflows.every((item) => item.description.length <= 400 && item.intents.length <= 10)).toBe(true);
  });

  it.each([
    ["Explain mathematical induction.", "agent", "tutor"],
    ["Summarize this lecture.", "agent", "notes"],
    ["Quiz me on recursion.", "agent", "quiz"],
    ["What should I study tonight?", "agent", "study-planner"],
    ["Give me a schedule.", "agent", "study-planner"],
    ["How am I doing this semester?", "agent", "academic-manager"],
    ["I'm falling behind.", "agent", "academic-manager"],
    ["What should I do?", "agent", "academic-manager"],
    ["I don't understand this.", "agent", "tutor"],
    ["Help improve my resume.", "agent", "career"],
    ["Prepare me for my MATH 1240 midterm.", "workflow", "exam-preparation"],
    ["I keep getting induction wrong. Help me fix it.", "workflow", "weak-topic-recovery"],
    ["Teach me this PDF and quiz me afterward.", "workflow", "lecture-study"],
    ["Help me finish Assignment 2.", "workflow", "assignment-support"],
    ["Prepare me for software engineering internships.", "workflow", "career-preparation"],
  ])("routes %s deterministically to %s", async (request, targetType, targetId) => {
    const ai = boundary();
    expect(await ai.dispatcher.dispatch({ request }, student.headers)).toMatchObject({ targetType, targetId, method: expect.stringMatching(/rule|intent/), confidence: expect.any(Number) });
    expect(ai.getProvider).not.toHaveBeenCalled();
    expect(ai.structured).not.toHaveBeenCalled();
  });

  it("honors and validates explicit Agent or Workflow selection without classification", async () => {
    const ai = boundary();
    expect(await ai.dispatcher.dispatch({ request: "Do something else", preferredAgentId: "notes" }, student.headers)).toMatchObject({ targetType: "agent", targetId: "notes", confidence: 1, method: "explicit" });
    expect(await ai.dispatcher.dispatch({ request: "Do something else", preferredWorkflowId: "lecture-study" }, student.headers)).toMatchObject({ targetType: "workflow", targetId: "lecture-study", confidence: 1, method: "explicit" });
    await expect(ai.dispatcher.dispatch({ request: "Help", preferredAgentId: "invented-agent" }, student.headers)).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
    await expect(ai.dispatcher.dispatch({ request: "Help", preferredWorkflowId: "invented-workflow" }, student.headers)).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
    await expect(ai.dispatcher.dispatch({ request: "Help", preferredAgentId: "tutor", preferredWorkflowId: "lecture-study" }, student.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it.each([
    [{ request: "Help me with this.", assignmentId: "assignment-one" }, "assignment-support"],
    [{ request: "Study this.", documentId: "document-one" }, "lecture-study"],
    [{ request: "Help me with this.", examId: "exam-one" }, "exam-preparation"],
    [{ request: "Help me improve this.", topicId: "topic-one" }, "weak-topic-recovery"],
  ])("uses lightweight selected-resource metadata for %s", async (input, targetId) => {
    const ai = boundary();
    expect(await ai.dispatcher.dispatch(input, student.headers)).toMatchObject({ targetType: "workflow", targetId, method: "intent", confidence: .9 });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("uses a selected document for one explanation without launching a large workflow", async () => {
    const ai = boundary();
    expect(await ai.dispatcher.dispatch({ request: "I don't understand this.", documentId: "document-one" }, student.headers)).toMatchObject({ targetType: "agent", targetId: "tutor", method: "rule" });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("uses selected exam or topic scope to resolve a time-bound mastery request", async () => {
    const ai = boundary();
    expect(await ai.dispatcher.dispatch({ request: "Help me master this before Friday.", examId: "exam-one" }, student.headers)).toMatchObject({ targetType: "workflow", targetId: "exam-preparation", method: "intent" });
    expect(await ai.dispatcher.dispatch({ request: "Help me master this before Friday.", topicId: "topic-one" }, student.headers)).toMatchObject({ targetType: "workflow", targetId: "weak-topic-recovery", method: "intent" });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("uses one concise structured fallback for semantic ambiguity", async () => {
    const ai = boundary({ targetType: "workflow", targetId: "exam-preparation", confidence: .78, needsClarification: false, clarificationQuestion: null });
    expect(await ai.dispatcher.dispatch({ request: "I have an induction exam next week and don't understand the topic." }, student.headers)).toMatchObject({ targetType: "workflow", targetId: "exam-preparation", confidence: .78, method: "llm-fallback" });
    expect(ai.structured).toHaveBeenCalledTimes(1);
    const request = ai.structured.mock.calls[0][0];
    expect(request.schemaName).toBe("intelligent_dispatch");
    const prompt = request.messages.map((message) => message.content).join("\n");
    for (const id of ["tutor", "academic-manager", "exam-preparation", "weak-topic-recovery", "career-preparation"]) expect(prompt).toContain(id);
    expect(prompt).not.toMatch(/\[CAREER\]|\[LEARNING\]|RELEVANT COURSE MATERIAL|api[_-]?key/i);
  });

  it("rejects hallucinated targets and uses a safe low-cost default", async () => {
    const ai = boundary({ targetType: "workflow", targetId: "invented-workflow", confidence: .99, needsClarification: false, clarificationQuestion: null });
    expect(await ai.dispatcher.dispatch({ request: "Could you help me decide what to focus on?" }, student.headers)).toMatchObject({ targetType: "agent", targetId: "academic-manager", confidence: .25, method: "default" });
    expect(ai.structured).toHaveBeenCalledTimes(1);
  });

  it("does not start a low-confidence Workflow and supports one focused clarification", async () => {
    const low = boundary({ targetType: "workflow", targetId: "weak-topic-recovery", confidence: .42, needsClarification: false, clarificationQuestion: null });
    expect(await low.dispatcher.dispatch({ request: "I need some help with induction." }, student.headers)).toMatchObject({ needsClarification: true, method: "llm-fallback", suggestedTarget: { targetId: "weak-topic-recovery" } });
    const unclear = boundary({ targetType: null, targetId: null, confidence: .5, needsClarification: true, clarificationQuestion: "Do you want an explanation or a complete recovery plan with practice?" });
    expect(await unclear.dispatcher.handleUserAIRequest({ request: "Help me with induction in a bigger way." }, student.headers)).toMatchObject({ needsClarification: true, clarificationQuestion: "Do you want an explanation or a complete recovery plan with practice?" });
    expect(await db().workflowRun.count({ where: { userId: student.id } })).toBe(0);
  });

  it("asks for a required resource instead of starting unnecessary work", async () => {
    const ai = boundary();
    expect(await ai.dispatcher.handleUserAIRequest({ request: "Help me finish Assignment 2." }, student.headers)).toMatchObject({ needsClarification: true, clarificationQuestion: "Which assignment would you like help with?", suggestedTarget: { targetId: "assignment-support" } });
    expect(await ai.dispatcher.handleUserAIRequest({ request: "Teach me this PDF and quiz me afterward." }, student.headers)).toMatchObject({ needsClarification: true, clarificationQuestion: "Which lecture document would you like to study?", suggestedTarget: { targetId: "lecture-study" } });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("executes a single Agent through Agent Core without a second routing model call", async () => {
    const ai = boundary();
    const result = await ai.dispatcher.handleUserAIRequest({ request: "Explain mathematical induction." }, student.headers);
    expect(result).toMatchObject({ needsClarification: false, mode: "agent", target: { id: "tutor", name: "Tutor" }, dispatch: { method: "rule", confidence: .92 }, result: { ok: true, agent: { id: "tutor" }, response: { content: expect.stringContaining("base case") } }, metrics: { aiCalls: 1, ragCalls: 1, workflowSteps: 0, success: true, usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } } });
    expect(ai.structured).not.toHaveBeenCalled();
    expect(ai.text).toHaveBeenCalledTimes(1);
    expect(ai.getProvider).toHaveBeenCalledTimes(1);
  });

  it("counts one combined fallback plus one execution call while reusing the provider", async () => {
    const ai = boundary({ targetType: "agent", targetId: "tutor", confidence: .76, needsClarification: false, clarificationQuestion: null });
    const result = await ai.dispatcher.handleUserAIRequest({ request: "Could you guide me through this concept?" }, student.headers);
    expect(result).toMatchObject({ needsClarification: false, mode: "agent", target: { id: "tutor" }, dispatch: { method: "llm-fallback" }, metrics: { aiCalls: 2, ragCalls: 1, workflowSteps: 0, success: true } });
    expect(ai.structured).toHaveBeenCalledTimes(1);
    expect(ai.text).toHaveBeenCalledTimes(1);
    expect(ai.getProvider).toHaveBeenCalledTimes(1);
  });

  it("starts a Workflow through the existing engine and returns one unified shape", async () => {
    const ai = boundary();
    const result = await ai.dispatcher.handleUserAIRequest({ request: "Prepare me for software engineering internships." }, student.headers);
    expect(result).toMatchObject({ needsClarification: false, mode: "workflow", target: { id: "career-preparation", name: "Career Preparation" }, dispatch: { method: "rule" }, result: { workflowId: "career-preparation", status: "waiting-for-input", waitingFor: { kind: "career-data" }, careerPreparation: { targetRole: "Software Engineering Intern" } }, metrics: { aiCalls: 0, ragCalls: 0, workflowSteps: 1, success: true } });
    expect(ai.getProvider).not.toHaveBeenCalled();
    if ("mode" in result && result.mode === "workflow") expect(await db().workflowRun.findFirst({ where: { id: result.result.runId, userId: student.id } })).not.toBeNull();
  });

  it("asks for a target role only when neither natural language nor saved data resolves one", async () => {
    const ai = boundary();
    expect(await ai.dispatcher.handleUserAIRequest({ request: "Prepare for internship applications." }, student.headers)).toMatchObject({ needsClarification: true, clarificationQuestion: "Which role are you preparing for?", suggestedTarget: { targetId: "career-preparation" } });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("enforces authentication before explicit, deterministic, or model routing", async () => {
    const ai = boundary();
    await expect(ai.dispatcher.dispatch({ request: "Explain induction", preferredAgentId: "tutor" }, new Headers())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(ai.dispatcher.handleUserAIRequest({ request: "Prepare me for my exam." }, new Headers())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(ai.dispatcher.dispatch({ request: "Explain induction", userId: "forged-user" } as never, student.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });
});
