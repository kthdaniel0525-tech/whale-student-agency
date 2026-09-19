import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  AgentRegistry,
  getStudentAgentDefinitions,
  type AgentExecutionResult,
} from "../server/agents";
import {
  AgentExecutor,
  AgentExecutionError,
  type AgentExecutionRequest,
} from "../server/agents/executor";
import { AIError } from "../server/ai/errors";
import type { AIProvider, AITextResponse } from "../server/ai/types";
import { buildUserContext } from "../server/context/builder";
import { formatContextForAI } from "../server/context/format";
import { contextSchema, ContextError } from "../server/context/validation";
import type {
  ContextCategory,
  ContextData,
  UserContext,
} from "../server/context/types";

const conversationBoundary = vi.hoisted(() => ({
  getScope: vi.fn(),
  buildContext: vi.fn(),
  appendMessage: vi.fn(),
}));

// Only data/auth and AI boundaries are mocked. Shared validators, formatter,
// registry, prompt construction, source handling and executor run normally.
vi.mock("../server/context/builder", () => ({ buildUserContext: vi.fn() }));
vi.mock("../server/conversations", () => ({
  ConversationError: class ConversationError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  getConversationScope: conversationBoundary.getScope,
  buildConversationContext: conversationBoundary.buildContext,
  appendConversationMessage: conversationBoundary.appendMessage,
  formatConversationForAI: () =>
    "[CONVERSATION SUMMARY]\nCurrent goal: study induction.\n\n[RECENT CONVERSATION]\nUser: \"Make the next example harder.\"",
}));
const buildContext = vi.mocked(buildUserContext);
const headers = new Headers({ cookie: "test-session-cookie" });
const reference = "REFERENCE ONLY: induction assumes P(k) and proves P(k+1).";
const fixtures: ContextData = {
  profile: {
    name: "Fixture Student",
    school: "University",
    program: "Math",
    currentYear: 2,
    semester: "Fall",
    academicGoal: "Profile goal",
    explanationDifficulty: "BEGINNER",
    studySessionMinutes: 30,
    timezone: "UTC",
  },
  course: {
    id: "course-1",
    courseCode: "MATH101",
    courseName: "Induction",
    professor: null,
    semester: "Fall",
    description: "Course overview",
  },
  assignments: [
    {
      id: "task-1",
      title: "PRIVATE ASSIGNMENT",
      dueDate: "2026-10-01T00:00:00Z",
      status: "TODO",
      priority: "HIGH",
      estimatedHours: 2,
      overdue: false,
      course: {
        id: "course-1",
        courseCode: "MATH101",
        courseName: "Induction",
      },
    },
  ],
  exams: [
    {
      id: "exam-1",
      title: "PRIVATE EXAM",
      examDate: "2026-10-02T00:00:00Z",
      topics: [],
      daysRemaining: 5,
      course: {
        id: "course-1",
        courseCode: "MATH101",
        courseName: "Induction",
      },
    },
  ],
  documents: [
    {
      content: reference,
      documentTitle: "Lecture 5",
      documentId: "doc-1",
      pageNumber: 2,
      pageEnd: 3,
      courseId: "course-1",
      courseCode: "MATH101",
      chunkIndex: 0,
      similarityScore: 0.91,
    },
  ],
  memories: [{
    id: "memory-1",
    category: "academic-goal",
    key: "academicGoal",
    value: "improve_grades",
    sourceType: "explicit",
    confidence: 95,
    importance: 90,
    stale: false,
    lastUpdated: "2026-09-01T00:00:00.000Z",
    explanation: "Direct user statement",
  }],
  learning: undefined,
};

function context(
  data: ContextData = {},
  requested = Object.keys(data) as ContextCategory[],
): UserContext {
  return {
    ...structuredClone(data),
    metadata: {
      generatedAt: "2026-09-13T00:00:00Z",
      requestedCategories: requested,
      unavailableCategories: requested.filter(
        (category) => data[category] === undefined,
      ),
      truncatedCategories: [],
      estimatedContextSize: JSON.stringify(data).length,
      estimatedTokens: 100,
      maxCharacters: 24000,
    },
  };
}

