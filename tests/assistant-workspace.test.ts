import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { AIError } from "@/server/ai/errors";
import { appendConversationMessage, createConversation } from "@/server/conversations";
import type { DispatcherInput, UnifiedAIResult } from "@/server/dispatcher";
import {
  evaluateAssistantQuizAnswer,
  executeAssistantRequest,
  getAssistantBootstrap,
  getAssistantConversation,
  getAssistantQuiz,
  resumeAssistantWorkflow,
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

function agentResult(overrides: { targetId?: "tutor" | "notes" | "quiz" | "study-planner" | "career"; content?: string; structuredData?: unknown; sources?: Array<{ documentId: string; documentTitle: string; pageNumber: number | null; pageEnd: number | null; courseId: string | null; courseCode: string | null; chunkIndex: number }> } = {}): UnifiedAIResult {
  const id = overrides.targetId ?? "tutor";
  const name = id === "study-planner" ? "Study Planner" : id[0].toUpperCase() + id.slice(1);
  return {
    needsClarification: false, mode: "agent", target: { id, name }, dispatch: { confidence: .95, method: "rule" },
    result: { ok: true, agent: { id, name }, routing: { agentId: id, confidence: .95, method: "rule" }, response: { content: overrides.content ?? "Use the base case, then prove the inductive step.", sources: overrides.sources ?? [], ...(overrides.structuredData !== undefined ? { structuredData: overrides.structuredData } : {}) }, metadata: { totalDurationMs: 2 } },
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

  it("passes project and target-role context from Career Workspace launches", async () => {
    const project = await db().project.create({ data: { userId: owner.id, name: "Career context project", description: "A saved project used for context.", technologies: ["TypeScript"] } });
    const execute = vi.fn(async () => agentResult({ targetId: "career", content: "Review the saved project evidence." }));
    await executeAssistantRequest({
      request: "Improve this project for my target role.", turnId: "turn-career-context",
      projectIds: [project.id], targetRole: "Software Engineering Intern",
      targetIndustry: "Education Technology", applicationTimeline: "in 8 weeks",
      preferredAgentId: "career",
    }, owner.headers, { execute });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      projectIds: [project.id], targetRole: "Software Engineering Intern",
      targetIndustry: "Education Technology", applicationTimeline: "in 8 weeks",
      preferredAgentId: "career",
    }), expect.any(Headers));
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

  it("persists a one-source RAG Tutor response, structured display data, and source ownership across reload", async () => {
    const source = { documentId: "doc-actions", documentTitle: "Proof Lecture", pageNumber: 4, pageEnd: 4, courseId, courseCode: "MATH 1240", chunkIndex: 0 };
    const response = await executeAssistantRequest({ request: "Explain induction.", turnId: "turn-rich-tutor", courseId }, owner.headers, {
      execute: async () => agentResult({ structuredData: { keyTakeaway: "The inductive step carries truth forward." }, sources: [source] }),
    });
    expect(response.assistantMessage.presentation?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Test my understanding", targetId: "quiz" })]));
    const loaded = await getAssistantConversation(response.conversation.id, owner.headers);
    const presentation = loaded.messages.find((message) => message.role === "assistant")?.presentation;
    expect(presentation).toMatchObject({
      mode: "agent",
      structuredData: { keyTakeaway: "The inductive step carries truth forward." },
      sources: [{ documentId: "doc-actions", pageNumber: 4, courseId }],
      actions: expect.arrayContaining([expect.objectContaining({ id: "tutor-check" })]),
    });
  });

  it("persists multiple sources across reload", async () => {
    const sources = Array.from({ length: 8 }, (_, index) => ({
      documentId: `doc-multi-${index}`,
      documentTitle: `Lecture ${index + 1}`,
      pageNumber: index + 1,
      pageEnd: index + 1,
      courseId,
      courseCode: "MATH 1240",
      chunkIndex: index,
    }));
    const response = await executeAssistantRequest({ request: "Compare these lectures.", turnId: "turn-multi-source", courseId }, owner.headers, {
      execute: async () => agentResult({ sources }),
    });
    const loaded = await getAssistantConversation(response.conversation.id, owner.headers);
    const persisted = loaded.messages.find((message) => message.role === "assistant")?.presentation?.sources;
    expect(persisted).toHaveLength(8);
    expect(persisted).toEqual(sources);
  });

  it("persists Notes sources and structured presentation data across reload", async () => {
    const source = { documentId: "doc-notes", documentTitle: "Logic Lecture", pageNumber: 2, pageEnd: 3, courseId, courseCode: "MATH 1240", chunkIndex: 1 };
    const response = await executeAssistantRequest({ request: "Make notes from this lecture.", turnId: "turn-notes-source", courseId }, owner.headers, {
      execute: async () => agentResult({ targetId: "notes", content: "Logic notes", structuredData: { title: "Logic notes", topics: ["Logic"] }, sources: [source] }),
    });
    const loaded = await getAssistantConversation(response.conversation.id, owner.headers);
    expect(loaded.messages.find((message) => message.role === "assistant")?.presentation).toMatchObject({
      targetId: "notes",
      structuredData: { title: "Logic notes", topics: ["Logic"] },
      sources: [source],
    });
  });

  it("persists and reloads a no-source response without inventing source metadata", async () => {
    const response = await executeAssistantRequest({ request: "Explain a general study strategy.", turnId: "turn-no-source", courseId }, owner.headers, {
      execute: async () => agentResult({ content: "Use retrieval practice.", sources: [] }),
    });
    const loaded = await getAssistantConversation(response.conversation.id, owner.headers);
    expect(loaded.messages.find((message) => message.role === "assistant")?.presentation?.sources).toBeUndefined();
  });

  it("reconstructs persisted Quiz answers without revealing unattempted answers", async () => {
    const quiz = await db().quiz.create({
      data: {
        userId: owner.id,
        courseId,
        title: "Persisted logic quiz",
        topic: "Logic",
        difficulty: "MEDIUM",
        questions: {
          create: [
            { position: 0, type: "TRUE_FALSE", prompt: "A proposition has a truth value.", choices: ["True", "False"], correctAnswer: "True", explanation: "A proposition is a declarative statement with a truth value.", topicNames: ["Logic"] },
            { position: 1, type: "MULTIPLE_CHOICE", prompt: "Which operator means not?", choices: ["¬", "∧", "∨", "→"], correctAnswer: "¬", explanation: "The negation operator is ¬.", topicNames: ["Logic"] },
          ],
        },
      },
      include: { questions: { orderBy: { position: "asc" } } },
    });
    const evaluation = await evaluateAssistantQuizAnswer(quiz.id, { questionId: quiz.questions[0].id, userAnswer: "True" }, owner.headers);
    const hydrated = await getAssistantQuiz(quiz.id, owner.headers);
    expect(hydrated.attempt).toMatchObject({ id: evaluation.quizAttemptId, completedAt: null, evaluations: [{ questionId: quiz.questions[0].id, correct: true, userAnswer: "True" }] });
    expect(hydrated.attempt?.evaluations.some((item) => item.questionId === quiz.questions[1].id)).toBe(false);
    await expect(getAssistantQuiz(quiz.id, other.headers)).rejects.toMatchObject({ code: "QUIZ_NOT_FOUND" });
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

  it("replays a completed Workflow resume turn without duplicate messages", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    const run = await db().workflowRun.create({
      data: {
        userId: owner.id,
        workflowId: "exam-preparation",
        status: "COMPLETED",
        input: { goal: "Prepare for the exam." },
        context: { conversationId: conversation.id, courseId, studyPlanId: null, quizId: null },
      },
    });
    await appendConversationMessage({ conversationId: conversation.id, role: "user", content: "Completed the checkpoint.", turnId: "resume-replay", metadata: { workspaceVisible: true, workflowResume: true } }, owner.headers, { embeddingProvider: null });
    await appendConversationMessage({ conversationId: conversation.id, role: "assistant", content: "Exam preparation is ready.", turnId: "resume-replay", metadata: { workspaceVisible: true, presentationKind: "workflow", workflowRunId: run.id, targetId: "exam-preparation", targetName: "Exam Preparation" } }, owner.headers, { embeddingProvider: null });
    const replay = await resumeAssistantWorkflow(owner.id, run.id, { turnId: "resume-replay", userWork: "Duplicate network retry" }, owner.headers);
    expect("assistantMessage" in replay).toBe(true);
    if ("assistantMessage" in replay) expect(replay.assistantMessage.presentation).toMatchObject({ mode: "workflow", workflow: { runId: run.id, status: "completed" } });
    expect((await getAssistantConversation(conversation.id, owner.headers)).messages).toHaveLength(2);
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
