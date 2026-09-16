import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import type { AIProvider, AIStructuredRequest, AIStructuredResponse } from "@/server/ai/types";
import { AGENT_CAPABILITIES, AgentRegistry, getStudentAgentDefinitions } from "@/server/agents";
import { AgentExecutor } from "@/server/agents/executor";
import { AgentRouter } from "@/server/agents/router";
import { getQuizAgentDefinition } from "@/server/agents/quiz/definition";
import { QUIZ_INSTRUCTIONS } from "@/server/agents/quiz/instructions";
import {
  QuizAgentError,
  createQuizAgentService,
  type GeneratedQuizData,
  type QuizDifficulty,
  type QuizQuestionKind,
} from "@/server/agents/quiz";
import * as contextBuilder from "@/server/context/builder";
import * as categories from "@/server/context/categories";
import * as retrieval from "@/server/documents/retrieval";
import { embeddingProvider } from "@/server/documents/embeddings";

type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor;
let other: Actor;
let empty: Actor;
let courseId: string;
let otherCourseId: string;
let documentId: string;
let otherDocumentId: string;
const material =
  "Lecture 5 teaches induction with a Base Step and an Inductive Step. The Inductive Hypothesis assumes P(k), then proves P(k+1).";

async function createActor(label: string): Promise<Actor> {
  const email = `quiz-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: { name: label, email, password: "Quiz-test-passphrase-2026!" },
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
  await db().profile.create({
    data: {
      userId: result.id,
      school: "Quiz Test University",
      program: "Computer Science",
      currentYear: 2,
      semester: "Fall 2026",
      academicGoal: "Practice concepts",
      studySessionMinutes: 40,
      explanationDifficulty: "INTERMEDIATE",
    },
  });
  return result;
}

async function createCourse(userId: string, code: string) {
  return (
    await db().course.create({
      data: { userId, courseCode: code, courseName: code, semester: "Fall 2026" },
    })
  ).id;
}

async function createDocument(userId: string, parentCourseId: string, title: string) {
  const row = await db().document.create({
    data: {
      userId,
      courseId: parentCourseId,
      title,
      originalFileName: "lecture.txt",
      fileType: "TXT",
      fileSize: material.length,
      storageKey: randomUUID(),
      processingStatus: "READY",
      embeddingModel: embeddingProvider.id,
      pageCount: 7,
    },
  });
  const vector = JSON.stringify(await embeddingProvider.generateEmbedding(material));
  await db()
    .$executeRaw`INSERT INTO "DocumentChunk" (id,"documentId","userId","courseId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata) VALUES (${randomUUID()},${row.id},${userId},${parentCourseId},0,${material},5,6,40,${vector}::vector,${embeddingProvider.id},'{}'::jsonb)`;
  return row.id;
}

function question(type: QuizQuestionKind, index: number) {
  if (type === "multiple-choice") {
    return {
      type,
      prompt: `Multiple choice ${index}`,
      choices: [`Correct ${index}`, `Distractor B ${index}`, `Distractor C ${index}`, `Distractor D ${index}`],
      correctAnswer: `Correct ${index}`,
      explanation: `MC explanation ${index}`,
      topics: ["Mathematical Induction"],
    };
  }
  if (type === "true-false") {
    return {
      type,
      prompt: `True false ${index}`,
      choices: ["True", "False"],
      correctAnswer: "True",
      explanation: `TF explanation ${index}`,
      topics: ["Mathematical Induction"],
    };
  }
  return {
    type,
    prompt: `Written question ${index}`,
    choices: null,
    correctAnswer: `Expected answer ${index}`,
    explanation: `Written explanation ${index}`,
    topics: ["Mathematical Induction"],
  };
}

function quizData(
  count = 5,
  type: QuizQuestionKind = "short-answer",
  difficulty: QuizDifficulty = "medium",
): GeneratedQuizData {
  return {
    quizTitle: "Induction practice",
    topic: "Mathematical induction",
    difficulty,
    questions: Array.from({ length: count }, (_, index) =>
      question(type, index + 1),
    ),
  };
}

function mixedQuizData(
  count = 5,
  difficulty: QuizDifficulty = "medium",
): GeneratedQuizData {
  const types: QuizQuestionKind[] = [
    "multiple-choice",
    "true-false",
    "short-answer",
    "long-answer",
  ];
  return {
    quizTitle: "Mixed induction practice",
    topic: "Mathematical induction",
    difficulty,
    questions: Array.from({ length: count }, (_, index) =>
      question(types[index % types.length], index + 1),
    ),
  };
}

function setup(initial = mixedQuizData()) {
  let generated: unknown = initial;
  let evaluation: unknown = {
    correct: false,
    score: 0.4,
    feedback: "The idea is partly correct; connect the hypothesis to the next case.",
    explanation: "Assume P(k), then explicitly prove P(k+1).",
  };
  const structured = vi.fn(
    async <T>(input: AIStructuredRequest<T>): Promise<AIStructuredResponse<T>> => {
      const candidate =
        input.schemaName === "quiz_generation"
          ? generated
          : input.schemaName === "quiz_answer_evaluation"
            ? evaluation
            : { agentId: "quiz", confidence: 0.8 };
      return {
        id: "structured-response",
        model: "quiz-test-model",
        text: JSON.stringify(candidate),
        data: candidate as T,
      };
    },
  );
  const provider: AIProvider = {
    generateText() {
      throw new Error("Quiz generation must use structured output.");
    },
    async generateStructuredOutput<T>(input: AIStructuredRequest<T>) {
      return (await structured(input)) as AIStructuredResponse<T>;
    },
    streamText() {
      throw new Error("Quiz does not introduce streaming.");
    },
    generateEmbedding() {
      throw new Error("Quiz must use the existing local RAG embedding provider.");
    },
  };
  const getProvider = vi.fn(() => provider);
  return {
    structured,
    getProvider,
    setGenerated(value: unknown) {
      generated = value;
    },
    setEvaluation(value: unknown) {
      evaluation = value;
    },
    service: createQuizAgentService({
      router: { getProvider },
      executor: { getProvider },
      getProvider,
    }),
  };
}

beforeAll(async () => {
  owner = await createActor("Quiz Owner");
  other = await createActor("Other Quiz Student");
  empty = await createActor("Quiz Student Without Documents");
  courseId = await createCourse(owner.id, "QUIZ CS 101");
  otherCourseId = await createCourse(other.id, "PRIVATE CS 999");
  documentId = await createDocument(owner.id, courseId, "Lecture 5.txt");
  otherDocumentId = await createDocument(
    other.id,
    otherCourseId,
    "Private lecture.txt",
  );
}, 30000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const actor of actors) {
    await db().user.deleteMany({ where: { id: actor.id, email: actor.email } });
    await db().fileDeletion.deleteMany({ where: { userId: actor.id } });
  }
  await db().$disconnect();
});

