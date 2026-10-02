import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import type { AIProvider, AIStructuredRequest, AIStructuredResponse } from "@/server/ai/types";
import { buildUserContext } from "@/server/context";
import { getAcademicManagerAgentDefinition } from "@/server/agents/academic-manager/definition";
import { getCareerAgentDefinition } from "@/server/agents/career/definition";
import { getNotesAgentDefinition } from "@/server/agents/notes/definition";
import { getQuizAgentDefinition } from "@/server/agents/quiz/definition";
import { getStudyPlannerAgentDefinition } from "@/server/agents/study-planner/definition";
import { getTutorAgentDefinition } from "@/server/agents/tutor/definition";
import { createQuizAgentService } from "@/server/agents/quiz";
import {
  MemoryError,
  MemoryService,
  observeStudyTaskOutcome,
  observeWorkflowOutcome,
  recordMemoryObservation,
  retrieveRelevantMemories,
  saveExplicitMemory,
} from "@/server/memory";
import * as retrieval from "@/server/documents/retrieval";

type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor;
let other: Actor;

async function actor(label: string): Promise<Actor> {
  const email = `memory-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: { name: label, email, password: "Memory-test-passphrase-2026!" },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  const result = {
    id: body.user.id,
    email,
    headers: new Headers({
      cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "),
    }),
  };
  actors.push(result);
  await db().profile.create({
    data: {
      userId: result.id,
      school: "Memory Test University",
      program: "Computer Science",
      currentYear: 2,
      semester: "Fall 2026",
      academicGoal: "Improve understanding",
      studySessionMinutes: 45,
      explanationDifficulty: "INTERMEDIATE",
      timezone: "UTC",
    },
  });
  return result;
}

beforeAll(async () => {
  owner = await actor("Memory Owner");
  other = await actor("Other Memory Owner");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db().userMemory.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
});

afterAll(async () => {
  for (const item of actors) await db().user.deleteMany({ where: { id: item.id, email: item.email } });
  await db().$disconnect();
});

describe.sequential("Memory Architecture and Personalization Core", () => {
  it("creates typed explicit memory and deduplicates newer explicit values", async () => {
    const first = await saveExplicitMemory({
      category: "preference", key: "preferredQuizDifficulty", value: "hard", importance: 82,
    }, owner.headers);
    const newer = await saveExplicitMemory({
      category: "preference", key: "quiz difficulty", value: "easy", importance: 84,
    }, owner.headers);
    expect(newer).toMatchObject({
      id: first.id, category: "preference", key: "quizDifficulty", value: "easy",
      sourceType: "explicit", confidence: 95, importance: 84, status: "active",
    });
    expect(await db().userMemory.count({ where: { userId: owner.id } })).toBe(1);
    expect(await db().memoryObservation.count({ where: { memoryId: first.id } })).toBe(2);
  });

  it("keeps inferred memory as a candidate until repeated independent evidence promotes it", async () => {
    const observe = (index: number) => recordMemoryObservation({
      userId: owner.id,
      category: "preference",
      key: "quizDifficulty",
      observedValue: "hard",
      source: "Repeated quiz difficulty selections",
      evidenceKey: `quiz-session:${index}`,
      evidenceType: "behavior",
    });
    const first = await observe(1);
    expect(first).toMatchObject({ status: "candidate", sourceType: "inferred" });
    const duplicate = await observe(1);
    expect(duplicate.confidence).toBe(first.confidence);
    expect((await observe(2)).status).toBe("candidate");
    const promoted = await observe(3);
    expect(promoted.status).toBe("active");
    expect(promoted.confidence).toBeGreaterThan(first.confidence);
    expect(promoted.confidence).toBeLessThan(95);
  });

  it("reduces inferred confidence on conflicting evidence and lets explicit correction win", async () => {
    for (let index = 1; index <= 3; index++) await recordMemoryObservation({
      userId: owner.id, category: "preference", key: "quizDifficulty", observedValue: "hard",
      source: "Quiz selection", evidenceKey: `hard:${index}`, evidenceType: "behavior",
    });
    const before = (await retrieveRelevantMemories({ userId: owner.id, request: "quiz difficulty", categories: ["preference"], keys: ["quizDifficulty"] }))[0];
    for (let index = 1; index <= 2; index++) await recordMemoryObservation({
      userId: owner.id, category: "preference", key: "quizDifficulty", observedValue: "easy",
      source: "Quiz selection", evidenceKey: `easy:${index}`, evidenceType: "behavior",
    });
    const conflicted = (await retrieveRelevantMemories({ userId: owner.id, request: "quiz difficulty", categories: ["preference"], keys: ["quizDifficulty"] }))[0];
    expect(conflicted.value).toBe("hard");
    expect(conflicted.confidence).toBeLessThan(before.confidence);
    const corrected = await saveExplicitMemory({ category: "preference", key: "quizDifficulty", value: "easy" }, owner.headers);
    expect(corrected).toMatchObject({ value: "easy", sourceType: "explicit", confidence: 95, status: "active" });
    const laterInference = await recordMemoryObservation({
      userId: owner.id, category: "preference", key: "quizDifficulty", observedValue: "hard",
      source: "Later quiz selection", evidenceKey: "hard:later", evidenceType: "behavior",
    });
    expect(laterInference).toMatchObject({ value: "easy", sourceType: "explicit", confidence: 95 });
  });

  it("supports structured goals, importance, hybrid ranking, and staleness deprioritization", async () => {
    const companies = await saveExplicitMemory({
      category: "career-goal", key: "targetCompanies", value: ["OpenAI", "Shopify"], importance: 90,
    }, owner.headers);
    const stale = await saveExplicitMemory({
      category: "career-goal", key: "targetRole", value: "Software engineer", importance: 80,
    }, owner.headers);
    const fresh = await saveExplicitMemory({
      category: "career-goal", key: "targetIndustry", value: "Education technology", importance: 80,
    }, owner.headers);
    await db().userMemory.update({ where: { id: stale.id }, data: { lastObservedAt: new Date("2024-01-01T00:00:00.000Z") } });
    const rows = await retrieveRelevantMemories({
      userId: owner.id, request: "Help with my education technology career goals",
      categories: ["career-goal"], limit: 3, now: new Date("2026-09-14T00:00:00.000Z"),
    });
    expect(rows.find((row) => row.id === companies.id)?.value).toEqual(["OpenAI", "Shopify"]);
    expect(rows.find((row) => row.id === stale.id)?.stale).toBe(true);
    expect(rows.findIndex((row) => row.id === fresh.id)).toBeLessThan(rows.findIndex((row) => row.id === stale.id));
  });

  it("reuses the AI embedding boundary for semantic free-text memory retrieval", async () => {
    const generateEmbedding = vi.fn(async ({ input }: { input: string }) => {
      const recursive = /diagrammatic|recursive|visual|nested/i.test(input);
      return { model: "memory-test-embedding", vector: Array.from({ length: 384 }, (_, index) => index === (recursive ? 0 : 1) ? 1 : 0) };
    });
    const embeddingProvider = { generateEmbedding };
    const visual = await saveExplicitMemory({
      category: "learning-pattern", key: "recursive-diagrams",
      value: "Diagrammatic decomposition supports recursive reasoning",
    }, owner.headers, { embeddingProvider });
    await saveExplicitMemory({
      category: "learning-pattern", key: "proof-templates",
      value: "Algebraic proof templates support formal derivations",
    }, owner.headers, { embeddingProvider });
    const result = await retrieveRelevantMemories({
      userId: owner.id, request: "Use a visual tree for nested calls",
      categories: ["learning-pattern"], semantic: true, limit: 2,
    }, { embeddingProvider });
    expect(result[0].id).toBe(visual.id);
    expect(generateEmbedding).toHaveBeenCalledTimes(3);
  });

  it("retrieves bounded, agent-specific memory through Context Builder", async () => {
    await Promise.all([
      saveExplicitMemory({ category: "preference", key: "explanationStyle", value: "concise-with-examples" }, owner.headers),
      saveExplicitMemory({ category: "preference", key: "noteStyle", value: "outline" }, owner.headers),
      saveExplicitMemory({ category: "preference", key: "quizDifficulty", value: "hard" }, owner.headers),
      saveExplicitMemory({ category: "preference", key: "studySessionMinutes", value: 60 }, owner.headers),
      saveExplicitMemory({ category: "academic-goal", key: "academicGoal", value: "Earn an A in algorithms" }, owner.headers),
      saveExplicitMemory({ category: "career-goal", key: "targetRole", value: "Software engineer" }, owner.headers),
      saveExplicitMemory({ category: "learning-pattern", key: "worked-examples", value: "Worked examples help before independent proof practice" }, owner.headers),
      saveExplicitMemory({ category: "successful-strategy", key: "spaced-review", value: "Spaced review improves retention" }, owner.headers),
    ]);
    vi.spyOn(retrieval, "retrieveAcademicContext").mockResolvedValue([]);
    const cases = [
      [getTutorAgentDefinition(), "Explain recursion", ["explanationStyle", "worked-examples", "spaced-review"], ["targetRole", "noteStyle"]],
      [getNotesAgentDefinition(), "Create notes", ["noteStyle"], ["quizDifficulty", "targetRole"]],
      [getQuizAgentDefinition(), "Quiz me", ["quizDifficulty", "worked-examples"], ["targetRole", "noteStyle"]],
      [getStudyPlannerAgentDefinition(), "Plan my week", ["studySessionMinutes", "academicGoal", "spaced-review"], ["targetRole", "noteStyle"]],
      [getAcademicManagerAgentDefinition(), "Review my semester", ["academicGoal", "studySessionMinutes"], ["targetRole", "noteStyle"]],
      [getCareerAgentDefinition(), "Help with my career", ["targetRole"], ["academicGoal", "quizDifficulty"]],
    ] as const;
    for (const [agent, request, included, excluded] of cases) {
      const contextRequirements = { ...agent.contextRequirements };
      delete contextRequirements.selectedDocumentCoverage;
      const context = await buildUserContext({ request, options: contextRequirements }, owner.headers);
      const keys = context.memories?.map((memory) => memory.key) ?? [];
      for (const key of included) expect(keys, `${agent.id} includes ${key}`).toContain(key);
      for (const key of excluded) expect(keys, `${agent.id} excludes ${key}`).not.toContain(key);
      expect(keys.length).toBeLessThanOrEqual(agent.contextRequirements.limits?.memories ?? 5);
      expect(context.memories?.every((memory) => memory.confidence >= 0 && memory.importance >= 0)).toBe(true);
    }
  });

  it("uses saved quiz difficulty only when the current request omits it", async () => {
    await saveExplicitMemory({ category: "preference", key: "quizDifficulty", value: "hard" }, owner.headers);
    vi.spyOn(retrieval, "retrieveAcademicContext").mockResolvedValue([]);
    const directives: string[] = [];
    const provider: AIProvider = {
      generateText: vi.fn(),
      async generateStructuredOutput<T>(request: AIStructuredRequest<T>): Promise<AIStructuredResponse<T>> {
        const marker = "Execution parameters: ";
        const content = request.messages[0].content;
        const directive = JSON.parse(content.slice(content.indexOf(marker) + marker.length)) as { difficulty: "easy" | "medium" | "hard" };
        directives.push(directive.difficulty);
        const data = request.schema.parse({
          quizTitle: "Logic practice", topic: "Logic", difficulty: directive.difficulty,
          questions: [{ type: "multiple-choice", prompt: "Which statement is valid?", choices: ["A", "B", "C", "D"], correctAnswer: "A", explanation: "A is valid.", topics: ["Logic"] }],
        });
        return { id: randomUUID(), model: "memory-test", text: JSON.stringify(data), data };
      },
      streamText() { throw new Error("unused"); },
      generateEmbedding() { throw new Error("unused"); },
    };
    const getProvider = () => provider;
    const service = createQuizAgentService({ router: { getProvider }, executor: { getProvider }, getProvider });
    expect((await service.generateQuiz({ request: "Create me a quiz with 1 multiple-choice question", count: 1, questionType: "multiple-choice" }, owner.headers)).difficulty).toBe("hard");
    expect((await service.generateQuiz({ request: "Create me a quiz with 1 easy multiple-choice question", count: 1, questionType: "multiple-choice" }, owner.headers)).difficulty).toBe("easy");
    expect(directives).toEqual(["hard", "easy"]);
  });

  it("supports list, edit, archive, delete, and cross-user ownership", async () => {
    const service = new MemoryService();
    const saved = await service.saveExplicit({ category: "academic-goal", key: "targetGrade", value: "B+" }, owner.headers);
    await expect(service.update(saved.id, { value: "A" }, other.headers)).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
    await expect(service.archive(saved.id, other.headers)).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
    await expect(service.delete(saved.id, other.headers)).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
    const edited = await service.update(saved.id, { value: "A", importance: 96 }, owner.headers);
    expect(edited).toMatchObject({ value: "A", importance: 96, sourceType: "explicit" });
    expect((await service.list({}, other.headers)).some((memory) => memory.id === saved.id)).toBe(false);
    expect(await service.retrieve({ request: "target grade", categories: ["academic-goal"] }, other.headers)).toEqual([]);
    expect((await service.archive(saved.id, owner.headers)).status).toBe("archived");
    expect(await retrieveRelevantMemories({ userId: owner.id, request: "target grade", categories: ["academic-goal"] })).toEqual([]);
    expect(await service.delete(saved.id, owner.headers)).toEqual({ success: true });
  });

  it("keeps Learning Intelligence separate and promotes workflow strategies only after repeated success", async () => {
    for (let index = 1; index <= 3; index++) await observeWorkflowOutcome({
      userId: owner.id, runId: `recovery-${index}`, workflowId: "weak-topic-recovery", improvement: 12,
    });
    await observeWorkflowOutcome({ userId: owner.id, runId: "no-improvement", workflowId: "weak-topic-recovery", improvement: 2 });
    const memories = await retrieveRelevantMemories({ userId: owner.id, request: "What study strategy works?", categories: ["successful-strategy"] });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ key: "weak-topic-recovery", status: "active", sourceType: "system-derived" });
    for (let index = 1; index <= 3; index++) await observeStudyTaskOutcome({
      userId: owner.id, taskId: `completed-${index}`, durationMinutes: 60, status: "completed",
    });
    const sessionPreference = await retrieveRelevantMemories({
      userId: owner.id, request: "study session length", categories: ["preference"], keys: ["studySessionMinutes"],
    });
    expect(sessionPreference[0]).toMatchObject({ value: 60, status: "active", sourceType: "inferred" });
    expect(await db().learningProgress.count({ where: { userId: owner.id } })).toBe(0);
  });

  it("bounds observations and Context Builder output", async () => {
    for (let index = 0; index < 25; index++) await recordMemoryObservation({
      userId: owner.id, category: "learning-pattern", key: "examples-first",
      observedValue: "Examples before practice", source: "Tutor outcome",
      evidenceKey: `tutor:${index}`, evidenceType: "outcome",
    });
    const memory = await db().userMemory.findFirstOrThrow({ where: { userId: owner.id, key: "examples-first" } });
    expect(await db().memoryObservation.count({ where: { memoryId: memory.id } })).toBe(20);
    await saveExplicitMemory({ category: "learning-pattern", key: "visual-recursion", value: "Visual recursion trees help" }, owner.headers);
    await saveExplicitMemory({ category: "learning-pattern", key: "proof-template", value: "Proof templates help" }, owner.headers);
    const context = await buildUserContext({
      request: "How should I learn?",
      options: { memories: true, memoryCategories: ["learning-pattern"], limits: { memories: 2 } },
    }, owner.headers);
    expect(context.memories).toHaveLength(2);
  });

  it("rejects sensitive, malformed, and unauthenticated memory writes", async () => {
    await expect(saveExplicitMemory({ category: "preference", key: "accessToken", value: "secret" }, owner.headers)).rejects.toBeInstanceOf(MemoryError);
    await expect(saveExplicitMemory({ category: "preference", key: "studySessionMinutes", value: 600 }, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(saveExplicitMemory({ category: "preference", key: "quizDifficulty", value: "hard" }, new Headers())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
