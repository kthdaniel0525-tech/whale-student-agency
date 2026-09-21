import { evaluateDeterministic } from "@/server/ai/evaluation/deterministic";
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
import type {
  AIProvider,
  AIStructuredRequest,
  AIStructuredResponse,
} from "@/server/ai/types";
import {
  AGENT_CAPABILITIES,
  AgentRegistry,
  getStudentAgentDefinitions,
} from "@/server/agents";
import { AgentService } from "@/server/agents/core";
import { AgentExecutor } from "@/server/agents/executor";
import { AgentRouter } from "@/server/agents/router";
import { createStudentAgentService } from "@/server/agents/student-service";
import { createConversation } from "@/server/conversations";
import { getTutorAgentDefinition } from "@/server/agents/tutor/definition";
import { TUTOR_INSTRUCTIONS } from "@/server/agents/tutor/instructions";
import * as contextBuilder from "@/server/context/builder";
import * as categories from "@/server/context/categories";
import { embeddingProvider } from "@/server/documents/embeddings";
import * as retrieval from "@/server/documents/retrieval";

type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let beginner: Actor;
let advanced: Actor;
let courseId: string;
let documentId: string;

const material =
  "Mathematical induction proves a proposition by establishing a base case. The inductive hypothesis assumes the proposition holds for an arbitrary k. The inductive step then proves it for k plus one.";
const requirements = {
  profile: true,
  course: true,
  documents: true,
  learning: true,
  memories: true,
  memoryCategories: ["preference", "learning-pattern", "successful-strategy"],
  memoryKeys: ["explanationStyle", "answerLength"],
  limits: { memories: 5 },
};

async function createActor(
  name: string,
  difficulty: "BEGINNER" | "ADVANCED",
): Promise<Actor> {
  const email = `tutor-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: { name, email, password: "Tutor-test-passphrase-2026!" },
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
      school: "Tutor Test University",
      program: "Mathematics",
      currentYear: difficulty === "BEGINNER" ? 1 : 4,
      semester: "Fall 2026",
      academicGoal: "Understand mathematical reasoning",
      studySessionMinutes: 45,
      explanationDifficulty: difficulty,
    },
  });
  return actor;
}

/** Generation is the sole replacement; auth, routing, execution, DB and RAG run. */
function providerBoundary() {
  const generate = vi.fn<AIProvider["generateText"]>().mockResolvedValue({
    id: "tutor-provider-response",
    text: "Tutor response supplied by the external model boundary.",
    model: "tutor-test-model",
  });
  const structured = vi.fn(
    async <T>(
      request: AIStructuredRequest<T>,
    ): Promise<AIStructuredResponse<T>> => ({
      id: "tutor-routing-response",
      text: '{"agentId":"tutor","confidence":0.8}',
      model: "tutor-test-model",
      data: request.schema.parse({ agentId: "tutor", confidence: 0.8 }),
    }),
  );
  const provider: AIProvider = {
    generateText: generate,
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      const response = await structured(request);
      return { ...response, data: request.schema.parse(response.data) };
    },
    streamText() {
      throw new Error("Tutor must use the existing text Executor.");
    },
    generateEmbedding() {
      throw new Error(
        "Tutor must use the existing local RAG embedding provider.",
      );
    },
  };
  const getProvider = vi.fn(() => provider);
  return { generate, structured, getProvider };
}

function setup(instructions?: string) {
  const ai = providerBoundary();
  const service = createStudentAgentService({
    router: { getProvider: ai.getProvider },
    executor: {
      getProvider: ai.getProvider,
      conversationEmbeddingProvider: null,
      ...(instructions ? { instructions: { tutor: instructions } } : {}),
    },
  });
  return { ai, service };
}

function messages(ai: ReturnType<typeof providerBoundary>) {
  expect(ai.generate).toHaveBeenCalledTimes(1);
  return ai.generate.mock.calls[0][0].messages;
}

beforeAll(async () => {
  beginner = await createActor("Beginning Tutor Student", "BEGINNER");
  advanced = await createActor("Advanced Tutor Student", "ADVANCED");
  const course = await db().course.create({
    data: {
      userId: beginner.id,
      courseCode: "TUTOR MATH 1240",
      courseName: "Proofs and Induction",
      semester: "Fall 2026",
      professor: "Tutor Test Professor",
      description: "An introduction to mathematical induction",
    },
  });
  courseId = course.id;
  const document = await db().document.create({
    data: {
      userId: beginner.id,
      courseId,
      title: "Induction lecture.txt",
      originalFileName: "induction.txt",
      fileType: "TXT",
      fileSize: material.length,
      storageKey: randomUUID(),
      processingStatus: "READY",
      embeddingModel: embeddingProvider.id,
      pageCount: 3,
    },
  });
  documentId = document.id;
  const vector = JSON.stringify(
    await embeddingProvider.generateEmbedding(material),
  );
  await db()
    .$executeRaw`INSERT INTO "DocumentChunk" (id,"documentId","userId","courseId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata) VALUES (${randomUUID()},${documentId},${beginner.id},${courseId},0,${material},2,3,50,${vector}::vector,${embeddingProvider.id},'{}'::jsonb)`;
}, 30000);

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  for (const actor of actors) {
    await db().user.deleteMany({ where: { id: actor.id, email: actor.email } });
    // These fixtures create metadata/vectors only; no uploaded files exist.
    await db().fileDeletion.deleteMany({ where: { userId: actor.id } });
  }
  await db().$disconnect();
});

