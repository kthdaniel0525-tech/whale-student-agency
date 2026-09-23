import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import type {
  AIProvider,
  AIStructuredRequest,
  AIStructuredResponse,
} from "@/server/ai/types";
import { createStudentAgentService } from "@/server/agents/student-service";
import {
  createQuizAgentService,
  type GeneratedQuizData,
} from "@/server/agents/quiz";
import { buildUserContext } from "@/server/context";
import * as retrieval from "@/server/documents/retrieval";

type Actor = { id: string; email: string; headers: Headers };
const DAY = 86_400_000;

const actors: Actor[] = [];
let owner: Actor;
let other: Actor;
let courseId: string;

async function createActor(label: string): Promise<Actor> {
  const email = `learning-context-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: {
      name: label,
      email,
      password: "Learning-context-test-passphrase-2026!",
    },
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
      school: "Learning Test University",
      program: "Mathematics",
      currentYear: 2,
      semester: "Fall 2026",
      academicGoal: "Improve proof skills",
      studySessionMinutes: 45,
      explanationDifficulty: "INTERMEDIATE",
    },
  });
  return actor;
}

async function createCourse(userId: string, courseCode: string) {
  return db().course.create({
    data: {
      userId,
      courseCode,
      courseName: "Discrete Mathematics",
      semester: "Fall 2026",
    },
  });
}

async function createProgress(input: {
  userId: string;
  courseId: string;
  name: string;
  normalizedName: string;
  mastery: number;
  confidence: number;
  recentAccuracy: number;
  attempted: number;
  correct: number;
  sessions: number;
  lastPracticedAt: Date;
}) {
  const topic = await db().learningTopic.create({
    data: {
      userId: input.userId,
      courseId: input.courseId,
      name: input.name,
      normalizedName: input.normalizedName,
    },
  });
  await db().learningProgress.create({
    data: {
      userId: input.userId,
      courseId: input.courseId,
      topicId: topic.id,
      masteryScore: input.mastery,
      confidenceScore: input.confidence,
      recentAccuracy: input.recentAccuracy,
      questionsAttempted: input.attempted,
      correctAnswers: input.correct,
      incorrectAnswers: input.attempted - input.correct,
      scoreTotal: input.correct,
      difficultyWeightedScore: input.correct,
      difficultyWeightTotal: input.attempted,
      practiceSessions: input.sessions,
      mediumAttempts: input.attempted,
      firstPracticedAt: new Date(input.lastPracticedAt.getTime() - 30 * DAY),
      lastPracticedAt: input.lastPracticedAt,
      trend: input.mastery < 70 ? "DECLINING" : "IMPROVING",
    },
  });
  return topic;
}

function aiBoundary(quiz: GeneratedQuizData) {
  const generateText = vi.fn<AIProvider["generateText"]>().mockResolvedValue({
    id: "learning-tutor-response",
    model: "learning-test-model",
    text: "A learning-aware tutor response.",
  });
  const generateStructuredOutput = vi.fn(
    async <T>(
      request: AIStructuredRequest<T>,
    ): Promise<AIStructuredResponse<T>> => {
      const candidate =
        request.schemaName === "quiz_generation"
          ? quiz
          : { agentId: "quiz", confidence: 0.9 };
      return {
        id: "learning-structured-response",
        model: "learning-test-model",
        text: JSON.stringify(candidate),
        data: candidate as T,
      };
    },
  );
  const provider: AIProvider = {
    generateText,
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      return (await generateStructuredOutput(
        request,
      )) as AIStructuredResponse<T>;
    },
    async *streamText() {},
    async generateEmbedding() {
      throw new Error("Learning context tests do not call provider embeddings.");
    },
  };
  return { provider, generateText, generateStructuredOutput };
}

beforeAll(async () => {
  const now = new Date();
  owner = await createActor("Learning Context Owner");
  other = await createActor("Learning Context Other User");
  const ownerCourse = await createCourse(owner.id, "MATH 1240");
  const otherCourse = await createCourse(other.id, "PRIVATE 9999");
  courseId = ownerCourse.id;

  const weakTopic = await createProgress({
    userId: owner.id,
    courseId,
    name: "Mathematical Induction",
    normalizedName: "mathematical induction",
    mastery: 32,
    confidence: 82,
    recentAccuracy: 25,
    attempted: 12,
    correct: 3,
    sessions: 4,
    lastPracticedAt: new Date(now.getTime() - 3 * DAY),
  });
  await createProgress({
    userId: owner.id,
    courseId,
    name: "Recursion",
    normalizedName: "recursion",
    mastery: 58,
    confidence: 70,
    recentAccuracy: 55,
    attempted: 10,
    correct: 6,
    sessions: 3,
    lastPracticedAt: new Date(now.getTime() - 5 * DAY),
  });
  await createProgress({
    userId: owner.id,
    courseId,
    name: "Logic",
    normalizedName: "logic",
    mastery: 92,
    confidence: 88,
    recentAccuracy: 94,
    attempted: 18,
    correct: 17,
    sessions: 5,
    lastPracticedAt: new Date(now.getTime() - 2 * DAY),
  });
  await db().learningTopic.create({
    data: {
      userId: owner.id,
      courseId,
      name: "Proof by Contradiction",
      normalizedName: "proof by contradiction",
    },
  });
  await createProgress({
    userId: other.id,
    courseId: otherCourse.id,
    name: "FOREIGN_SECRET_TOPIC",
    normalizedName: "foreign_secret_topic",
    mastery: 5,
    confidence: 99,
    recentAccuracy: 0,
    attempted: 30,
    correct: 0,
    sessions: 8,
    lastPracticedAt: new Date(now.getTime() - DAY),
  });

  const quiz = await db().quiz.create({
    data: {
      userId: owner.id,
      courseId,
      title: "Stored evidence",
      topic: "Mathematical Induction",
      difficulty: "MEDIUM",
    },
  });
  const question = await db().quizQuestion.create({
    data: {
      quizId: quiz.id,
      userId: owner.id,
      position: 0,
      type: "SHORT_ANSWER",
      prompt: "State the inductive step.",
      correctAnswer: "DO_NOT_LEAK_CORRECT_ANSWER",
      explanation: "Stored explanation",
      topicNames: ["Mathematical Induction"],
    },
  });
  await db().quizQuestionTopic.create({
    data: {
      questionId: question.id,
      topicId: weakTopic.id,
      userId: owner.id,
      courseId,
    },
  });
  const attempt = await db().quizAttempt.create({
    data: {
      userId: owner.id,
      quizId: quiz.id,
      startedAt: new Date(now.getTime() - 3 * DAY - 3_600_000),
      completedAt: new Date(now.getTime() - 3 * DAY),
    },
  });
  await db().questionAttempt.create({
    data: {
      userId: owner.id,
      quizId: quiz.id,
      quizAttemptId: attempt.id,
      questionId: question.id,
      userAnswer: "DO_NOT_LEAK_RAW_ANSWER",
      score: 0,
      isCorrect: false,
      evaluationMethod: "DETERMINISTIC",
      attemptedAt: new Date(now.getTime() - 3 * DAY),
    },
  });
}, 30000);

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  for (const actor of actors) {
    await db().user.deleteMany({ where: { id: actor.id, email: actor.email } });
    await db().fileDeletion.deleteMany({ where: { userId: actor.id } });
  }
  await db().$disconnect();
});

describe.sequential("Learning intelligence context compatibility", () => {
  it("returns bounded owned learning summaries without raw attempts", async () => {
    const context = await buildUserContext(
      {
        request: "Show my learning priorities",
        courseId,
        options: { learning: true, limits: { learning: 1 } },
      },
      owner.headers,
    );

    expect(context.learning).toBeDefined();
    expect(context.learning?.weakTopics).toEqual([
      expect.objectContaining({
        topic: "Mathematical Induction",
        mastery: 32,
        confidence: 82,
        trend: "declining",
      }),
    ]);
    expect(context.learning?.strongTopics).toEqual([
      expect.objectContaining({
        topic: "Logic",
        mastery: 92,
        confidence: 88,
        trend: "improving",
      }),
    ]);
    expect(context.learning?.recommendedTopics).toHaveLength(1);
    expect(context.metadata.truncatedCategories).not.toContain("learning");

    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("FOREIGN_SECRET_TOPIC");
    expect(serialized).not.toContain("DO_NOT_LEAK_RAW_ANSWER");
    expect(serialized).not.toContain("DO_NOT_LEAK_CORRECT_ANSWER");
    expect(serialized).not.toContain("questionAttempt");
  });

  it("adds real weak-topic intelligence to the Tutor prompt", async () => {
    vi.spyOn(retrieval, "retrieveAcademicContext").mockResolvedValue([]);
    const ai = aiBoundary({
      quizTitle: "Unused",
      topic: "Mathematical Induction",
      difficulty: "medium",
      questions: [],
    });
    const service = createStudentAgentService({
      router: { getProvider: () => ai.provider },
      executor: { getProvider: () => ai.provider },
    });

    const result = await service.handleAgentRequest(
      { request: "Explain mathematical induction", courseId },
      owner.headers,
    );

    expect(result).toMatchObject({
      ok: true,
      agent: { id: "tutor" },
      metadata: { contextCategories: expect.arrayContaining(["learning"]) },
    });
    expect(ai.generateText).toHaveBeenCalledTimes(1);
    const prompt = ai.generateText.mock.calls[0][0].messages
      .map((message) => message.content)
      .join("\n");
    expect(prompt).toContain("[LEARNING]");
    expect(prompt).toContain("Mathematical Induction");
    expect(prompt).toContain('"mastery":32');
    expect(prompt).toContain('"confidence":82');
    expect(prompt).not.toContain("FOREIGN_SECRET_TOPIC");
    expect(prompt).not.toContain("DO_NOT_LEAK_RAW_ANSWER");
  });

  it("passes weak-topic context to adaptive Quiz generation", async () => {
    vi.spyOn(retrieval, "retrieveAcademicContext").mockResolvedValue([]);
    const ai = aiBoundary({
      quizTitle: "Weak-topic practice",
      topic: "Mathematical Induction",
      difficulty: "hard",
      questions: [
        {
          type: "short-answer",
          prompt: "Explain the inductive step.",
          choices: null,
          correctAnswer: "Use the hypothesis to prove the next case.",
          explanation: "The implication from k to k + 1 is the step.",
          topics: ["Mathematical Induction"],
        },
      ],
    });
    const service = createQuizAgentService({
      router: { getProvider: () => ai.provider },
      executor: { getProvider: () => ai.provider },
      getProvider: () => ai.provider,
    });

    const result = await service.generateQuiz(
      {
        request: "Quiz me on my weak topics",
        courseId,
        count: 1,
        questionType: "short-answer",
        difficulty: "adaptive",
      },
      owner.headers,
    );

    expect(result).toMatchObject({
      difficulty: "hard",
      courseId,
      questions: [
        expect.objectContaining({ topics: ["Mathematical Induction"] }),
      ],
      metadata: { contextCategories: expect.arrayContaining(["learning"]) },
    });
    const generation = ai.generateStructuredOutput.mock.calls.find(
      ([request]) => request.schemaName === "quiz_generation",
    );
    expect(generation).toBeDefined();
    const prompt = generation![0].messages
      .map((message) => message.content)
      .join("\n");
    expect(prompt).toContain("[LEARNING]");
    expect(prompt).toContain("Mathematical Induction");
    expect(prompt).toContain('"status":"weak"');
    expect(prompt).not.toContain("FOREIGN_SECRET_TOPIC");
  });
});