describe.sequential("Quiz Agent definition and generation", () => {
  it("registers Quiz with shared capabilities and minimal declared context", () => {
    const quiz = getQuizAgentDefinition();
    expect(getStudentAgentDefinitions().filter((agent) => agent.id === "quiz")).toEqual([quiz]);
    expect(quiz.capabilities).toEqual([
      "generate-questions",
      "generate-multiple-choice",
      "generate-short-answer",
      "generate-long-answer",
      "evaluate-answers",
      "explain-wrong-answers",
    ]);
    for (const capability of quiz.capabilities) expect(AGENT_CAPABILITIES).toContain(capability);
    expect(quiz.contextRequirements).toEqual({
      profile: true,
      course: true,
      documents: true,
      learning: true,
      memories: true,
      memoryCategories: ["preference", "learning-pattern"],
      memoryKeys: ["quizDifficulty", "questionType"],
      limits: { memories: 4 },
    });
    const registry = new AgentRegistry();
    registry.register(quiz);
    expect(registry.get("quiz")).toEqual(quiz);
  });

  it.each([
    "Quiz me on mathematical induction",
    "Give me 10 practice questions",
    "Make multiple-choice questions from Lecture 5",
    "Give me short-answer questions",
    "Test me on recursion",
    "Make the questions harder",
    "Check my answer",
    "Explain why my answer is wrong",
  ])("uses the existing Router for '%s'", async (request) => {
    const registry = new AgentRegistry();
    for (const agent of getStudentAgentDefinitions()) registry.register(agent);
    const route = await new AgentRouter(registry, {
      getProvider: setup().getProvider,
    }).routeAgent({ request });
    expect(route.agentId).toBe("quiz");
  });

  it("generates validated multiple-choice questions, stores answers, and hides them publicly", async () => {
    const boundary = setup(quizData(3, "multiple-choice", "hard"));
    const execute = vi.spyOn(AgentExecutor.prototype, "executeStructured");
    const result = await boundary.service.generateQuiz(
      { request: "Give me 3 hard multiple-choice questions", count: 3, questionType: "multiple-choice", difficulty: "hard" },
      owner.headers,
    );
    expect(result).toMatchObject({ difficulty: "hard", courseId: null });
    expect(result.questions).toHaveLength(3);
    expect(result.questions.every((item) => item.type === "multiple-choice" && item.choices?.length === 4)).toBe(true);
    expect(result.questions.every((item) => !Object.hasOwn(item, "correctAnswer") && !Object.hasOwn(item, "explanation"))).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][2]).toMatchObject({ schemaName: "quiz_generation", maxOutputTokens: 1650 });
    const stored = await db().quizQuestion.findMany({ where: { quizId: result.id }, orderBy: { position: "asc" } });
    expect(stored.map((item) => item.correctAnswer)).toEqual(["Correct 1", "Correct 2", "Correct 3"]);
    expect(JSON.stringify(result)).not.toContain("MC explanation");
  });

  it("defaults to five mixed medium questions and validates exact structure", async () => {
    const boundary = setup(mixedQuizData());
    const result = await boundary.service.generateQuiz(
      { request: "Give me practice questions about recursion" },
      owner.headers,
    );
    expect(result.difficulty).toBe("medium");
    expect(result.questions).toHaveLength(5);
    expect(new Set(result.questions.map((item) => item.type)).size).toBeGreaterThan(1);
    const call = boundary.structured.mock.calls.find(([input]) => input.schemaName === "quiz_generation")![0];
    expect(call.messages[0].content).toContain(QUIZ_INSTRUCTIONS);
    expect(call.messages[0].content).toContain('"count":5');
    expect(call.messages[0].content).toContain('"difficulty":"medium"');
  });

  it.each([
    ["true-false", "easy"],
    ["short-answer", "medium"],
    ["long-answer", "hard"],
  ] as const)("supports %s questions at %s difficulty", async (questionType, difficulty) => {
    const boundary = setup(quizData(1, questionType, difficulty));
    const result = await boundary.service.generateQuiz(
      { request: `Make one ${questionType} question`, count: 1, questionType, difficulty },
      owner.headers,
    );
    expect(result).toMatchObject({ difficulty, questions: [{ type: questionType }] });
  });

  it("resolves adaptive input to medium while learning progress is unavailable", async () => {
    const boundary = setup(quizData(1, "short-answer", "medium"));
    const result = await boundary.service.generateQuiz(
      { request: "Quiz me adaptively", count: 1, questionType: "short-answer", difficulty: "adaptive" },
      owner.headers,
    );
    expect(result.difficulty).toBe("medium");
    const call = boundary.structured.mock.calls.find(([input]) => input.schemaName === "quiz_generation")![0];
    expect(call.messages[0].content).toContain('"difficulty":"adaptive"');
    expect(call.messages[0].content).toContain('"adaptiveFallback":"medium"');
  });

  it("rejects invalid structured questions before persistence", async () => {
    const boundary = setup();
    boundary.setGenerated({
      ...quizData(1, "multiple-choice"),
      questions: [
        {
          ...question("multiple-choice", 1),
          choices: ["Correct 1", "Distractor B 1", "Distractor C 1"],
        },
      ],
    });
    const before = await db().quiz.count({ where: { userId: owner.id } });
    await expect(
      boundary.service.generateQuiz(
        {
          request: "Give me one multiple-choice question",
          count: 1,
          questionType: "multiple-choice",
        },
        owner.headers,
      ),
    ).rejects.toMatchObject({ name: "AIError", code: "INVALID_RESPONSE" });
    await expect(
      db().quiz.count({ where: { userId: owner.id } }),
    ).resolves.toBe(before);
  });

  it.each([
    { request: "Give me 0 questions" },
    { request: "Give me 21 questions" },
    { request: "Quiz me", count: 0 },
    { request: "Quiz me", count: 21 },
    { request: "x".repeat(1001) },
  ])("rejects invalid counts and requests before AI or persistence %#", async (input) => {
    const boundary = setup();
    await expect(boundary.service.generateQuiz(input, owner.headers)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(boundary.getProvider).not.toHaveBeenCalled();
  });

  it("uses selected document RAG once and preserves only actual source metadata", async () => {
    const boundary = setup(quizData(1));
    const retrieve = vi.spyOn(retrieval, "retrieveAcademicContext");
    const request = "Quiz me on the Base Step and Inductive Step from Lecture 5";
    const result = await boundary.service.generateQuiz(
      { request, count: 1, courseId, documentIds: [documentId] },
      owner.headers,
    );
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith(owner.id, {
      query: request,
      courseId,
      documentIds: [documentId],
      maxResults: 5,
    });
    expect(result.sources).toEqual([
      {
        documentId,
        documentTitle: "Lecture 5.txt",
        pageNumber: 5,
        pageEnd: 6,
        courseId,
        courseCode: "QUIZ CS 101",
        chunkIndex: 0,
      },
    ]);
    const loaded = await boundary.service.getQuiz(result.id, owner.headers);
    expect(loaded.sources).toEqual(result.sources);
    expect(JSON.stringify(result.sources)).not.toContain(material);
  });

  it("includes an explicit topic in the bounded RAG query", async () => {
    const boundary = setup(quizData(1));
    const retrieve = vi.spyOn(retrieval, "retrieveAcademicContext");
    const result = await boundary.service.generateQuiz(
      {
        request: "Quiz me",
        topic: "Inductive Step",
        count: 1,
        courseId,
        documentIds: [documentId],
      },
      owner.headers,
    );
    expect(retrieve).toHaveBeenCalledWith(owner.id, {
      query: "Quiz me\nTopic: Inductive Step",
      courseId,
      documentIds: [documentId],
      maxResults: 5,
    });
    expect(result.topic).toBe("Inductive Step");
  });

  it("infers an omitted course only from an unambiguous owned topic set", async () => {
    await db().learningTopic.upsert({
      where: {
        userId_courseId_normalizedName: {
          userId: owner.id,
          courseId,
          normalizedName: "course inference topic",
        },
      },
      create: {
        userId: owner.id,
        courseId,
        name: "Course Inference Topic",
        normalizedName: "course inference topic",
      },
      update: {},
    });
    const generated = quizData(1, "short-answer");
    generated.topic = "Course Inference Topic";
    generated.questions[0].topics = ["Course Inference Topic"];
    const boundary = setup(generated);

    const result = await boundary.service.generateQuiz(
      {
        request: "Quiz me on the course inference topic",
        count: 1,
        questionType: "short-answer",
      },
      owner.headers,
    );

    expect(result.courseId).toBe(courseId);
    await expect(
      db().quizQuestionTopic.count({
        where: {
          questionId: result.questions[0].id,
          userId: owner.id,
          courseId,
        },
      }),
    ).resolves.toBe(1);
  });

  it("refuses a source-specific quiz with no retrieved passage before generation", async () => {
    const boundary = setup(quizData(1));
    await expect(
      boundary.service.generateQuiz(
        { request: "Make a quiz from my lecture", count: 1 },
        empty.headers,
      ),
    ).rejects.toEqual(new QuizAgentError("SOURCE_CONTEXT_UNAVAILABLE"));
    expect(boundary.structured).not.toHaveBeenCalled();
  });

  it("loads quiz preferences while excluding assignments and exams", async () => {
    const boundary = setup(quizData(1));
    const build = vi.spyOn(contextBuilder, "buildUserContext");
    const unused = [
      vi.spyOn(categories, "assignmentContext"),
      vi.spyOn(categories, "examContext"),
    ];
    const memories = vi.spyOn(categories, "memoryContext");
    await boundary.service.generateQuiz(
      { request: "Quiz me on induction", count: 1, courseId },
      owner.headers,
    );
    expect(build).toHaveBeenCalledTimes(1);
    for (const spy of unused) expect(spy).not.toHaveBeenCalled();
    expect(memories).toHaveBeenCalledTimes(1);
    const built = await build.mock.results[0].value;
    expect(built.metadata.requestedCategories).toEqual([
      "profile",
      "course",
      "documents",
      "memories",
      "learning",
    ]);
  });

  it("rejects another user's course and document before generation", async () => {
    const boundary = setup(quizData(1));
    for (const scope of [
      { courseId: otherCourseId },
      { documentIds: [otherDocumentId] },
    ]) {
      await expect(
        boundary.service.generateQuiz(
          { request: "Quiz me from this lecture", count: 1, ...scope },
          owner.headers,
        ),
      ).rejects.toMatchObject({ code: "CONTEXT_FAILURE" });
    }
    expect(boundary.structured).not.toHaveBeenCalled();
  });
});