function registry(): AgentRegistry {
  const result = new AgentRegistry();
  for (const agent of getStudentAgentDefinitions()) result.register(agent);
  return result;
}

function aiBoundary() {
  const generate = vi.fn<AIProvider["generateText"]>().mockResolvedValue({
    id: "provider-request-id",
    model: "test-model",
    text: "Generated response.",
    usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
  });
  const provider: AIProvider = {
    generateText: generate,
    generateStructuredOutput() {
      throw new Error("Executor must only use normal text generation.");
    },
    streamText() {
      throw new Error("Executor must not stream.");
    },
    generateEmbedding() {
      throw new Error("Executor must not retrieve or embed.");
    },
  };
  const getProvider = vi.fn(() => provider);
  return { generate, getProvider };
}

beforeEach(() => {
  buildContext.mockReset();
  buildContext.mockImplementation(async (request) => {
    const selected = contextSchema.safeParse(request);
    if (!selected.success) throw new ContextError("INVALID_REQUEST");
    const categories = (Object.keys(fixtures) as ContextCategory[]).filter(
      (category) => selected.data.options[category],
    );
    const data = Object.fromEntries(
      categories.map((category) => [category, fixtures[category]]),
    );
    return context(data, categories);
  });
  conversationBoundary.getScope.mockReset();
  conversationBoundary.buildContext.mockReset();
  conversationBoundary.appendMessage.mockReset();
  conversationBoundary.getScope.mockResolvedValue({
    id: "PRIVATE CONVERSATION",
    courseId: "course-1",
  });
  conversationBoundary.buildContext.mockResolvedValue({
    conversationId: "PRIVATE CONVERSATION",
    courseId: "course-1",
    recentMessages: [],
    relevantHistoricalMessages: [],
    metadata: {
      recentMessagesUsed: 1,
      historicalMessagesUsed: 0,
      summaryUsed: true,
      estimatedConversationTokens: 42,
      compressionTriggered: false,
      targetConversationTokens: 2800,
      totalAssembledContextEstimate: 1942,
    },
  });
  conversationBoundary.appendMessage.mockResolvedValue({ id: "message-1" });
});

