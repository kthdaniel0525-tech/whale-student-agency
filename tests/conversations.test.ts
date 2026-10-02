import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import type {
  AIEmbeddingProvider,
  AIProvider,
  AIStructuredRequest,
} from "@/server/ai/types";
import {
  AgentExecutor,
} from "@/server/agents/executor";
import { AgentRegistry, STUDENT_AGENT_IDS } from "@/server/agents";
import {
  appendConversationMessage,
  buildConversationContext,
  compressConversation,
  CONVERSATION_CONFIG,
  ConversationError,
  createConversation,
  deleteConversation,
  deleteConversationMessage,
  getConversation,
  retrieveRelevantConversationMessages,
} from "@/server/conversations";
import { applyConversationBudget } from "@/server/conversations/budget";
import type {
  ConversationMessageRecord,
  ConversationSummaryData,
  ConversationSummaryRecord,
} from "@/server/conversations/types";

type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor;
let other: Actor;
let courseId: string;

async function createActor(label: string): Promise<Actor> {
  const email = `conversation-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: {
      name: label,
      email,
      password: "Conversation-test-passphrase-2026!",
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  const actor = {
    id: body.user.id,
    email,
    headers: new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    }),
  };
  actors.push(actor);
  await db().profile.create({
    data: {
      userId: actor.id,
      school: "Conversation Test University",
      program: "Mathematics",
      currentYear: 2,
      semester: "Fall 2026",
      academicGoal: "Build durable understanding",
      studySessionMinutes: 45,
      explanationDifficulty: "INTERMEDIATE",
    },
  });
  return actor;
}

function emptySummary(): ConversationSummaryData {
  return {
    activeGoals: [],
    importantFacts: [],
    decisions: [],
    unresolvedItems: [],
    activeResources: [],
    recentProgress: [],
    corrections: [],
    summaryText: "Earlier conversation context.",
  };
}

function summaryBoundary() {
  const calls: Array<{
    previousSummary: ConversationSummaryData | null;
    newMessages: Array<{ id: string; role: string; content: string }>;
  }> = [];
  const generateStructuredOutput = vi.fn(
    async (request: AIStructuredRequest<unknown>) => {
      expect(request.schemaName).toBe("conversation_summary");
      const payload = JSON.parse(request.messages[1].content) as (typeof calls)[number];
      calls.push(payload);
      const previous = payload.previousSummary ?? emptySummary();
      const item = (message: (typeof payload.newMessages)[number]) => ({
        text: message.content,
        sourceMessageIds: [message.id],
      });
      const user = payload.newMessages.filter((message) => message.role === "user");
      const assistant = payload.newMessages.filter(
        (message) => message.role === "assistant",
      );
      const data = {
        activeGoals: [
          ...previous.activeGoals,
          ...user.filter((message) => /goal|prepare|목표/i.test(message.content)).map(item),
        ],
        importantFacts: [
          ...previous.importantFacts,
          ...user.filter((message) => /must|exactly|professor|exam/i.test(message.content)).map(item),
        ],
        decisions: [
          ...previous.decisions,
          ...user.filter((message) => /decided|choose/i.test(message.content)).map(item),
        ],
        unresolvedItems: [
          ...previous.unresolvedItems,
          ...user.filter((message) => /upload|later|waiting|\?/i.test(message.content)).map(item),
        ],
        activeResources: [
          ...previous.activeResources,
          ...user.filter((message) => /lecture|assignment|proof|quiz/i.test(message.content)).map(item),
        ],
        recentProgress: [
          ...previous.recentProgress,
          ...assistant.filter((message) => /created|reviewed|completed/i.test(message.content)).map(item),
        ],
        corrections: [
          ...previous.corrections,
          ...user.filter((message) => /actually|correction|changed/i.test(message.content)).map(item),
        ],
        summaryText: `${previous.summaryText} ${payload.newMessages
          .map((message) => message.content)
          .join(" ")}`.slice(0, CONVERSATION_CONFIG.maximumSummaryTextCharacters),
      };
      return {
        id: randomUUID(),
        model: "summary-test-model",
        text: JSON.stringify(data),
        data: request.schema.parse(data),
      };
    },
  );
  const provider: AIProvider = {
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      const response = await generateStructuredOutput(
        request as AIStructuredRequest<unknown>,
      );
      return { ...response, data: request.schema.parse(response.data) };
    },
    async generateText() {
      throw new Error("Summary tests use structured output only.");
    },
    async *streamText() {
      throw new Error("Summary tests do not stream.");
    },
    async generateEmbedding() {
      throw new Error("Summary tests supply embeddings separately.");
    },
  };
  return { calls, provider, generateStructuredOutput };
}

function semanticEmbedding(): AIEmbeddingProvider {
  return {
    async generateEmbedding({ input }) {
      const text = input.toLocaleLowerCase();
      const vector = Array<number>(384).fill(0);
      if (/wrong|incorrect|mistake|got .* wrong/.test(text)) vector[0] = 1;
      if (/induction|proof/.test(text)) vector[1] = 1;
      if (/recurrence|recursive/.test(text)) vector[2] = 1;
      if (/worksheet|alpha/.test(text)) vector[3] = 1;
      if (!vector.some(Boolean)) {
        let hash = 0;
        for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
        vector[10 + (hash % 374)] = 1;
      }
      return { model: "conversation-test-embedding-v1", vector };
    },
  };
}

async function appendMany(
  conversationId: string,
  contents: readonly string[],
  embeddingProvider: AIEmbeddingProvider | null = null,
) {
  const records = [];
  for (const [index, content] of contents.entries()) {
    records.push(
      await appendConversationMessage(
        {
          conversationId,
          role: index % 2 ? "assistant" : "user",
          content,
          ...(index % 2 ? { agentId: "tutor" } : {}),
        },
        owner.headers,
        { embeddingProvider },
      ),
    );
  }
  return records;
}

beforeAll(async () => {
  owner = await createActor("Conversation Owner");
  other = await createActor("Conversation Other User");
  courseId = (
    await db().course.create({
      data: {
        userId: owner.id,
        courseCode: "CONV MATH 1240",
        courseName: "Proofs and Induction",
        semester: "Fall 2026",
      },
    })
  ).id;
});

afterAll(async () => {
  for (const actor of actors) {
    await db().user.deleteMany({ where: { id: actor.id, email: actor.email } });
    await db().fileDeletion.deleteMany({ where: { userId: actor.id } });
  }
  await db().$disconnect();
});

describe.sequential("Conversation persistence and compression", () => {
  it("persists bounded source and presentation metadata without widening arbitrary metadata", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    const sourceRefs = JSON.stringify(Array.from({ length: 8 }, (_, index) => ({
      documentId: `document-${index}`,
      documentTitle: `Synthetic lecture source ${index}`,
      chunkIndex: index,
      pageNumber: index + 1,
      courseCode: "MATH 1240",
    })));
    const presentationData = JSON.stringify({
      title: "Synthetic notes",
      notes: "x".repeat(2_000),
    });
    expect(sourceRefs.length).toBeGreaterThan(500);
    const message = await appendConversationMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "Source-grounded synthetic answer.",
      agentId: "notes",
      metadata: { workspaceVisible: true, sourceRefs, presentationData },
    }, owner.headers, { embeddingProvider: null });
    expect(message.metadata).toMatchObject({ sourceRefs, presentationData });
    await expect(appendConversationMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "Invalid oversized generic metadata.",
      agentId: "notes",
      metadata: { arbitrary: "x".repeat(501) },
    }, owner.headers, { embeddingProvider: null })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("persists ordered roles and agent metadata, derives a title, and enforces ownership", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    const first = await appendConversationMessage(
      {
        conversationId: conversation.id,
        role: "user",
        content: "Help me prepare for mathematical induction.",
        turnId: "turn-one",
      },
      owner.headers,
      { embeddingProvider: null },
    );
    const duplicate = await appendConversationMessage(
      {
        conversationId: conversation.id,
        role: "user",
        content: "Help me prepare for mathematical induction.",
        turnId: "turn-one",
      },
      owner.headers,
      { embeddingProvider: null },
    );
    await appendConversationMessage(
      {
        conversationId: conversation.id,
        role: "assistant",
        content: "We will start with the base case.",
        turnId: "turn-one",
        agentId: "tutor",
      },
      owner.headers,
      { embeddingProvider: null },
    );
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        appendConversationMessage(
          {
            conversationId: conversation.id,
            role: "user",
            content: "Give me one more base-case exercise.",
            turnId: "turn-two",
          },
          owner.headers,
          { embeddingProvider: null },
        ),
      ),
    );
    expect(new Set(concurrent.map((message) => message.id)).size).toBe(1);
    expect(duplicate.id).toBe(first.id);
    const stored = await getConversation(conversation.id, owner.headers);
    expect(stored).toMatchObject({
      courseId,
      messageCount: 3,
      title: "Help me prepare for mathematical induction.",
    });
    expect(stored.messages.map((message) => [message.sequence, message.role, message.agentId])).toEqual([
      [1, "user", null],
      [2, "assistant", "tutor"],
      [3, "user", null],
    ]);
    await expect(appendConversationMessage({
      conversationId: conversation.id,
      role: "internal",
      content: "Visible internal status only.",
      metadata: { chainOfThought: "must not be stored" },
    }, owner.headers, { embeddingProvider: null })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(getConversation(conversation.id, other.headers)).rejects.toMatchObject({
      code: "CONVERSATION_NOT_FOUND",
    });
    await expect(deleteConversation(conversation.id, other.headers)).rejects.toBeInstanceOf(
      ConversationError,
    );
  });

  it("creates and incrementally updates a structured summary while preserving recent turns, corrections, constraints and unresolved work", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    const initial = [
      "My goal is to prepare for the MATH 1240 exam on Friday.",
      "I created the study outline.",
      "Use the professor's definition exactly.",
      "I reviewed the first proof.",
      "I will upload my assignment draft later.",
      "I created an upload checklist.",
      "Question difficulty must be easy.",
      "I reviewed another example.",
      ...Array.from({ length: 18 }, (_, index) =>
        index % 2
          ? `I completed practice response ${index}.`
          : `Practice request ${index} about induction.`,
      ),
    ];
    const records = await appendMany(conversation.id, initial);
    const memoryCount = await db().userMemory.count({ where: { userId: owner.id } });
    const boundary = summaryBoundary();
    const firstContext = await buildConversationContext({
      conversationId: conversation.id,
      query: "Continue preparing for the exam.",
      expectedCourseId: courseId,
    }, owner.headers, {
      getProvider: () => boundary.provider,
      embeddingProvider: null,
    });
    const first = firstContext.summary;
    expect(firstContext.metadata.compressionTriggered).toBe(true);
    expect(first?.version).toBe(1);
    expect(boundary.calls[0].previousSummary).toBeNull();
    expect(boundary.calls[0].newMessages).toHaveLength(14);
    expect(first?.importantFacts.some((item) => item.text.includes("professor"))).toBe(true);
    expect(first?.unresolvedItems.some((item) => item.text.includes("upload"))).toBe(true);
    expect(first?.importantFacts.filter((item) => item.text.includes("professor"))).toHaveLength(1);

    const correctionRecords = await appendMany(conversation.id, [
      "Actually, the exam changed to Monday.",
      "I updated the schedule.",
      "Actually, the question difficulty changed to hard.",
      "I updated the difficulty.",
      "The assignment still requires exactly three sections.",
      "I reviewed the new deadline.",
      ...Array.from({ length: 12 }, (_, index) =>
        index % 2
          ? `I completed follow-up ${index}.`
          : `Follow-up practice request ${index}.`,
      ),
    ]);
    const second = await compressConversation(conversation.id, owner.headers, {
      forceCompression: true,
      getProvider: () => boundary.provider,
      embeddingProvider: null,
    });
    expect(second?.version).toBe(2);
    expect(boundary.calls[1].previousSummary?.importantFacts.length).toBeGreaterThan(0);
    expect(boundary.calls[1].newMessages.map((message) => message.id)).toEqual(
      records.slice(14).concat(correctionRecords).slice(0, 18).map((message) => message.id),
    );
    expect(JSON.stringify(boundary.calls[1].newMessages)).not.toContain(initial[0]);
    expect(second?.corrections.some((item) => item.text.includes("Monday"))).toBe(true);
    expect(second?.corrections.at(-1)?.text).toContain("hard");
    expect(second?.summaryText).toContain("Monday");
    expect(second?.summaryText).toContain("hard");
    expect(second?.summaryText).not.toContain("Friday");
    expect(second?.importantFacts.some((item) => item.text.includes("easy"))).toBe(false);
    expect(second?.importantFacts.some((item) => item.text.includes("Friday"))).toBe(false);
    const stored = await getConversation(conversation.id, owner.headers);
    expect(stored.messages).toHaveLength(CONVERSATION_CONFIG.recentMessageCount);
    expect(stored.messages.at(-1)?.content).toContain("follow-up 11");
    expect(await db().userMemory.count({ where: { userId: owner.id } })).toBe(memoryCount);

    const criticalSource = second!.importantFacts.find((item) =>
      item.text.includes("exactly three sections"),
    )!.sourceMessageIds[0];
    await deleteConversationMessage(conversation.id, criticalSource, owner.headers);
    expect((await getConversation(conversation.id, owner.headers)).summary).toBeUndefined();
  });

  it.each(["new message", "previous summary", "whole conversation"] as const)(
    "does not restore deleted content when %s is removed during summary generation",
    async (deletion) => {
      const conversation = await createConversation({}, owner.headers);
      const deletedText = `My goal is confidential deletion evidence ${randomUUID()}.`;
      const messages = await appendMany(conversation.id, [
        deletedText,
        ...Array.from({ length: 25 }, (_, index) => `Practice checkpoint ${index}.`),
      ]);
      const boundary = summaryBoundary();
      if (deletion === "previous summary") {
        await compressConversation(conversation.id, owner.headers, {
          getProvider: () => boundary.provider,
          embeddingProvider: null,
        });
        expect((await getConversation(conversation.id, owner.headers)).summary?.summaryText)
          .toContain(deletedText);
        await appendMany(conversation.id, Array.from({ length: 14 }, (_, index) => `New checkpoint ${index}.`));
      }
      let deletedDuringGeneration = false;
      const provider: AIProvider = {
        ...boundary.provider,
        async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
          const result = await boundary.provider.generateStructuredOutput(request);
          // Deterministically model a deletion that commits while the external
          // summary request is in flight, before its result is persisted.
          if (deletion === "whole conversation")
            await deleteConversation(conversation.id, owner.headers);
          else await deleteConversationMessage(conversation.id, messages[0].id, owner.headers);
          deletedDuringGeneration = true;
          return result;
        },
      };
      expect(await compressConversation(conversation.id, owner.headers, {
        getProvider: () => provider,
        embeddingProvider: null,
      })).toBeUndefined();
      expect(deletedDuringGeneration).toBe(true);
      expect(await db().conversationSummary.count({ where: { conversationId: conversation.id } })).toBe(0);
      expect(await db().conversationMessage.count({ where: { id: messages[0].id } })).toBe(0);
      if (deletion !== "whole conversation") {
        const retrieved = await retrieveRelevantConversationMessages({
          conversationId: conversation.id,
          query: "confidential deletion evidence",
        }, owner.headers, { embeddingProvider: null });
        expect(JSON.stringify(retrieved)).not.toContain(deletedText);
        const refreshed = await compressConversation(conversation.id, owner.headers, { embeddingProvider: null });
        expect(JSON.stringify(refreshed)).not.toContain(deletedText);
      }
    },
  );

  it("retrieves exact and paraphrased old messages with bounded same-conversation results", async () => {
    const embeddingProvider = semanticEmbedding();
    const conversation = await createConversation({}, owner.headers);
    const otherConversation = await createConversation({}, owner.headers);
    const messages = await appendMany(
      conversation.id,
      [
        "I got the induction base-case proof wrong earlier.",
        "We reviewed why the starting value must be checked.",
        "The recurrence worksheet alpha is the resource I meant.",
        "I created recurrence notes.",
        "A hard induction problem used a divisibility claim.",
        "We reviewed the divisibility proof.",
        "The proof by contradiction example was about irrationality.",
        "I completed that example.",
      ],
      embeddingProvider,
    );
    await appendConversationMessage(
      {
        conversationId: otherConversation.id,
        role: "user",
        content: "PRIVATE recurrence worksheet alpha from another conversation.",
      },
      owner.headers,
      { embeddingProvider },
    );
    const exact = await retrieveRelevantConversationMessages(
      { conversationId: conversation.id, query: "recurrence worksheet alpha", limit: 3 },
      owner.headers,
      { embeddingProvider },
    );
    expect(exact[0].content).toContain("recurrence worksheet alpha");
    expect(JSON.stringify(exact)).not.toContain("PRIVATE");
    const paraphrased = await retrieveRelevantConversationMessages(
      { conversationId: conversation.id, query: "Give me another problem like the one I got wrong earlier.", limit: 2 },
      owner.headers,
      { embeddingProvider },
    );
    expect(paraphrased[0].id).toBe(messages[0].id);
    expect(paraphrased.length).toBeLessThanOrEqual(2);
    const irrelevant = await retrieveRelevantConversationMessages(
      { conversationId: conversation.id, query: "cafeteria lunch menu", limit: 3 },
      owner.headers,
      { embeddingProvider },
    );
    expect(irrelevant).toEqual([]);
    await expect(
      retrieveRelevantConversationMessages(
        { conversationId: conversation.id, query: "induction" },
        other.headers,
        { embeddingProvider },
      ),
    ).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" });
  });

  it("drops duplicate/low-value history before summary-covered recent messages under context pressure", () => {
    const message = (sequence: number, content = `Recent detail ${sequence}`): ConversationMessageRecord => ({
      id: `message-${sequence}`,
      conversationId: "conversation-budget",
      sequence,
      turnId: null,
      role: sequence % 2 ? "user" : "assistant",
      content,
      agentId: sequence % 2 ? null : "tutor",
      metadata: null,
      tokenEstimate: 100,
      createdAt: new Date(2026, 8, sequence).toISOString(),
    });
    const summary: ConversationSummaryRecord = {
      id: "summary",
      ...emptySummary(),
      importantFacts: [{ text: "Prepare for MATH 1240.", sourceMessageIds: ["message-1"] }],
      coveredUntilMessageId: "message-8",
      coveredUntilSequence: 8,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    const context = applyConversationBudget({
      conversationId: "conversation-budget",
      courseId: null,
      summary,
      recentMessages: Array.from({ length: 12 }, (_, index) => message(index + 1)),
      historicalMessages: [
        message(20, "Prepare for MATH 1240."),
        message(21, "Low relevance historical aside."),
      ],
      targetTokens: 500,
      compressionTriggered: true,
      domainEstimatedTokens: 900,
    });
    expect(context.relevantHistoricalMessages).toEqual([]);
    expect(context.recentMessages.map((item) => item.sequence)).toEqual([9, 10, 11, 12]);
    expect(context.metadata).toMatchObject({
      recentMessagesUsed: 4,
      historicalMessagesUsed: 0,
      summaryUsed: true,
      compressionTriggered: true,
    });
    expect(context.metadata.estimatedConversationTokens).toBeLessThanOrEqual(500);
  });

  it("supplies one shared conversation layer to all six agents and records assistant identity", async () => {
    const registry = new AgentRegistry();
    for (const id of STUDENT_AGENT_IDS) {
      registry.register({
        id,
        name: id,
        description: `${id} conversation integration`,
        capabilities: [],
        contextRequirements: {},
      });
    }
    const generated = vi.fn<AIProvider["generateText"]>(async (request) => ({
      id: randomUUID(),
      model: "conversation-agent-test",
      text: `Continued with ${request.messages.at(-1)?.content}`,
    }));
    const provider: AIProvider = {
      generateText: generated,
      async generateStructuredOutput() {
        throw new Error("Plain executor test only.");
      },
      async *streamText() {
        throw new Error("No streaming.");
      },
      async generateEmbedding() {
        throw new Error("Semantic conversation retrieval is disabled here.");
      },
    };
    const conversation = await createConversation({}, owner.headers);
    await appendConversationMessage(
      {
        conversationId: conversation.id,
        role: "user",
        content: "Keep the current format and make the next exercise harder.",
      },
      owner.headers,
      { embeddingProvider: null },
    );
    const executor = new AgentExecutor(registry, {
      getProvider: () => provider,
      conversationEmbeddingProvider: null,
    });
    for (const agentId of STUDENT_AGENT_IDS) {
      const result = await executor.execute(
        {
          agentId,
          request: `Continue this ${agentId} discussion.`,
          conversation: { id: conversation.id, turnId: `turn-${agentId}` },
        },
        owner.headers,
      );
      expect(result.metadata).toMatchObject({
        conversationId: conversation.id,
        conversationTurnId: `turn-${agentId}`,
      });
    }
    expect(generated).toHaveBeenCalledTimes(6);
    for (const call of generated.mock.calls) {
      expect(call[0].messages.map((item) => item.content).join("\n")).toContain(
        "Keep the current format",
      );
    }
    const stored = await getConversation(conversation.id, owner.headers, 100);
    expect(
      new Set(
        stored.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.agentId),
      ),
    ).toEqual(new Set(STUDENT_AGENT_IDS));
  });

  it("includes fresh Learning Intelligence with precedence over a stale conversation summary", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    await appendMany(conversation.id, [
      "The induction mastery must be treated as 20 for this old discussion.",
      "I reviewed the old learning estimate.",
      ...Array.from({ length: 24 }, (_, index) =>
        index % 2 ? `I completed old turn ${index}.` : `Old study turn ${index}.`,
      ),
    ]);
    await compressConversation(conversation.id, owner.headers, {
      forceCompression: true,
      embeddingProvider: null,
    });
    const topic = await db().learningTopic.create({
      data: {
        userId: owner.id,
        courseId,
        name: "Fresh Induction Evidence",
        normalizedName: `fresh induction evidence ${randomUUID()}`,
      },
    });
    await db().learningProgress.create({
      data: {
        userId: owner.id,
        courseId,
        topicId: topic.id,
        masteryScore: 90,
        confidenceScore: 88,
        recentAccuracy: 92,
        questionsAttempted: 12,
        correctAnswers: 11,
        incorrectAnswers: 1,
        scoreTotal: 11,
        difficultyWeightedScore: 11,
        difficultyWeightTotal: 12,
        practiceSessions: 4,
        mediumAttempts: 12,
        firstPracticedAt: new Date(Date.now() - 20 * 86400000),
        lastPracticedAt: new Date(),
        trend: "IMPROVING",
      },
    });
    const generateText = vi.fn<AIProvider["generateText"]>(async () => ({
      id: randomUUID(),
      model: "fresh-learning-test",
      text: "Used the current learning state.",
    }));
    const provider: AIProvider = {
      generateText,
      async generateStructuredOutput() {
        throw new Error("Plain execution only.");
      },
      async *streamText() {
        throw new Error("No streaming.");
      },
      async generateEmbedding() {
        throw new Error("Conversation embeddings are disabled.");
      },
    };
    const registry = new AgentRegistry();
    registry.register({
      id: "tutor",
      name: "Tutor",
      description: "Learning-aware tutor.",
      capabilities: ["explain-concepts"],
      contextRequirements: { course: true, learning: true },
    });
    await new AgentExecutor(registry, {
      getProvider: () => provider,
      conversationEmbeddingProvider: null,
    }).execute({
      agentId: "tutor",
      request: "Explain induction again using my current progress.",
      courseId,
      conversation: { id: conversation.id },
    }, owner.headers);
    const prompt = generateText.mock.calls[0][0].messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("must be treated as 20");
    expect(prompt).toContain('"mastery":90');
    expect(prompt).toContain("prefer current Context Builder facts");
  });

  it("rejects cross-course conversation scope and cascades messages, summaries and vectors", async () => {
    const conversation = await createConversation({ courseId }, owner.headers);
    await appendMany(
      conversation.id,
      Array.from({ length: 26 }, (_, index) =>
        index % 2 ? `I completed item ${index}.` : `My goal item ${index}.`,
      ),
      semanticEmbedding(),
    );
    await compressConversation(conversation.id, owner.headers, {
      forceCompression: true,
      embeddingProvider: null,
    });
    const secondCourse = await db().course.create({
      data: {
        userId: owner.id,
        courseCode: `OTHER-${randomUUID().slice(0, 6)}`,
        courseName: "Other Course",
        semester: "Fall 2026",
      },
    });
    const registry = new AgentRegistry<"scope-test">();
    registry.register({
      id: "scope-test",
      name: "Scope Test",
      description: "Checks conversation scope.",
      capabilities: [],
      contextRequirements: {},
    });
    const executor = new AgentExecutor(registry, {
      conversationEmbeddingProvider: null,
    });
    await expect(
      executor.execute(
        {
          agentId: "scope-test",
          request: "Continue",
          courseId: secondCourse.id,
          conversation: { id: conversation.id },
        },
        owner.headers,
      ),
    ).rejects.toMatchObject({
      code: "CONVERSATION_NOT_FOUND",
    });
    expect(
      await db().$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) FROM "ConversationMessage"
        WHERE "conversationId"=${conversation.id} AND embedding IS NOT NULL
      `,
    ).toEqual([{ count: BigInt(26) }]);
    await deleteConversation(conversation.id, owner.headers);
    expect(await db().conversationMessage.count({ where: { conversationId: conversation.id } })).toBe(0);
    expect(await db().conversationSummary.count({ where: { conversationId: conversation.id } })).toBe(0);
  });
});