describe.sequential("Tutor through the existing student Agent service", () => {
  it("registers the Tutor definition once in the existing registry setup", () => {
    const register = vi.spyOn(AgentRegistry.prototype, "register");
    const { service, ai } = setup();
    expect(service).toBeInstanceOf(AgentService);
    const tutorRegistrations = register.mock.calls.filter(
      ([agent]) => agent.id === "tutor",
    );
    expect(tutorRegistrations).toEqual([[getTutorAgentDefinition()]]);
    expect(
      register.mock.contexts.every(
        (registry) => registry === register.mock.contexts[0],
      ),
    ).toBe(true);
    expect(
      getStudentAgentDefinitions().filter((agent) => agent.id === "tutor"),
    ).toEqual([getTutorAgentDefinition()]);
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("uses the shared capability catalog for all Tutor capabilities", () => {
    const tutor = getTutorAgentDefinition();
    expect(tutor.capabilities).toEqual([
      "explain-concepts",
      "answer-course-questions",
      "provide-examples",
      "clarify-mistakes",
      "use-course-materials",
    ]);
    const registry = new AgentRegistry();
    registry.register(tutor);
    for (const capability of tutor.capabilities) {
      expect(AGENT_CAPABILITIES).toContain(capability);
      expect(registry.getByCapability(capability)).toEqual([tutor]);
    }
  });

  it("declares profile, selected course, documents, learning, and relevant memory context", () => {
    expect(getTutorAgentDefinition().contextRequirements).toEqual(requirements);
  });

  it("routes a general question without course selection through the existing Executor once", async () => {
    const { ai, service } = setup();
    const route = vi.spyOn(AgentRouter.prototype, "routeAgent");
    const execute = vi.spyOn(AgentExecutor.prototype, "execute");
    const build = vi.spyOn(contextBuilder, "buildUserContext");
    const request = "Explain mathematical induction";
    const result = await service.handleAgentRequest(
      { request },
      advanced.headers,
    );
    expect(result).toMatchObject({
      ok: true,
      agent: { id: "tutor", name: "Tutor" },
      routing: { agentId: "tutor", method: "rule" },
      response: {
        content: "Tutor response supplied by the external model boundary.",
        sources: [],
      },
    });
    expect(route).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0][0]).toEqual({ request, options: requirements });
    const prompt = messages(ai);
    expect(prompt[0]).toMatchObject({ role: "system" });
    expect(prompt[0].content).toContain(TUTOR_INSTRUCTIONS);
    expect(prompt.at(-1)).toEqual({ role: "user", content: request });
    expect(ai.structured).not.toHaveBeenCalled();
    expect(ai.getProvider).toHaveBeenCalledTimes(1);
  });

  it("passes actual course retrieval once and preserves the existing source metadata", async () => {
    const { ai, service } = setup();
    const retrieve = vi.spyOn(retrieval, "retrieveAcademicContext");
    const build = vi.spyOn(contextBuilder, "buildUserContext");
    const request = "Explain mathematical induction using my lecture notes";
    const result = await service.handleAgentRequest(
      { request, courseId, documentIds: [documentId] },
      beginner.headers,
    );
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error("Expected successful Tutor course execution.");
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith(beginner.id, {
      query: request,
      courseId,
      documentIds: [documentId],
      maxResults: 5,
    });
    const retrieved = await retrieve.mock.results[0].value;
    expect(retrieved).toHaveLength(1);
    expect(evaluateDeterministic({ profile: "rag-retrieval", request, output: { chunkIds: retrieved.map((c: { documentId: string; chunkIndex: number }) => `${c.documentId}:${c.chunkIndex}`) }, expected: { relevantChunkIds: [`${documentId}:0`], k: 5 } }).metrics).toMatchObject({ recallAtK: 1, hitAtK: 1 });
    expect(build).toHaveBeenCalledTimes(1);
    expect(result.response.sources).toEqual([
      {
        documentId,
        documentTitle: "Induction lecture.txt",
        pageNumber: 2,
        pageEnd: 3,
        courseId,
        courseCode: "TUTOR MATH 1240",
        chunkIndex: 0,
      },
    ]);
    expect(result.response.sources[0]).toMatchObject({
      documentId: retrieved[0].documentId,
      pageNumber: retrieved[0].pageNumber,
      pageEnd: retrieved[0].pageEnd,
    });
    const prompt = JSON.stringify(messages(ai));
    expect(prompt).toContain("Proofs and Induction");
    expect(prompt.split(material)).toHaveLength(2);
    expect(prompt).toContain("Induction lecture.txt");
    // "Explain" and "notes" use the Router's existing ambiguity fallback.
    expect(result.routing).toMatchObject({
      agentId: "tutor",
      method: "llm-fallback",
    });
    expect(ai.structured).toHaveBeenCalledTimes(1);
    expect(ai.getProvider).toHaveBeenCalledTimes(2);
  });

  it("passes the real beginner profile with instructions for accessible explanations", async () => {
    const { ai, service } = setup();
    const result = await service.handleAgentRequest(
      { request: "Explain mathematical induction", courseId },
      beginner.headers,
    );
    expect(result.ok).toBe(true);
    const prompt = messages(ai);
    expect(prompt[0].content).toContain('"responseDepth":"foundational"');
    expect(prompt.map((message) => message.content).join("\n")).not.toContain(
      '"explanationDifficulty":"BEGINNER"',
    );
    expect(prompt[0].content).toContain("Apply the supplied PERSONALIZATION");
    expect(prompt[0].content).toContain('"explanationApproach":"intuitive"');
  });

  it("passes the real advanced preference with concise rigorous explanation guidance", async () => {
    const { ai, service } = setup();
    const result = await service.handleAgentRequest(
      { request: "Explain mathematical induction" },
      advanced.headers,
    );
    expect(result.ok).toBe(true);
    const prompt = messages(ai);
    expect(prompt[0].content).toContain('"responseDepth":"advanced"');
    expect(prompt.map((message) => message.content).join("\n")).not.toContain(
      '"explanationDifficulty":"ADVANCED"',
    );
    expect(prompt[0].content).toContain("Apply the supplied PERSONALIZATION");
    expect(prompt[0].content).toMatch(/rigor/i);
  });

  it("instructs honest missing-source handling when the student has no documents", async () => {
    const { ai, service } = setup();
    const build = vi.spyOn(contextBuilder, "buildUserContext");
    const result = await service.handleAgentRequest(
      {
        request: "Explain this using my lecture notes",
        preferredAgentId: "tutor",
      },
      advanced.headers,
    );
    expect(result).toMatchObject({ ok: true, response: { sources: [] } });
    const context = await build.mock.results[0].value;
    expect(context.documents).toEqual([]);
    expect(context.course).toBeUndefined();
    const prompt = messages(ai);
    expect(prompt[0].content).toMatch(/unavailable|missing/i);
    expect(prompt[0].content).toMatch(/do not invent sources/i);
    expect(JSON.stringify(prompt)).not.toContain("Induction lecture.txt");
    // The assertion is the configured prompt contract, not model compliance:
    // mocked response prose cannot demonstrate a live model's honesty.
  });

  it("asks for clarification for a vague example request without assuming conversation history", async () => {
    const { ai, service } = setup();
    const request = "Give me an example";
    const conversation = await createConversation({}, advanced.headers);
    const result = await service.handleAgentRequest(
      {
        request,
        preferredAgentId: "tutor",
        conversation: { id: conversation.id },
      },
      advanced.headers,
    );
    expect(result).toMatchObject({ ok: true, agent: { id: "tutor" } });
    const prompt = messages(ai);
    expect(prompt[0].content).toContain(
      "ask for the concept or attempted answer if missing",
    );
    expect(prompt.at(-1)).toEqual({ role: "user", content: request });
    expect(JSON.stringify(prompt)).not.toContain(conversation.id);
    expect(ai.structured).not.toHaveBeenCalled();
  });

  it("loads Tutor memory while excluding assignment and exam categories", async () => {
    const { ai, service } = setup();
    const assignments = vi.spyOn(categories, "assignmentContext");
    const exams = vi.spyOn(categories, "examContext");
    const memories = vi.spyOn(categories, "memoryContext");
    const assignmentQuery = vi.spyOn(db().assignment, "findMany");
    const examQuery = vi.spyOn(db().exam, "findMany");
    const memoryQuery = vi.spyOn(db().userMemory, "findMany");
    const build = vi.spyOn(contextBuilder, "buildUserContext");
    const result = await service.handleAgentRequest(
      { request: "Explain mathematical induction", courseId },
      beginner.headers,
    );
    expect(result.ok).toBe(true);
    for (const spy of [assignments, exams, assignmentQuery, examQuery]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(memories).toHaveBeenCalledTimes(1);
    expect(memoryQuery).toHaveBeenCalledTimes(1);
    const context = await build.mock.results[0].value;
    expect(context.metadata.requestedCategories).toEqual([
      "profile",
      "course",
      "documents",
      "memories",
      "learning",
    ]);
    expect(context.metadata.unavailableCategories).toContain("learning");
    expect(context.learning).toBeUndefined();
    const prompt = JSON.stringify(messages(ai));
    expect(prompt).not.toMatch(/UPCOMING EXAMS|ASSIGNMENTS|PREFERENCES/);
  });

  it("keeps Tutor instructions within the existing Executor budget and includes learning and grounding guidance", () => {
    expect(TUTOR_INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(TUTOR_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
    expect(TUTOR_INSTRUCTIONS).toMatch(/general/i);
    expect(TUTOR_INSTRUCTIONS).toMatch(/course/i);
    expect(TUTOR_INSTRUCTIONS).toMatch(/reason|understand/i);
    expect(TUTOR_INSTRUCTIONS).toMatch(/step/i);
    expect(TUTOR_INSTRUCTIONS).toMatch(/example/i);
  });

  it("keeps the existing server-side Executor instruction override available", async () => {
    const override = "Use compact worked examples in this Tutor deployment.";
    const { ai, service } = setup(override);
    const result = await service.handleAgentRequest(
      { request: "Explain mathematical induction" },
      advanced.headers,
    );
    expect(result).toMatchObject({ ok: true, agent: { id: "tutor" } });
    const prompt = messages(ai);
    expect(prompt[0].content).toContain(override);
    expect(prompt[0].content).not.toContain(TUTOR_INSTRUCTIONS);
    expect(ai.structured).not.toHaveBeenCalled();
    expect(ai.getProvider).toHaveBeenCalledTimes(1);
  });
});