describe("AgentExecutor pipeline", () => {
  it("executes the selected registered agent once and returns the existing result contract", async () => {
    const ai = aiBoundary();
    const executor = new AgentExecutor(registry(), ai);
    const result = await executor.execute(
      { agentId: "notes", request: "Make notes about induction" },
      headers,
    );
    expect(result).toMatchObject({
      agentId: "notes",
      content: "Generated response.",
      metadata: {
        model: "test-model",
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        contextCategories: ["course", "exams", "documents", "memories"],
      },
    });
    expectTypeOf(result).toEqualTypeOf<AgentExecutionResult<unknown, never>>();
    expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    expect(buildContext).toHaveBeenCalledTimes(1);
    expect(ai.getProvider).toHaveBeenCalledTimes(1);
    expect(ai.generate).toHaveBeenCalledTimes(1);
  });

  it("streams text through the provider boundary and returns the persisted final result", async () => {
    const streamText = vi.fn<AIProvider["streamText"]>(async function* () {
      yield { type: "text-delta" as const, text: "Generated " };
      yield { type: "text-delta" as const, text: "response." };
      yield {
        type: "complete" as const,
        response: {
          id: "provider-stream-id",
          model: "test-stream-model",
          text: "Generated response.",
          usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        },
      };
    });
    const provider: AIProvider = {
      generateText: vi.fn(() => Promise.reject(new Error("Text boundary must not run."))),
      generateStructuredOutput: vi.fn(() => Promise.reject(new Error("Structured boundary must not run."))),
      streamText,
      generateEmbedding: vi.fn(() => Promise.reject(new Error("Embedding boundary must not run."))),
    };
    const executor = new AgentExecutor(registry(), { getProvider: () => provider });
    const iterator = executor.stream(
      {
        agentId: "notes",
        request: "Stream notes",
        conversation: { id: "PRIVATE CONVERSATION", turnId: "STREAM TURN" },
      },
      headers,
    );
    const deltas: string[] = [];
    let result: AgentExecutionResult | undefined;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        result = next.value;
        break;
      }
      deltas.push(next.value.text);
    }

    expect(deltas).toEqual(["Generated ", "response."]);
    expect(result).toMatchObject({
      agentId: "notes",
      content: "Generated response.",
      metadata: { model: "test-stream-model" },
    });
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(conversationBoundary.appendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        role: "assistant",
        content: "Generated response.",
        turnId: "STREAM TURN",
      }),
      expect.any(Headers),
      expect.any(Object),
    );
  });

  it("passes exact registry requirements, scope, request, and server headers to Context Builder", async () => {
    const agents = new AgentRegistry();
    agents.register({
      id: "notes",
      name: "Notes",
      description: "Metadata only.",
      capabilities: ["create-notes"],
      contextRequirements: {
        course: true,
        documents: true,
        memories: true,
        memoryKeys: ["academicGoal"],
        limits: { documents: 2, maxCharacters: 2048 },
        deadlineWindowDays: 7,
      },
    });
    const ai = aiBoundary();
    const executor = new AgentExecutor(agents, ai);
    await executor.execute(
      {
        agentId: "notes",
        request: "Make notes",
        courseId: "course-1",
        documentIds: ["doc-1", "doc-1"],
      },
      headers,
    );
    expect(buildContext).toHaveBeenCalledWith(
      {
        request: "Make notes",
        courseId: "course-1",
        documentIds: ["doc-1"],
        options: agents.get("notes").contextRequirements,
      },
      headers,
    );
    expect(buildContext.mock.calls[0][1]).toBe(headers);
    expect(ai.getProvider.mock.invocationCallOrder[0]).toBeGreaterThan(
      buildContext.mock.invocationCallOrder[0],
    );
  });

  it("formats only the declared context and keeps reference data out of system instructions", async () => {
    const ai = aiBoundary();
    const executor = new AgentExecutor(registry(), ai);
    const result = await executor.execute(
      { agentId: "notes", request: "Explain mathematical induction" },
      headers,
    );
    const messages = ai.generate.mock.calls[0][0].messages;
    const built = await buildContext.mock.results[0].value;
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain('"id":"notes"');
    expect(messages[0].content).not.toContain(reference);
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain(
      "Relevant reference data:\n" +
        formatContextForAI(built, { omitPersonalizationSignals: true }),
    );
    expect(messages[0].content).toContain("[ADAPTATION]");
    expect(messages[1].content).not.toContain("[PERSONALIZATION]");
    expect(messages[2]).toEqual({
      role: "user",
      content: "Explain mathematical induction",
    });
    expect(JSON.stringify(messages)).not.toMatch(
      /PRIVATE ASSIGNMENT|Fixture Student/,
    );
    expect(messages[1].content).toContain("PRIVATE EXAM");
    expect(JSON.stringify(messages)).not.toMatch(/\[PREFERENCES\]|improve_grades/);
    expect(result.agentId).toBe("notes"); // Selection is never rerouted to Tutor.
    expect(ai.generate.mock.calls[0][0]).toEqual({ messages, usageContext: expect.objectContaining({ agentId: "notes", ragChunkCount: 1, requestId: expect.any(String) }) });
  });

  it("authenticates via Context Builder even with empty requirements and omits empty reference messages", async () => {
    const agents = new AgentRegistry<"custom-agent">();
    agents.register({
      id: "custom-agent",
      name: "Custom",
      description: "A future role.",
      capabilities: [],
      contextRequirements: {},
    });
    const ai = aiBoundary();
    const executor = new AgentExecutor(agents, ai);
    const result = await executor.execute(
      { agentId: "custom-agent", request: "Hello" },
      headers,
    );
    expect(buildContext).toHaveBeenCalledWith(
      { request: "Hello", options: {} },
      headers,
    );
    expect(result).toMatchObject({
      agentId: "custom-agent",
      sources: [],
      metadata: { contextCategories: [] },
    });
    expect(ai.generate.mock.calls[0][0].messages).toHaveLength(2);
  });

  it("supports newly registered agents and separate, bounded execution instructions", async () => {
    const agents = new AgentRegistry<"custom-agent">();
    const instructions = { "custom-agent": "Use short sentences." };
    const ai = aiBoundary();
    const executor = new AgentExecutor(agents, { ...ai, instructions });
    instructions["custom-agent"] = "Caller mutation";
    agents.register({
      id: "custom-agent",
      name: "Custom",
      description: "Routing description.",
      capabilities: [],
      contextRequirements: {},
    });
    const result = await executor.execute(
      { agentId: "custom-agent", request: "Hello" },
      headers,
    );
    expect(result.agentId).toBe("custom-agent");
    expect(ai.generate.mock.calls[0][0].messages[0].content).toContain(
      "Execution instructions: Use short sentences.",
    );
    expect(JSON.stringify(agents.list())).not.toContain("Use short sentences");
  });

  it("loads bounded conversation context and persists both visible sides of the turn", async () => {
    const ai = aiBoundary();
    const executor = new AgentExecutor(registry(), ai);
    const result = await executor.execute(
      {
        agentId: "notes",
        request: "Hello",
        conversation: { id: "PRIVATE CONVERSATION", turnId: "PRIVATE TURN" },
      },
      headers,
    );
    expect(JSON.stringify(ai.generate.mock.calls)).toContain(
      "Make the next example harder",
    );
    expect(JSON.stringify(buildContext.mock.calls[0][0])).not.toContain(
      "conversation",
    );
    expect(conversationBoundary.getScope).toHaveBeenCalledWith(
      "PRIVATE CONVERSATION",
      headers,
    );
    expect(conversationBoundary.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "PRIVATE CONVERSATION",
        expectedCourseId: "course-1",
      }),
      headers,
      expect.objectContaining({ agentId: "notes" }),
    );
    expect(conversationBoundary.appendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        role: "user",
        content: "Hello",
        turnId: "PRIVATE TURN",
      }),
      headers,
      expect.any(Object),
    );
    expect(conversationBoundary.appendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        role: "assistant",
        content: "Generated response.",
        turnId: "PRIVATE TURN",
        agentId: "notes",
      }),
      expect.any(Headers),
      expect.any(Object),
    );
    expect(result.metadata).toMatchObject({
      conversationId: "PRIVATE CONVERSATION",
      conversationTurnId: "PRIVATE TURN",
      recentMessagesUsed: 1,
      summaryUsed: true,
      estimatedConversationTokens: 42,
    });
  });

  it("reports categories with actual data and never returns raw context or identity", async () => {
    buildContext.mockResolvedValue(
      context({ profile: fixtures.profile, assignments: [], exams: [] }, [
        "profile",
        "course",
        "assignments",
        "exams",
        "learning",
      ]),
    );
    const ai = aiBoundary();
    const result = await new AgentExecutor(registry(), ai).execute(
      { agentId: "academic-manager", request: "Help" },
      headers,
    );
    expect(result.metadata?.contextCategories).toEqual(["profile"]);
    expect(Object.keys(result).sort()).toEqual([
      "agentId",
      "content",
      "metadata",
      "sources",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /Fixture Student|test-session-cookie|generatedAt|estimatedTokens|provider-request-id/,
    );
  });

  it("keeps concurrent requests' context and results separate", async () => {
    buildContext.mockImplementation(async (_request, requestHeaders) =>
      context({
        course: {
          ...fixtures.course!,
          courseName: requestHeaders.get("x-test-label")!,
        },
      }),
    );
    const ai = aiBoundary();
    const executor = new AgentExecutor(registry(), ai);
    await Promise.all([
      executor.execute(
        { agentId: "notes", request: "First request" },
        new Headers({ "x-test-label": "FIRST PRIVATE CONTEXT" }),
      ),
      executor.execute(
        { agentId: "notes", request: "Second request" },
        new Headers({ "x-test-label": "SECOND PRIVATE CONTEXT" }),
      ),
    ]);
    for (const [call] of ai.generate.mock.calls) {
      const first = call.messages.at(-1)?.content === "First request";
      expect(call.messages[1].content).toContain(
        first ? "FIRST PRIVATE CONTEXT" : "SECOND PRIVATE CONTEXT",
      );
      expect(call.messages[1].content).not.toContain(
        first ? "SECOND PRIVATE CONTEXT" : "FIRST PRIVATE CONTEXT",
      );
    }
  });
});

