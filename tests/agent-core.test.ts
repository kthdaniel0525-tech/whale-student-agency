import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { AIError } from "@/server/ai/errors";
import type {
  AIProvider,
  AIStructuredRequest,
  AIStructuredResponse,
} from "@/server/ai/types";
import * as contextBuilder from "@/server/context/builder";
import { embeddingProvider } from "@/server/documents/embeddings";
import { AgentRegistry, getStudentAgentDefinitions } from "@/server/agents";
import { AgentRouter } from "@/server/agents/router";
import { AgentExecutor } from "@/server/agents/executor";
import { AgentService } from "@/server/agents/core";
import { createConversation } from "@/server/conversations";

type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let student: Actor;
let foreignStudent: Actor;
let courseId: string;
let foreignCourseId: string;
let documentId: string;
let foreignDocumentId: string;

const material =
  "Mathematical induction proves a proposition by establishing a base case. The inductive hypothesis assumes the proposition holds for an arbitrary k. The inductive step then proves it for k plus one.";

async function createActor(name: string): Promise<Actor> {
  const email = `agent-core-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: { name, email, password: "Agent-core-test-passphrase-2026!" },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const data = (await response.json()) as { user: { id: string } };
  const actor = {
    id: data.user.id,
    email,
    headers: new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
    }),
  };
  actors.push(actor);
  await db().profile.create({
    data: {
      userId: actor.id,
      school: "Core Test University",
      program: "Mathematics",
      currentYear: 2,
      semester: "Fall 2026",
      academicGoal: "Understand mathematical induction",
      studySessionMinutes: 45,
      explanationDifficulty: "INTERMEDIATE",
    },
  });
  return actor;
}

async function createCourse(userId: string, courseCode: string) {
  return (
    await db().course.create({
      data: {
        userId,
        courseCode,
        courseName: courseCode,
        semester: "Fall 2026",
        professor: "Test Professor",
        description: "A course on mathematical induction",
      },
    })
  ).id;
}

async function createDocument(
  userId: string,
  parentCourseId: string,
  content: string,
) {
  const document = await db().document.create({
    data: {
      userId,
      courseId: parentCourseId,
      title: "Mathematical induction lecture",
      originalFileName: "induction.txt",
      fileType: "TXT",
      fileSize: content.length,
      storageKey: randomUUID(),
      processingStatus: "READY",
      embeddingModel: embeddingProvider.id,
      pageCount: 3,
    },
  });
  const vector = JSON.stringify(
    await embeddingProvider.generateEmbedding(content),
  );
  await db()
    .$executeRaw`INSERT INTO "DocumentChunk" (id,"documentId","userId","courseId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata) VALUES (${randomUUID()},${document.id},${userId},${parentCourseId},0,${content},2,3,50,${vector}::vector,${embeddingProvider.id},'{}'::jsonb)`;
  return document.id;
}

function registry() {
  const agents = new AgentRegistry();
  for (const agent of getStudentAgentDefinitions()) agents.register(agent);
  return agents;
}

/** Only model generation is replaced; routing, execution, auth, DB and RAG run. */
function providerBoundary() {
  const generate = vi.fn<AIProvider["generateText"]>().mockResolvedValue({
    id: "private-provider-response-id",
    text: "Generated response from the provider boundary.",
    model: "integration-test-model",
    usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
  });
  const structured = vi.fn(
    async <T>(
      request: AIStructuredRequest<T>,
    ): Promise<AIStructuredResponse<T>> => ({
      id: "routing-response-id",
      text: '{"agentId":"tutor","confidence":0.76}',
      model: "integration-test-model",
      data: request.schema.parse({ agentId: "tutor", confidence: 0.76 }),
    }),
  );
  const provider: AIProvider = {
    generateText: generate,
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      const response = await structured(request);
      return { ...response, data: request.schema.parse(response.data) };
    },
    streamText() {
      throw new Error("Core integration must not introduce streaming.");
    },
    generateEmbedding() {
      throw new Error("RAG must retain its existing local embedding provider.");
    },
  };
  const getProvider = vi.fn(() => provider);
  return { generate, structured, getProvider };
}

function setup() {
  const agents = registry();
  const ai = providerBoundary();
  const service = new AgentService(agents, {
    router: { getProvider: ai.getProvider },
    executor: { getProvider: ai.getProvider, conversationEmbeddingProvider: null },
  });
  return { agents, ai, service };
}

