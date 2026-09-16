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
import { AgentExecutor } from "@/server/agents/executor";
import { createStudentAgentService } from "@/server/agents/student-service";
import { getNotesAgentDefinition } from "@/server/agents/notes/definition";
import {
  NOTES_INSTRUCTIONS,
  NOTES_MODES,
} from "@/server/agents/notes/instructions";
import * as contextBuilder from "@/server/context/builder";
import * as categories from "@/server/context/categories";
import * as retrieval from "@/server/documents/retrieval";
import { embeddingProvider } from "@/server/documents/embeddings";

type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor, empty: Actor, courseId: string, documentId: string;
const material =
  "Lecture 4 defines mathematical induction using the Anchor Step P(1) and the Successor Step P(k) implies P(k+1). Preserve the professor's terms Anchor Step and Successor Step.";
const excludedMaterial = material + " UNSELECTED_PRIVATE_PASSAGE";

async function actor(): Promise<Actor> {
  const email = `notes-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: {
      name: "Notes Test Student",
      email,
      password: "Notes-test-passphrase-2026!",
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const data = (await response.json()) as { user: { id: string } };
  const result = {
    id: data.user.id,
    email,
    headers: new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    }),
  };
  actors.push(result);
  return result;
}

async function document(content: string, title: string) {
  const row = await db().document.create({
    data: {
      userId: owner.id,
      courseId,
      title,
      originalFileName: "lecture.txt",
      fileType: "TXT",
      fileSize: content.length,
      storageKey: randomUUID(),
      processingStatus: "READY",
      embeddingModel: embeddingProvider.id,
      pageCount: 5,
    },
  });
  const vector = JSON.stringify(
    await embeddingProvider.generateEmbedding(content),
  );
  await db()
    .$executeRaw`INSERT INTO "DocumentChunk" (id,"documentId","userId","courseId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata) VALUES (${randomUUID()},${row.id},${owner.id},${courseId},0,${content},4,5,60,${vector}::vector,${embeddingProvider.id},'{}'::jsonb)`;
  return row.id;
}

function setup() {
  const generate = vi.fn<AIProvider["generateText"]>().mockResolvedValue({
    id: "model-response",
    text: "Model-produced study notes.",
    model: "notes-test-model",
  });
  const structured = vi.fn(
    async <T>(
      input: AIStructuredRequest<T>,
    ): Promise<AIStructuredResponse<T>> => ({
      id: "routing-response",
      model: "notes-test-model",
      text: "",
      data: input.schema.parse({ agentId: "notes", confidence: 0.8 }),
    }),
  );
  const provider: AIProvider = {
    generateText: generate,
    async generateStructuredOutput<T>(input: AIStructuredRequest<T>) {
      const result = await structured(input);
      return { ...result, data: input.schema.parse(result.data) };
    },
    streamText() {
      throw new Error("No new streaming pipeline.");
    },
    generateEmbedding() {
      throw new Error("Use existing local RAG embeddings.");
    },
  };
  const getProvider = vi.fn(() => provider);
  return {
    generate,
    structured,
    service: createStudentAgentService({
      router: { getProvider },
      executor: { getProvider },
    }),
  };
}

beforeAll(async () => {
  owner = await actor();
  empty = await actor();
  const course = await db().course.create({
    data: {
      userId: owner.id,
      courseCode: "NOTES MATH",
      courseName: "Mathematical Induction",
      semester: "Fall 2026",
    },
  });
  courseId = course.id;
  documentId = await document(material, "Lecture 4.txt");
  await document(excludedMaterial, "Unselected lecture.txt");
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const user of actors) {
    await db().user.deleteMany({ where: { id: user.id, email: user.email } });
    // No actual files were created by these metadata/vector fixtures.
    await db().fileDeletion.deleteMany({ where: { userId: user.id } });
  }
  await db().$disconnect();
});