describe("retrieved source preservation", () => {
  it("preserves document/page/chunk provenance and deduplicates repeated references", async () => {
    const document = fixtures.documents![0];
    buildContext.mockResolvedValue(
      context({
        documents: [
          document,
          { ...document },
          { ...document, chunkIndex: 1, pageNumber: 3, pageEnd: 4 },
          {
            ...document,
            documentId: "doc-2",
            pageNumber: null,
            pageEnd: null,
            courseId: null,
            courseCode: null,
          },
        ],
      }),
    );
    const ai = aiBoundary();
    ai.generate.mockResolvedValue({
      id: "fake",
      model: "test-model",
      text: "Generated response.",
      sources: [{ documentId: "invented-by-model" }],
    } as AITextResponse);
    const result = await new AgentExecutor(registry(), ai).execute(
      { agentId: "notes", request: "Make notes" },
      headers,
    );
    expect(result.sources).toHaveLength(3);
    expect(result.sources?.[0]).toEqual({
      documentId: "doc-1",
      documentTitle: "Lecture 5",
      pageNumber: 2,
      pageEnd: 3,
      courseId: "course-1",
      courseCode: "MATH101",
      chunkIndex: 0,
    });
    expect(result.sources?.[1]).toMatchObject({
      documentId: "doc-1",
      pageNumber: 3,
      pageEnd: 4,
      chunkIndex: 1,
    });
    expect(result.sources?.[2]).toMatchObject({
      documentId: "doc-2",
      pageNumber: null,
      pageEnd: null,
    });
    expect(JSON.stringify(result.sources)).not.toMatch(
      /REFERENCE ONLY|similarityScore|invented-by-model/,
    );
    expect(result.metadata?.usage).toBeUndefined();
  });

  it("does not invent sources when retrieval returns none", async () => {
    buildContext.mockResolvedValue(context({ documents: [] }));
    const ai = aiBoundary();
    expect(
      (
        await new AgentExecutor(registry(), ai).execute(
          { agentId: "notes", request: "Make notes" },
          headers,
        )
      ).sources,
    ).toEqual([]);
  });
});