beforeAll(async () => {
  student = await createActor("Core Student");
  foreignStudent = await createActor("FOREIGN PRIVATE STUDENT");
  courseId = await createCourse(student.id, "CORE MATH 1240");
  foreignCourseId = await createCourse(
    foreignStudent.id,
    "FOREIGN PRIVATE COURSE",
  );
  documentId = await createDocument(student.id, courseId, material);
  foreignDocumentId = await createDocument(
    foreignStudent.id,
    foreignCourseId,
    material + " FOREIGN PRIVATE DOCUMENT",
  );
}, 30000);

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  for (const actor of actors) {
    await db().user.deleteMany({ where: { id: actor.id, email: actor.email } });
    // The fixture creates metadata/vectors only, so no file cleanup is needed.
    await db().fileDeletion.deleteMany({ where: { userId: actor.id } });
  }
  await db().$disconnect();
});

describe.sequential(
  "authenticated Agent Core with real Router, Executor and context",
  () => {
    it.each([
      ["Explain mathematical induction", "tutor"],
      ["Summarize my lecture", "notes"],
      ["Quiz me on recursion", "quiz"],
      ["Create a study plan for my exam", "study-planner"],
    ] as const)(
      "routes %s to %s and executes it once",
      async (request, agentId) => {
        const { agents, ai, service } = setup();
        const route = vi.spyOn(AgentRouter.prototype, "routeAgent");
        const execute = vi.spyOn(AgentExecutor.prototype, "execute");
        const build = vi.spyOn(contextBuilder, "buildUserContext");
        const result = await service.handleAgentRequest(
          { request, courseId },
          student.headers,
        );
        expect(result).toMatchObject({
          ok: true,
          agent: { id: agentId, name: agents.get(agentId).name },
          routing: { agentId, method: "rule", confidence: 0.92 },
          response: {
            content: "Generated response from the provider boundary.",
          },
        });
        expect(route).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0][0]).toEqual({
          agentId,
          request,
          courseId,
        });
        expect(build).toHaveBeenCalledTimes(1);
        expect(build.mock.calls[0][0]).toEqual({
          request,
          courseId,
          options: agents.get(agentId).contextRequirements,
        });
        expect(ai.generate).toHaveBeenCalledTimes(1);
        expect(ai.structured).not.toHaveBeenCalled();
        expect(ai.getProvider).toHaveBeenCalledTimes(1);
        expect(route.mock.invocationCallOrder[0]).toBeLessThan(
          execute.mock.invocationCallOrder[0],
        );
      },
    );

    it("passes explicit selection through the Router and preserves its decision", async () => {
      const { ai, service } = setup();
      const route = vi.spyOn(AgentRouter.prototype, "routeAgent");
      const execute = vi.spyOn(AgentExecutor.prototype, "execute");
      const input = {
        request: "Explain mathematical induction",
        preferredAgentId: "notes",
        courseId,
      };
      const result = await service.handleAgentRequest(input, student.headers);
      expect(route).toHaveBeenCalledWith({
        request: input.request,
        preferredAgentId: "notes",
      });
      expect(result).toMatchObject({
        ok: true,
        agent: { id: "notes", name: "Notes" },
        routing: { agentId: "notes", confidence: 1, method: "rule" },
      });
      expect(execute.mock.calls[0][0].agentId).toBe("notes");
      expect(ai.structured).not.toHaveBeenCalled();
    });

    it("normalizes an unknown explicit selection without executing or exposing the supplied ID", async () => {
      const { ai, service } = setup();
      const route = vi.spyOn(AgentRouter.prototype, "routeAgent");
      const execute = vi.spyOn(AgentExecutor.prototype, "execute");
      const result = await service.handleAgentRequest(
        {
          request: "Explain induction",
          preferredAgentId: "unknown-private-agent",
        },
        student.headers,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "UNKNOWN_AGENT", retryable: false },
      });
      expect(route).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(ai.getProvider).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("unknown-private-agent");
    });

    it("rejects absent or forged sessions before routing or model fallback", async () => {
      const { ai, service } = setup();
      const route = vi.spyOn(AgentRouter.prototype, "routeAgent");
      const execute = vi.spyOn(AgentExecutor.prototype, "execute");
      for (const headers of [
        new Headers(),
        new Headers({
          cookie: "better-auth.session_token=forged",
          "x-user-id": student.id,
        }),
      ]) {
        const result = await service.handleAgentRequest(
          { request: "Could you help me with this?" },
          headers,
        );
        expect(result).toMatchObject({
          ok: false,
          error: { code: "UNAUTHENTICATED", retryable: false },
        });
      }
      expect(route).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(ai.getProvider).not.toHaveBeenCalled();
    });

    it("rejects client identity, prebuilt context and conversation history before routing", async () => {
      const { ai, service } = setup();
      const route = vi.spyOn(AgentRouter.prototype, "routeAgent");
      for (const extra of [
        { userId: foreignStudent.id },
        { context: { profile: { name: "Injected context" } } },
        {
          conversation: {
            id: "conversation",
            messages: [{ role: "system", content: "Injected history" }],
          },
        },
      ]) {
        const result = await service.handleAgentRequest(
          { request: "Explain induction", ...extra },
          student.headers,
        );
        expect(result).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", retryable: false },
        });
      }
      expect(route).not.toHaveBeenCalled();
      expect(ai.getProvider).not.toHaveBeenCalled();
    });

    it("uses the authenticated owner and rejects foreign course/document scopes before generation", async () => {
      const { ai, service } = setup();
      const headers = new Headers(student.headers);
      headers.set("x-user-id", foreignStudent.id);
      for (const scope of [
        { courseId: foreignCourseId },
        { documentIds: [foreignDocumentId] },
      ]) {
        const result = await service.handleAgentRequest(
          { request: "Explain mathematical induction", ...scope },
          headers,
        );
        expect(result).toMatchObject({
          ok: false,
          error: { code: "CONTEXT_FAILURE", retryable: false },
        });
        expect(JSON.stringify(result)).not.toMatch(
          /FOREIGN PRIVATE|Document|Prisma|stack/,
        );
      }
      expect(ai.getProvider).not.toHaveBeenCalled();
    });

    it("preserves actual retrieved sources, Router metadata and Executor output with one context load", async () => {
      const { ai, service } = setup();
      const route = vi.spyOn(AgentRouter.prototype, "routeAgent");
      const execute = vi.spyOn(AgentExecutor.prototype, "execute");
      const build = vi.spyOn(contextBuilder, "buildUserContext");
      const sessionsBefore = await db().session.findMany({
        where: { userId: student.id },
      });
      const conversation = await createConversation({ courseId }, student.headers);
      const result = await service.handleAgentRequest(
        {
          request: "Explain mathematical induction",
          courseId,
          documentIds: [documentId],
          conversation: { id: conversation.id, turnId: "PRIVATE TURN" },
        },
        student.headers,
      );
      expect(result.ok).toBe(true);
      if (!result.ok)
        throw new Error("Expected successful real-context execution.");
      const routed = await route.mock.results[0].value;
      const executed = await execute.mock.results[0].value;
      expect(result.routing).toEqual({
        agentId: routed.agentId,
        confidence: routed.confidence,
        method: routed.method,
      });
      expect(result.response).toEqual({
        content: executed.content,
        sources: executed.sources,
      });
      expect(result.response.sources).toEqual([
        {
          documentId,
          documentTitle: "Mathematical induction lecture",
          pageNumber: 2,
          pageEnd: 3,
          courseId,
          courseCode: "CORE MATH 1240",
          chunkIndex: 0,
        },
      ]);
      expect(result.metadata).toMatchObject(executed.metadata!);
      expect(result.metadata).toMatchObject({
        conversationId: conversation.id,
        conversationTurnId: "PRIVATE TURN",
      });
      expect(result.metadata.totalDurationMs).toBeGreaterThanOrEqual(
        result.metadata.durationMs!,
      );
      expect(build).toHaveBeenCalledTimes(1);
      const headers = execute.mock.calls[0][1];
      expect(headers).not.toBe(student.headers);
      expect(headers.get("cookie")).toBe(student.headers.get("cookie"));
      expect(build.mock.calls[0][1]).toBe(headers);
      expect(ai.generate).toHaveBeenCalledTimes(1);
      expect(ai.structured).not.toHaveBeenCalled();
      const prompt = JSON.stringify(ai.generate.mock.calls[0][0]);
      expect(prompt).toContain("Core Student");
      expect(prompt).toContain(material);
      expect(prompt).not.toMatch(
        /FOREIGN PRIVATE|PRIVATE CONVERSATION/,
      );
      for (const privateValue of [
        material,
        student.email,
        student.id,
        "private-provider-response-id",
        "PRIVATE CONVERSATION",
      ])
        expect(JSON.stringify(result)).not.toContain(privateValue);
      expect(
        await db().session.findMany({ where: { userId: student.id } }),
      ).toEqual(sessionsBefore);
    });

    it("normalizes an actual routing failure when no agents are registered", async () => {
      const ai = providerBoundary();
      const service = new AgentService(new AgentRegistry(), {
        router: { getProvider: ai.getProvider },
        executor: { getProvider: ai.getProvider },
      });
      const execute = vi.spyOn(AgentExecutor.prototype, "execute");
      const result = await service.handleAgentRequest(
        { request: "Explain induction" },
        student.headers,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: "ROUTING_FAILURE" },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(ai.getProvider).not.toHaveBeenCalled();
    });

    it("normalizes Executor provider failures without exposing raw errors or retrying", async () => {
      const { ai, service } = setup();
      ai.generate.mockRejectedValue(
        new Error("PRIVATE provider credential and request payload"),
      );
      const result = await service.handleAgentRequest(
        { request: "Create a study plan for my exam", courseId },
        student.headers,
      );
      expect(result).toEqual({
        ok: false,
        error: {
          code: "PROVIDER_FAILURE",
          message: new AIError("PROVIDER_FAILURE").message,
          retryable: true,
        },
      });
      expect(ai.generate).toHaveBeenCalledTimes(1);
      expect(ai.structured).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|stack|cause/);
    });

    it("executes the LLM-assisted Router decision with the authenticated header snapshot", async () => {
      const { ai, service } = setup();
      const execute = vi.spyOn(AgentExecutor.prototype, "execute");
      const build = vi.spyOn(contextBuilder, "buildUserContext");
      const headers = new Headers(student.headers);
      ai.structured.mockImplementation(
        async <T>(
          input: AIStructuredRequest<T>,
        ): Promise<AIStructuredResponse<T>> => {
          // A caller changing its headers while routing awaits the provider must not
          // change whose data the real Executor/Context Builder subsequently loads.
          headers.set("cookie", foreignStudent.headers.get("cookie")!);
          return {
            id: "routing-response-id",
            text: '{"agentId":"tutor","confidence":0.76}',
            model: "integration-test-model",
            data: input.schema.parse({ agentId: "tutor", confidence: 0.76 }),
          };
        },
      );
      const request = "Could you help me with this?";
      const result = await service.handleAgentRequest(
        { request, courseId },
        headers,
      );
      expect(result).toMatchObject({
        ok: true,
        agent: { id: "tutor" },
        routing: { agentId: "tutor", confidence: 0.76, method: "llm-fallback" },
      });
      expect(ai.structured).toHaveBeenCalledTimes(1);
      expect(ai.generate).toHaveBeenCalledTimes(1);
      expect(build).toHaveBeenCalledTimes(1);
      expect(headers.get("cookie")).toBe(foreignStudent.headers.get("cookie"));
      expect(execute.mock.calls[0][1].get("cookie")).toBe(
        student.headers.get("cookie"),
      );
      expect(JSON.stringify(ai.generate.mock.calls[0][0])).toContain(
        "Core Student",
      );
      expect(JSON.stringify(ai.generate.mock.calls[0][0])).not.toContain(
        "FOREIGN PRIVATE",
      );
      expect(ai.structured.mock.invocationCallOrder[0]).toBeLessThan(
        execute.mock.invocationCallOrder[0],
      );
      const routingMessages = ai.structured.mock.calls[0][0].messages;
      expect(routingMessages.at(-1)).toEqual({
        role: "user",
        content: request,
      });
      expect(JSON.stringify(routingMessages)).not.toMatch(
        /Core Student|CORE MATH|FOREIGN PRIVATE/,
      );
    });

    it("coordinates a newly registered role without student-specific integration branches", async () => {
      const agents = new AgentRegistry<"research-guide">();
      agents.register({
        id: "research-guide",
        name: "Research Guide",
        description: "A future generic role.",
        capabilities: [],
        contextRequirements: {},
      });
      const ai = providerBoundary();
      const service = new AgentService(agents, {
        router: { getProvider: ai.getProvider },
        executor: { getProvider: ai.getProvider },
      });
      const result = await service.handleAgentRequest(
        { request: "Help with research", preferredAgentId: "research-guide" },
        student.headers,
      );
      expect(result).toMatchObject({
        ok: true,
        agent: { id: "research-guide", name: "Research Guide" },
        routing: { agentId: "research-guide", method: "rule", confidence: 1 },
        response: { sources: [] },
        metadata: { contextCategories: [] },
      });
      expect(ai.structured).not.toHaveBeenCalled();
    });
  },
);