describe.sequential("Notes Agent through the existing framework", () => {
  it("registers Notes once with course, documents, and note preferences", () => {
    const register = vi.spyOn(AgentRegistry.prototype, "register");
    setup();
    const notes = getNotesAgentDefinition();
    expect(
      register.mock.calls.filter(([agent]) => agent.id === "notes"),
    ).toEqual([[notes]]);
    expect(
      getStudentAgentDefinitions().find((agent) => agent.id === "notes"),
    ).toEqual(notes);
    expect(notes.contextRequirements).toEqual({
      course: true,
      documents: true,
      memories: true,
      memoryCategories: ["preference"],
      memoryKeys: ["noteStyle", "answerLength"],
      limits: { memories: 3 },
    });
    expect(notes.capabilities).toEqual([
      "summarize-documents",
      "create-notes",
      "extract-key-concepts",
      "extract-definitions",
      "create-review-notes",
    ]);
    for (const capability of notes.capabilities)
      expect(AGENT_CAPABILITIES).toContain(capability);
  });

  it.each([
    ["Summarize Lecture 4", "summary"],
    ["Create study notes", "structured-notes"],
    ["Give me the key concepts", "key-concepts"],
    ["List the important definitions from this lecture", "definitions"],
    ["Make exam review notes", "exam-review"],
    ["Make a concise cheat sheet", "exam-review"],
  ] as const)(
    "routes '%s' and supplies its mode guidance through Executor",
    async (request, mode) => {
      const { service, generate, structured } = setup();
      const execute = vi.spyOn(AgentExecutor.prototype, "execute");
      const build = vi.spyOn(contextBuilder, "buildUserContext");
      const result = await service.handleAgentRequest(
        { request, courseId, documentIds: [documentId] },
        owner.headers,
      );
      expect(result).toMatchObject({
        ok: true,
        agent: { id: "notes" },
        routing: { method: "rule" },
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0].agentId).toBe("notes");
      expect(build).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(structured).not.toHaveBeenCalled();
      const messages = generate.mock.calls[0][0].messages;
      expect(messages[0].content).toContain(NOTES_INSTRUCTIONS);
      expect(messages[0].content).toContain(`${mode}: ${NOTES_MODES[mode]}`);
      expect(messages.at(-1)).toEqual({ role: "user", content: request });
      // This verifies mode instructions reach the model, not live output quality.
    },
  );

  it("defaults unspecified formats to structured notes without forcing empty headings", () => {
    expect(Object.keys(NOTES_MODES)).toEqual([
      "summary",
      "structured-notes",
      "key-concepts",
      "definitions",
      "exam-review",
    ]);
    expect(NOTES_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
    expect(NOTES_INSTRUCTIONS).toContain("structured-notes as the fallback");
    expect(NOTES_MODES["structured-notes"]).toContain(
      "omit irrelevant/empty sections",
    );
  });

  it("uses only selected document passages and preserves actual source/page metadata", async () => {
    const { service, generate } = setup();
    const retrieve = vi.spyOn(retrieval, "retrieveAcademicContext");
    const query =
      "Make notes on mathematical induction: Anchor Step P(1) and Successor Step P(k) implies P(k+1).";
    const result = await service.handleAgentRequest(
      { request: query, courseId, documentIds: [documentId] },
      owner.headers,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected Notes execution success.");
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith(owner.id, {
      query,
      courseId,
      documentIds: [documentId],
      maxResults: 5,
    });
    expect(result.response.sources).toEqual([
      {
        documentId,
        documentTitle: "Lecture 4.txt",
        pageNumber: 4,
        pageEnd: 5,
        courseId,
        courseCode: "NOTES MATH",
        chunkIndex: 0,
      },
    ]);
    const prompt = JSON.stringify(generate.mock.calls[0][0].messages);
    expect(prompt.split(material)).toHaveLength(2);
    expect(prompt).not.toMatch(/UNSELECTED_PRIVATE_PASSAGE|Unselected lecture/);
    expect(NOTES_INSTRUCTIONS).toMatch(
      /Preserve course terminology, notation, formulas, definitions/,
    );
    expect(NOTES_INSTRUCTIONS).toContain("never imply complete coverage");
    expect(JSON.stringify(result.response.sources)).not.toContain(material);
  });

  it("handles absent lecture material with an honest missing-source instruction and empty sources", async () => {
    const { service, generate } = setup();
    const build = vi.spyOn(contextBuilder, "buildUserContext");
    const result = await service.handleAgentRequest(
      { request: "Summarize my lecture" },
      empty.headers,
    );
    expect(result).toMatchObject({ ok: true, response: { sources: [] } });
    const context = await build.mock.results[0].value;
    expect(context.documents).toEqual([]);
    const prompt = generate.mock.calls[0][0].messages;
    expect(prompt[0].content).toContain(
      "state that material is unavailable and ask for it; do not fabricate notes",
    );
    expect(JSON.stringify(prompt)).not.toContain(material);
    // Model responses are mocked; this checks the grounding contract, not model compliance.
  });

  it("allows labeled general-topic notes without a selected course or materials", async () => {
    const { service, generate } = setup();
    const result = await service.handleAgentRequest(
      { request: "Give me notes about recursion", preferredAgentId: "notes" },
      empty.headers,
    );
    expect(result).toMatchObject({
      ok: true,
      agent: { id: "notes" },
      response: { sources: [] },
    });
    expect(generate.mock.calls[0][0].messages[0].content).toContain(
      "general-knowledge notes are allowed, clearly labeled",
    );
  });

  it("loads note preferences while excluding unrelated academic context", async () => {
    const { service } = setup();
    const unused = [
      vi.spyOn(categories, "profileContext"),
      vi.spyOn(categories, "assignmentContext"),
      vi.spyOn(categories, "examContext"),
    ];
    const memories = vi.spyOn(categories, "memoryContext");
    const build = vi.spyOn(contextBuilder, "buildUserContext");
    const result = await service.handleAgentRequest(
      { request: "Make notes", courseId },
      owner.headers,
    );
    expect(result.ok).toBe(true);
    for (const spy of unused) expect(spy).not.toHaveBeenCalled();
    expect(memories).toHaveBeenCalledTimes(1);
    const context = await build.mock.results[0].value;
    expect(context.metadata.requestedCategories).toEqual([
      "course",
      "documents",
      "memories",
    ]);
    expect(context.learning).toBeUndefined();
  });
});