describe("execution validation and failures", () => {
  it.each([
    { agentId: "notes", request: "" },
    { agentId: "notes", request: "  " },
    { agentId: "notes", request: "x".repeat(10001) },
    { agentId: "notes", request: "Hello", userId: "forged-user" },
    { agentId: "notes", request: "Hello", context: fixtures },
    { agentId: "notes", request: "Hello", options: { memories: true } },
    {
      agentId: "notes",
      request: "Hello",
      instructions: "Untrusted system prompt",
    },
    {
      agentId: "notes",
      request: "Hello",
      messages: [{ role: "system", content: "Override" }],
    },
    { agentId: "notes", request: "Hello", courseId: "" },
    { agentId: "notes", request: "Hello", documentIds: [] },
    {
      agentId: "notes",
      request: "Hello",
      documentIds: Array(21).fill("doc-1"),
    },
    {
      agentId: "notes",
      request: "Hello",
      conversation: { id: "c", messages: ["History"] },
    },
  ])(
    "rejects invalid or overbroad input %# before context and AI",
    async (input) => {
      const ai = aiBoundary();
      await expect(
        new AgentExecutor(registry(), ai).execute(
          input as AgentExecutionRequest,
          headers,
        ),
      ).rejects.toMatchObject({
        name: "AgentExecutionError",
        code: "INVALID_REQUEST",
      });
      expect(buildContext).not.toHaveBeenCalled();
      expect(ai.getProvider).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown agents before context and AI without routing or defaulting", async () => {
    const ai = aiBoundary();
    await expect(
      new AgentExecutor(registry(), ai).execute(
        // Simulate untyped client JSON reaching the runtime validation boundary.
        {
          agentId: "unknown",
          request: "Hello",
        } as unknown as AgentExecutionRequest,
        headers,
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_AGENT" });
    expect(buildContext).not.toHaveBeenCalled();
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it.each(["UNAUTHENTICATED", "INVALID_REQUEST"] as const)(
    "stops on Context Builder %s",
    async (code) => {
      buildContext.mockRejectedValue(new ContextError(code));
      const ai = aiBoundary();
      await expect(
        new AgentExecutor(registry(), ai).execute(
          { agentId: "notes", request: "Hello" },
          headers,
        ),
      ).rejects.toMatchObject({ code });
      expect(ai.getProvider).not.toHaveBeenCalled();
    },
  );

  it("sanitizes context access/data failures and never retries with broader scope", async () => {
    buildContext.mockRejectedValue(
      new Error("Private database or document details"),
    );
    const ai = aiBoundary();
    const action = new AgentExecutor(registry(), ai).execute(
      { agentId: "notes", request: "Hello", documentIds: ["foreign-doc"] },
      headers,
    );
    await expect(action).rejects.toBeInstanceOf(AgentExecutionError);
    await expect(action).rejects.toMatchObject({ code: "CONTEXT_FAILURE" });
    await expect(action).rejects.not.toHaveProperty("cause");
    await expect(action).rejects.not.toHaveProperty(
      "message",
      "Private database or document details",
    );
    expect(buildContext).toHaveBeenCalledTimes(1);
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("respects existing RAG query limits instead of truncating or expanding them", async () => {
    const ai = aiBoundary();
    await expect(
      new AgentExecutor(registry(), ai).execute(
        { agentId: "notes", request: "x".repeat(1001) },
        headers,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(buildContext.mock.calls[0][0].request).toHaveLength(1001);
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it.each(["", " ", "x".repeat(1001)])(
    "rejects unbounded or blank server instructions %#",
    (instructions) => {
      expect(
        () =>
          new AgentExecutor(registry(), {
            instructions: { tutor: instructions },
          }),
      ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    },
  );

  it.each([
    "CONFIGURATION",
    "AUTHENTICATION",
    "RATE_LIMIT",
    "CANCELLED",
  ] as const)("preserves safe AIError code %s", async (code) => {
    const ai = aiBoundary();
    ai.generate.mockRejectedValue(new AIError(code));
    const action = new AgentExecutor(registry(), ai).execute(
      { agentId: "notes", request: "Hello" },
      headers,
    );
    await expect(action).rejects.toBeInstanceOf(AIError);
    await expect(action).rejects.toMatchObject({
      code,
      retryable: code === "RATE_LIMIT",
    });
    expect(ai.generate).toHaveBeenCalledTimes(1);
  });

  it("sanitizes unknown provider errors without retrying", async () => {
    const ai = aiBoundary();
    ai.generate.mockRejectedValue(
      new Error("Provider credential or raw payload"),
    );
    const action = new AgentExecutor(registry(), ai).execute(
      { agentId: "notes", request: "Hello" },
      headers,
    );
    await expect(action).rejects.toMatchObject({
      code: "PROVIDER_FAILURE",
      message: new AIError("PROVIDER_FAILURE").message,
    });
    await expect(action).rejects.not.toHaveProperty("cause");
    expect(ai.generate).toHaveBeenCalledTimes(1);
  });

  it("handles provider initialization failure after authenticated context preparation", async () => {
    const getProvider = vi.fn((): AIProvider => {
      throw new AIError("CONFIGURATION");
    });
    await expect(
      new AgentExecutor(registry(), { getProvider }).execute(
        { agentId: "notes", request: "Hello" },
        headers,
      ),
    ).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(buildContext).toHaveBeenCalledTimes(1);
    expect(getProvider).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    null,
    { text: "", model: "test-model" },
    { text: "   ", model: "test-model" },
    { text: "Answer" },
    { text: 42, model: "test-model" },
    {
      text: "Answer",
      model: "test-model",
      usage: { inputTokens: -1, outputTokens: 2, totalTokens: 1 },
    },
  ])("rejects malformed or blank provider output %#", async (data) => {
    const ai = aiBoundary();
    ai.generate.mockResolvedValue(data as AITextResponse);
    await expect(
      new AgentExecutor(registry(), ai).execute(
        { agentId: "notes", request: "Hello" },
        headers,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