describe.sequential("owned quiz retrieval and answer grading", () => {
  it("grades objective answers deterministically without any model call", async () => {
    const boundary = setup(quizData(1, "multiple-choice"));
    const quiz = await boundary.service.generateQuiz(
      { request: "Give me one multiple-choice question", count: 1, questionType: "multiple-choice" },
      owner.headers,
    );
    boundary.structured.mockClear();
    boundary.getProvider.mockClear();
    const correct = await boundary.service.evaluateAnswer(
      { quizId: quiz.id, questionId: quiz.questions[0].id, userAnswer: "  correct 1 " },
      owner.headers,
    );
    expect(correct).toMatchObject({ correct: true, score: 1, method: "deterministic" });
    const wrong = await boundary.service.evaluateAnswer(
      { quizId: quiz.id, questionId: quiz.questions[0].id, userAnswer: "Distractor B 1" },
      owner.headers,
    );
    expect(wrong).toMatchObject({
      correct: false,
      method: "deterministic",
      feedback: "Incorrect. The correct answer is Correct 1.",
      explanation: "MC explanation 1",
    });
    expect(boundary.structured).not.toHaveBeenCalled();
    expect(boundary.getProvider).not.toHaveBeenCalled();
  });

  it("maps generated questions to learning topics and records objective progress", async () => {
    const generated = quizData(1, "multiple-choice");
    generated.topic = "Learning Pipeline Topic";
    generated.questions[0].topics = ["Learning Pipeline Topic"];
    const boundary = setup(generated);
    const quiz = await boundary.service.generateQuiz(
      {
        request: "Give me one multiple-choice induction question",
        count: 1,
        questionType: "multiple-choice",
        courseId,
      },
      owner.headers,
    );
    const mapping = await db().quizQuestionTopic.findFirstOrThrow({
      where: {
        questionId: quiz.questions[0].id,
        userId: owner.id,
        courseId,
      },
      include: { topic: true },
    });
    expect(mapping.topic).toMatchObject({
      userId: owner.id,
      courseId,
      normalizedName: "learning pipeline topic",
    });

    boundary.structured.mockClear();
    boundary.getProvider.mockClear();
    const evaluation = await boundary.service.evaluateAnswer(
      {
        quizId: quiz.id,
        questionId: quiz.questions[0].id,
        userAnswer: "Correct 1",
      },
      owner.headers,
    );
    expect(evaluation).toMatchObject({
      quizAttemptId: expect.any(String),
      correct: true,
      score: 1,
      method: "deterministic",
    });
    expect(boundary.structured).not.toHaveBeenCalled();
    expect(boundary.getProvider).not.toHaveBeenCalled();

    const progress = await db().learningProgress.findUniqueOrThrow({
      where: {
        userId_courseId_topicId: {
          userId: owner.id,
          courseId,
          topicId: mapping.topicId,
        },
      },
    });
    expect(progress).toMatchObject({
      questionsAttempted: 1,
      correctAnswers: 1,
      incorrectAnswers: 0,
      practiceSessions: 1,
      masteryScore: 63,
      confidenceScore: 12,
    });
    await expect(
      db().questionAttempt.findFirst({
        where: {
          quizAttemptId: evaluation.quizAttemptId,
          userId: owner.id,
          questionId: quiz.questions[0].id,
        },
      }),
    ).resolves.toMatchObject({ score: 1, isCorrect: true });
    await expect(
      db().quizAttempt.findFirst({
        where: {
          id: evaluation.quizAttemptId,
          userId: owner.id,
          quizId: quiz.id,
        },
      }),
    ).resolves.not.toBeNull();
  });

  it("uses one minimal structured AI call for semantic grading", async () => {
    const boundary = setup(quizData(1, "short-answer"));
    const quiz = await boundary.service.generateQuiz(
      { request: "Give me one short-answer question", count: 1, questionType: "short-answer" },
      owner.headers,
    );
    boundary.structured.mockClear();
    boundary.getProvider.mockClear();
    const result = await boundary.service.evaluateAnswer(
      { quizId: quiz.id, questionId: quiz.questions[0].id, userAnswer: "It proves the next case from the hypothesis." },
      owner.headers,
    );
    expect(result).toMatchObject({
      correct: false,
      score: 0.4,
      method: "semantic",
    });
    expect(boundary.getProvider).toHaveBeenCalledTimes(1);
    expect(boundary.structured).toHaveBeenCalledTimes(1);
    const input = boundary.structured.mock.calls[0][0];
    expect(input.schemaName).toBe("quiz_answer_evaluation");
    expect(input.maxOutputTokens).toBe(512);
    expect(input.messages).toHaveLength(2);
    expect(JSON.parse(input.messages[1].content)).toEqual({
      question: "Written question 1",
      expectedAnswer: "Expected answer 1",
      userAnswer: "It proves the next case from the hypothesis.",
    });
    expect(JSON.stringify(input.messages)).not.toMatch(/Lecture 5|Quiz Owner|PRIVATE CS/);
  });

  it("prevents cross-user quiz retrieval and grading without revealing existence", async () => {
    const boundary = setup(quizData(1));
    const quiz = await boundary.service.generateQuiz(
      { request: "Quiz me on recursion", count: 1 },
      owner.headers,
    );
    await expect(boundary.service.getQuiz(quiz.id, other.headers)).rejects.toEqual(
      new QuizAgentError("QUIZ_NOT_FOUND"),
    );
    boundary.structured.mockClear();
    await expect(
      boundary.service.evaluateAnswer(
        { quizId: quiz.id, questionId: quiz.questions[0].id, userAnswer: "Attempt" },
        other.headers,
      ),
    ).rejects.toEqual(new QuizAgentError("QUIZ_NOT_FOUND"));
    expect(boundary.structured).not.toHaveBeenCalled();
  });
});
