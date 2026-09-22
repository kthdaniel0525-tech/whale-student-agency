import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth } from "@/server/auth/config";
import { buildUserContext } from "@/server/context";
import { db } from "@/server/db/client";
import {
  calculateLearningMetrics,
  calculateTrend,
  createLearningTopic,
  deleteQuizAttempt,
  getRecommendedPracticeTopics,
  getStrongTopics,
  getWeakTopics,
  mapQuestionToTopics,
  normalizeTopicName,
  recordQuestionEvaluation,
  resolveLearningCourseId,
} from "@/server/learning";
import type {
  LearningAggregate,
  LearningAttemptEvidence,
  LearningDifficulty,
} from "@/server/learning";

const DAY = 86_400_000;
const NOW = new Date("2026-09-13T12:00:00.000Z");

function dateBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

function evidence(
  id: string,
  score: number,
  daysAgo: number,
  sessionId: string,
  difficulty: LearningDifficulty = "medium",
): LearningAttemptEvidence {
  return {
    id,
    score,
    correct: score >= 1,
    difficulty,
    attemptedAt: dateBefore(daysAgo),
    sessionId,
  };
}

function aggregate(
  overrides: Partial<LearningAggregate> = {},
): LearningAggregate {
  return {
    questionsAttempted: 0,
    scoreTotal: 0,
    difficultyWeightedScore: 0,
    difficultyWeightTotal: 0,
    practiceSessions: 0,
    easyAttempts: 0,
    mediumAttempts: 0,
    hardAttempts: 0,
    firstPracticedAt: null,
    lastPracticedAt: null,
    ...overrides,
  };
}

describe("deterministic learning calculations", () => {
  it("weights hard evidence modestly above easy evidence", () => {
    const easy = calculateLearningMetrics({
      aggregate: aggregate({
        questionsAttempted: 1,
        scoreTotal: 1,
        difficultyWeightedScore: 0.8,
        difficultyWeightTotal: 0.8,
        practiceSessions: 1,
        easyAttempts: 1,
        firstPracticedAt: NOW,
        lastPracticedAt: NOW,
      }),
      recentAttempts: [evidence("easy", 1, 0, "session-1", "easy")],
      now: NOW,
    });
    const hard = calculateLearningMetrics({
      aggregate: aggregate({
        questionsAttempted: 1,
        scoreTotal: 1,
        difficultyWeightedScore: 1.2,
        difficultyWeightTotal: 1.2,
        practiceSessions: 1,
        hardAttempts: 1,
        firstPracticedAt: NOW,
        lastPracticedAt: NOW,
      }),
      recentAttempts: [evidence("hard", 1, 0, "session-1", "hard")],
      now: NOW,
    });

    expect(easy.mastery).toBe(61);
    expect(hard.mastery).toBe(64);
    expect(hard.mastery).toBeGreaterThan(easy.mastery);
  });

  it("smooths a one-answer sample and reports limited confidence", () => {
    const result = calculateLearningMetrics({
      aggregate: aggregate({
        questionsAttempted: 1,
        scoreTotal: 1,
        difficultyWeightedScore: 1.2,
        difficultyWeightTotal: 1.2,
        practiceSessions: 1,
        hardAttempts: 1,
        firstPracticedAt: NOW,
        lastPracticedAt: NOW,
      }),
      recentAttempts: [evidence("only", 1, 0, "session-1", "hard")],
      now: NOW,
    });

    expect(result).toMatchObject({ mastery: 64, confidence: 12 });
    expect(result.mastery).toBeLessThan(100);
  });

  it("weights recent attempts more heavily than older attempts", () => {
    const common = aggregate({
      questionsAttempted: 12,
      scoreTotal: 4,
      difficultyWeightedScore: 4,
      difficultyWeightTotal: 12,
      practiceSessions: 2,
      mediumAttempts: 12,
      firstPracticedAt: dateBefore(60),
      lastPracticedAt: NOW,
    });
    const recentSuccess = calculateLearningMetrics({
      aggregate: common,
      recentAttempts: [
        ...Array.from({ length: 4 }, (_, index) =>
          evidence(`new-correct-${index}`, 1, 0, "recent"),
        ),
        ...Array.from({ length: 4 }, (_, index) =>
          evidence(`old-wrong-${index}`, 0, 60, "previous"),
        ),
      ],
      now: NOW,
    });
    const recentFailure = calculateLearningMetrics({
      aggregate: common,
      recentAttempts: [
        ...Array.from({ length: 4 }, (_, index) =>
          evidence(`new-wrong-${index}`, 0, 0, "recent"),
        ),
        ...Array.from({ length: 4 }, (_, index) =>
          evidence(`old-correct-${index}`, 1, 60, "previous"),
        ),
      ],
      now: NOW,
    });

    expect(recentSuccess.recentAccuracy).toBe(80);
    expect(recentFailure.recentAccuracy).toBe(20);
    expect(recentSuccess.mastery).toBe(63);
    expect(recentFailure.mastery).toBe(27);
  });

  it("increases confidence with attempts, sessions, difficulty diversity and time", () => {
    const small = calculateLearningMetrics({
      aggregate: aggregate({
        questionsAttempted: 1,
        practiceSessions: 1,
        mediumAttempts: 1,
        difficultyWeightTotal: 1,
        firstPracticedAt: NOW,
        lastPracticedAt: NOW,
      }),
      recentAttempts: [],
      now: NOW,
    });
    const broad = calculateLearningMetrics({
      aggregate: aggregate({
        questionsAttempted: 15,
        scoreTotal: 10,
        difficultyWeightedScore: 10,
        difficultyWeightTotal: 15,
        practiceSessions: 4,
        easyAttempts: 5,
        mediumAttempts: 5,
        hardAttempts: 5,
        firstPracticedAt: dateBefore(21),
        lastPracticedAt: NOW,
      }),
      recentAttempts: [],
      now: NOW,
    });

    expect(small.confidence).toBe(12);
    expect(broad.confidence).toBe(100);
    expect(broad.confidence).toBeGreaterThan(small.confidence);
  });

  it("requires sustained evidence for improving or declining trends", () => {
    const improving = [
      ...[1, 1, 1, 1, 0].map((score, index) =>
        evidence(`recent-${index}`, score, index, "recent-session"),
      ),
      ...[1, 0, 0, 0, 0].map((score, index) =>
        evidence(`previous-${index}`, score, index + 10, "previous-session"),
      ),
    ];
    const declining = [
      ...[1, 0, 0, 0, 0].map((score, index) =>
        evidence(`declining-recent-${index}`, score, index, "recent-session"),
      ),
      ...[1, 1, 1, 1, 0].map((score, index) =>
        evidence(
          `declining-previous-${index}`,
          score,
          index + 10,
          "previous-session",
        ),
      ),
    ];
    const oneAnswerDifference = [
      ...[1, 1, 1, 0, 0].map((score, index) =>
        evidence(`stable-recent-${index}`, score, index, "recent-session"),
      ),
      ...[1, 1, 0, 0, 0].map((score, index) =>
        evidence(`stable-previous-${index}`, score, index + 10, "previous-session"),
      ),
    ];

    expect(calculateTrend(improving)).toBe("improving");
    expect(calculateTrend(declining)).toBe("declining");
    expect(calculateTrend(oneAnswerDifference)).toBe("stable");
    expect(calculateTrend(improving.slice(0, 9))).toBe("insufficient-data");
  });
});

type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor;
let other: Actor;

async function createActor(label: string): Promise<Actor> {
  const email = `learning-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: {
      name: label,
      email,
      password: "Learning-test-passphrase-2026!",
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
        .map((value) => value.split(";")[0])
        .join("; "),
    }),
  };
  actors.push(actor);
  await db().profile.create({
    data: {
      userId: actor.id,
      school: "Learning Test University",
      program: "Computer Science",
      currentYear: 2,
      semester: "Fall 2026",
      academicGoal: "Improve topic mastery",
      studySessionMinutes: 45,
      explanationDifficulty: "INTERMEDIATE",
    },
  });
  return actor;
}

async function createCourse(userId: string, prefix: string) {
  return db().course.create({
    data: {
      userId,
      courseCode: `${prefix}-${randomUUID().slice(0, 6)}`,
      courseName: `${prefix} Learning Course`,
      semester: "Fall 2026",
    },
  });
}

async function createQuestion(input: {
  userId: string;
  courseId?: string;
  topic?: string | null;
  topicNames?: string[];
  difficulty?: "EASY" | "MEDIUM" | "HARD";
}) {
  const quiz = await db().quiz.create({
    data: {
      userId: input.userId,
      courseId: input.courseId,
      title: `Learning quiz ${randomUUID()}`,
      topic: input.topic,
      difficulty: input.difficulty ?? "MEDIUM",
      questions: {
        create: {
          position: 0,
          type: "SHORT_ANSWER",
          prompt: "Explain the target concept.",
          correctAnswer: "A correct explanation",
          explanation: "The expected concept explanation.",
          topicNames: input.topicNames ?? [],
        },
      },
    },
    include: { questions: true },
  });
  return { quiz, question: quiz.questions[0] };
}

async function record(input: {
  userId: string;
  quizId: string;
  questionId: string;
  quizAttemptId?: string;
  startNewAttempt?: boolean;
  score: number;
  correct: boolean;
  attemptedAt?: Date;
}) {
  return recordQuestionEvaluation({
    ...input,
    userAnswer: input.correct ? "A correct explanation" : "Not correct",
    method: "deterministic",
  });
}

async function seedProgress(input: {
  userId: string;
  courseId: string;
  topicId: string;
  mastery: number;
  confidence: number;
  recentAccuracy: number;
  attempted: number;
  correct: number;
  sessions: number;
  firstPracticedAt: Date;
  lastPracticedAt: Date;
}) {
  return db().learningProgress.create({
    data: {
      userId: input.userId,
      courseId: input.courseId,
      topicId: input.topicId,
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
      firstPracticedAt: input.firstPracticedAt,
      lastPracticedAt: input.lastPracticedAt,
      trend: "STABLE",
    },
  });
}

beforeAll(async () => {
  owner = await createActor("Learning Owner");
  other = await createActor("Other Learning Student");
}, 30_000);

afterAll(async () => {
  for (const actor of actors) {
    await db().user.deleteMany({ where: { id: actor.id, email: actor.email } });
    await db().fileDeletion.deleteMany({ where: { userId: actor.id } });
  }
  await db().$disconnect();
});

describe.sequential("Learning Intelligence persistence and retrieval", () => {
  it("normalizes exact topic duplicates without merging distinct concepts", async () => {
    const course = await createCourse(owner.id, "NORMALIZE");
    const first = await createLearningTopic({
      userId: owner.id,
      courseId: course.id,
      name: "  Mathematical   Induction  ",
    });
    const duplicate = await createLearningTopic({
      userId: owner.id,
      courseId: course.id,
      name: "mathematical induction",
    });
    const hyphenated = await createLearningTopic({
      userId: owner.id,
      courseId: course.id,
      name: "Proof-by-Induction",
    });
    const spaced = await createLearningTopic({
      userId: owner.id,
      courseId: course.id,
      name: "Proof by Induction",
    });

    expect(duplicate.id).toBe(first.id);
    expect(first.normalizedName).toBe("mathematical induction");
    expect(hyphenated.id).not.toBe(spaced.id);
    expect(normalizeTopicName(" Proof-by-Induction ")).not.toBe(
      normalizeTopicName("Proof by Induction"),
    );
    await expect(
      db().learningTopic.count({ where: { courseId: course.id } }),
    ).resolves.toBe(3);
  });

  it("maps a question to multiple deduplicated topics", async () => {
    const course = await createCourse(owner.id, "MAPPING");
    const { question } = await createQuestion({
      userId: owner.id,
      courseId: course.id,
    });
    await db().$transaction((transaction) =>
      mapQuestionToTopics(transaction, {
        userId: owner.id,
        courseId: course.id,
        questionId: question.id,
        topicNames: [
          "Recursion",
          " recursion ",
          "Mathematical Induction",
        ],
      }),
    );

    const mappings = await db().quizQuestionTopic.findMany({
      where: { questionId: question.id, userId: owner.id },
      include: { topic: true },
      orderBy: { topic: { normalizedName: "asc" } },
    });
    expect(mappings.map(({ topic }) => topic.normalizedName)).toEqual([
      "mathematical induction",
      "recursion",
    ]);
  });

  it("infers a course only from an unambiguous exact topic set", async () => {
    const primary = await createCourse(owner.id, "RESOLVE-A");
    const secondary = await createCourse(owner.id, "RESOLVE-B");
    await createLearningTopic({
      userId: owner.id,
      courseId: primary.id,
      name: "Shared Topic",
    });
    await createLearningTopic({
      userId: owner.id,
      courseId: primary.id,
      name: "Unique Companion",
    });
    await createLearningTopic({
      userId: owner.id,
      courseId: secondary.id,
      name: "Shared Topic",
    });

    await expect(
      resolveLearningCourseId({
        userId: owner.id,
        topicNames: ["shared topic", " Unique   Companion "],
      }),
    ).resolves.toBe(primary.id);
    await expect(
      resolveLearningCourseId({
        userId: owner.id,
        topicNames: ["Shared Topic"],
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveLearningCourseId({
        userId: other.id,
        topicNames: ["Shared Topic", "Unique Companion"],
      }),
    ).resolves.toBeUndefined();
  });

  it("updates persisted progress after correct and incorrect evaluations", async () => {
    const course = await createCourse(owner.id, "UPDATES");
    const { quiz, question } = await createQuestion({
      userId: owner.id,
      courseId: course.id,
      topicNames: ["Graph Traversal"],
    });
    const correct = await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: question.id,
      score: 1,
      correct: true,
      attemptedAt: dateBefore(1),
    });
    const topic = await db().learningTopic.findFirstOrThrow({
      where: { userId: owner.id, courseId: course.id },
    });
    const afterCorrect = await db().learningProgress.findUniqueOrThrow({
      where: {
        userId_courseId_topicId: {
          userId: owner.id,
          courseId: course.id,
          topicId: topic.id,
        },
      },
    });

    expect(correct.completed).toBe(true);
    expect(afterCorrect).toMatchObject({
      questionsAttempted: 1,
      correctAnswers: 1,
      incorrectAnswers: 0,
      masteryScore: 63,
      confidenceScore: 12,
    });

    await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: question.id,
      score: 0,
      correct: false,
      attemptedAt: NOW,
    });
    const afterIncorrect = await db().learningProgress.findUniqueOrThrow({
      where: {
        userId_courseId_topicId: {
          userId: owner.id,
          courseId: course.id,
          topicId: topic.id,
        },
      },
    });
    expect(afterIncorrect).toMatchObject({
      questionsAttempted: 2,
      correctAnswers: 1,
      incorrectAnswers: 1,
      practiceSessions: 2,
    });
    expect(afterIncorrect.masteryScore).toBeLessThan(
      afterCorrect.masteryScore,
    );
  });

  it("contributes one result equally to every topic on a multi-topic question", async () => {
    const course = await createCourse(owner.id, "MULTI");
    const { quiz, question } = await createQuestion({
      userId: owner.id,
      courseId: course.id,
      topicNames: ["Recursion", "Mathematical Induction"],
      difficulty: "HARD",
    });
    const result = await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: question.id,
      score: 1,
      correct: true,
      attemptedAt: NOW,
    });
    const progress = await db().learningProgress.findMany({
      where: { userId: owner.id, courseId: course.id },
      include: { topic: true },
      orderBy: { topic: { normalizedName: "asc" } },
    });

    expect(result.updatedTopicIds).toHaveLength(2);
    expect(progress.map(({ topic }) => topic.normalizedName)).toEqual([
      "mathematical induction",
      "recursion",
    ]);
    expect(
      progress.every(
        (item) =>
          item.questionsAttempted === 1 &&
          item.correctAnswers === 1 &&
          item.difficultyWeightedScore === 1.2 &&
          item.difficultyWeightTotal === 1.2,
      ),
    ).toBe(true);
  });

  it("serializes concurrent grading into one session without losing evidence", async () => {
    const course = await createCourse(owner.id, "CONCURRENT");
    const quiz = await db().quiz.create({
      data: {
        userId: owner.id,
        courseId: course.id,
        title: "Concurrent grading",
        difficulty: "MEDIUM",
        questions: {
          create: [0, 1].map((position) => ({
            position,
            type: "SHORT_ANSWER" as const,
            prompt: `Concurrent question ${position}`,
            correctAnswer: "Expected",
            explanation: "Explanation",
            topicNames: ["Concurrency Topic"],
          })),
        },
      },
      include: { questions: { orderBy: { position: "asc" } } },
    });

    const [first, second] = await Promise.all([
      record({
        userId: owner.id,
        quizId: quiz.id,
        questionId: quiz.questions[0].id,
        score: 1,
        correct: true,
        attemptedAt: NOW,
      }),
      record({
        userId: owner.id,
        quizId: quiz.id,
        questionId: quiz.questions[1].id,
        score: 0,
        correct: false,
        attemptedAt: NOW,
      }),
    ]);

    expect(first.quizAttemptId).toBe(second.quizAttemptId);
    const progress = await db().learningProgress.findFirstOrThrow({
      where: { userId: owner.id, courseId: course.id },
    });
    expect(progress).toMatchObject({
      questionsAttempted: 2,
      correctAnswers: 1,
      incorrectAnswers: 1,
      practiceSessions: 1,
    });
  });

  it("deduplicates simultaneous final-answer submissions without inflating evidence or recency", async () => {
    const course = await createCourse(owner.id, "REPLAY");
    const { quiz, question } = await createQuestion({ userId: owner.id, courseId: course.id, topicNames: ["Replay evidence"] });
    const submission = { userId: owner.id, quizId: quiz.id, questionId: question.id, score: 1, correct: true, attemptedAt: NOW };
    const results = await Promise.all([record(submission), record(submission), record(submission)]);
    expect(new Set(results.map((result) => result.quizAttemptId)).size).toBe(1);
    expect(new Set(results.map((result) => result.questionAttemptId)).size).toBe(1);
    const before = await db().learningProgress.findFirstOrThrow({ where: { userId: owner.id, courseId: course.id } });
    expect(before).toMatchObject({ questionsAttempted: 1, practiceSessions: 1 });
    await record({ ...submission, attemptedAt: new Date(NOW.getTime() + DAY) });
    expect(await db().learningProgress.findFirstOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await db().questionAttempt.findUniqueOrThrow({ where: { id: results[0].questionAttemptId } }))
      .toMatchObject({ attemptedAt: NOW });
    const retake = await record({ ...submission, startNewAttempt: true, attemptedAt: new Date(NOW.getTime() + DAY) });
    expect(retake.quizAttemptId).not.toBe(results[0].quizAttemptId);
    expect(await db().learningProgress.findFirstOrThrow({ where: { id: before.id } }))
      .toMatchObject({ questionsAttempted: 2, practiceSessions: 2 });
  });

  it("supports an intentional new session instead of reusing an abandoned attempt", async () => {
    const course = await createCourse(owner.id, "RETAKE");
    const quiz = await db().quiz.create({
      data: {
        userId: owner.id,
        courseId: course.id,
        title: "Retake sessions",
        difficulty: "MEDIUM",
        questions: {
          create: [0, 1].map((position) => ({
            position,
            type: "SHORT_ANSWER" as const,
            prompt: `Retake question ${position}`,
            correctAnswer: "Expected",
            explanation: "Explanation",
            topicNames: ["Retake Topic"],
          })),
        },
      },
      include: { questions: { orderBy: { position: "asc" } } },
    });
    const first = await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: quiz.questions[0].id,
      score: 0,
      correct: false,
    });
    const retake = await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: quiz.questions[0].id,
      startNewAttempt: true,
      score: 1,
      correct: true,
    });

    expect(retake.quizAttemptId).not.toBe(first.quizAttemptId);
    await expect(
      db().learningProgress.findFirstOrThrow({
        where: { userId: owner.id, courseId: course.id },
      }),
    ).resolves.toMatchObject({ questionsAttempted: 2, practiceSessions: 2 });
  });

  it("falls back to the quiz topic for old questions without topic metadata", async () => {
    const course = await createCourse(owner.id, "FALLBACK");
    const { quiz, question } = await createQuestion({
      userId: owner.id,
      courseId: course.id,
      topic: "Legacy Topic",
      topicNames: [],
    });
    const result = await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: question.id,
      score: 1,
      correct: true,
    });

    expect(result.updatedTopicIds).toHaveLength(1);
    await expect(
      db().learningTopic.findFirst({
        where: {
          userId: owner.id,
          courseId: course.id,
          normalizedName: "legacy topic",
        },
      }),
    ).resolves.not.toBeNull();
  });

  it("rebuilds from canonical answers when a deleted topic is recreated", async () => {
    const course = await createCourse(owner.id, "RECREATE");
    const { quiz, question } = await createQuestion({
      userId: owner.id,
      courseId: course.id,
      topicNames: ["Recreated Topic"],
    });
    const first = await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: question.id,
      score: 1,
      correct: true,
    });
    await db().learningTopic.deleteMany({
      where: { userId: owner.id, courseId: course.id },
    });

    await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: question.id,
      quizAttemptId: first.quizAttemptId,
      score: 1,
      correct: true,
    });

    const rebuilt = await db().learningProgress.findFirstOrThrow({
      where: { userId: owner.id, courseId: course.id },
    });
    expect(rebuilt).toMatchObject({
      questionsAttempted: 1,
      correctAnswers: 1,
      incorrectAnswers: 0,
      practiceSessions: 1,
    });
  });

  it("retrieves reliable weak and strong topics and ranks deterministic recommendations", async () => {
    const course = await createCourse(owner.id, "RANKING");
    const weak = await createLearningTopic({
      userId: owner.id,
      courseId: course.id,
      name: "Weak Concept",
    });
    const strong = await createLearningTopic({
      userId: owner.id,
      courseId: course.id,
      name: "Strong Concept",
    });
    const limited = await createLearningTopic({
      userId: owner.id,
      courseId: course.id,
      name: "Limited Evidence",
    });
    const staleStrong = await createLearningTopic({
      userId: owner.id,
      courseId: course.id,
      name: "Stale Strong Concept",
    });
    await createLearningTopic({
      userId: owner.id,
      courseId: course.id,
      name: "Unpracticed Concept",
    });
    await seedProgress({
      userId: owner.id,
      courseId: course.id,
      topicId: weak.id,
      mastery: 30,
      confidence: 70,
      recentAccuracy: 20,
      attempted: 10,
      correct: 2,
      sessions: 3,
      firstPracticedAt: dateBefore(14),
      lastPracticedAt: NOW,
    });
    await seedProgress({
      userId: owner.id,
      courseId: course.id,
      topicId: staleStrong.id,
      mastery: 95,
      confidence: 90,
      recentAccuracy: 95,
      attempted: 20,
      correct: 19,
      sessions: 5,
      firstPracticedAt: dateBefore(400),
      lastPracticedAt: dateBefore(365),
    });
    await seedProgress({
      userId: owner.id,
      courseId: course.id,
      topicId: strong.id,
      mastery: 90,
      confidence: 75,
      recentAccuracy: 90,
      attempted: 15,
      correct: 14,
      sessions: 4,
      firstPracticedAt: dateBefore(21),
      lastPracticedAt: NOW,
    });
    await seedProgress({
      userId: owner.id,
      courseId: course.id,
      topicId: limited.id,
      mastery: 10,
      confidence: 12,
      recentAccuracy: 0,
      attempted: 1,
      correct: 0,
      sessions: 1,
      firstPracticedAt: NOW,
      lastPracticedAt: NOW,
    });

    const weakTopics = await getWeakTopics({
      userId: owner.id,
      courseId: course.id,
      now: NOW,
    });
    const strongTopics = await getStrongTopics({
      userId: owner.id,
      courseId: course.id,
      now: NOW,
    });
    const recommendations = await getRecommendedPracticeTopics({
      userId: owner.id,
      courseId: course.id,
      upcomingTopicNames: [" unpracticed concept "],
      now: NOW,
    });

    expect(weakTopics.map((topic) => topic.topic)).toEqual(["Weak Concept"]);
    expect(strongTopics.map((topic) => topic.topic)).toEqual([
      "Strong Concept",
    ]);
    expect(recommendations[0]).toMatchObject({
      topic: "Unpracticed Concept",
      status: "unpracticed",
      evidence: "limited",
      reasons: expect.arrayContaining(["unpracticed", "upcoming-need"]),
    });
    expect(weakTopics).not.toContainEqual(
      expect.objectContaining({ topic: "Limited Evidence" }),
    );
    expect(recommendations).toContainEqual(
      expect.objectContaining({
        topic: "Stale Strong Concept",
        reasons: expect.arrayContaining(["stale-practice"]),
      }),
    );

    const context = await buildUserContext(
      {
        request: "Help me practice my weak topics",
        courseId: course.id,
        options: { learning: true, limits: { learning: 2 } },
      },
      owner.headers,
    );
    expect(context.learning?.weakTopics).toEqual([
      expect.objectContaining({ topic: "Weak Concept", mastery: 30 }),
    ]);
    expect(context.learning?.strongTopics).toEqual([
      expect.objectContaining({ topic: "Strong Concept", mastery: 90 }),
    ]);
    expect(context.learning?.recommendedTopics.length).toBeLessThanOrEqual(2);
    expect(context.metadata.unavailableCategories).not.toContain("learning");
  });

  it("rebuilds only affected progress after an attempt is deleted", async () => {
    const course = await createCourse(owner.id, "DELETE");
    const { quiz, question } = await createQuestion({
      userId: owner.id,
      courseId: course.id,
      topicNames: ["Deletion Rebuild"],
    });
    const correct = await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: question.id,
      score: 1,
      correct: true,
      attemptedAt: dateBefore(1),
    });
    const incorrect = await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: question.id,
      score: 0,
      correct: false,
      attemptedAt: NOW,
    });
    const topic = await db().learningTopic.findFirstOrThrow({
      where: { userId: owner.id, courseId: course.id },
    });

    await deleteQuizAttempt({
      userId: owner.id,
      attemptId: incorrect.quizAttemptId,
      now: NOW,
    });
    const rebuilt = await db().learningProgress.findUniqueOrThrow({
      where: {
        userId_courseId_topicId: {
          userId: owner.id,
          courseId: course.id,
          topicId: topic.id,
        },
      },
    });
    expect(rebuilt).toMatchObject({
      questionsAttempted: 1,
      correctAnswers: 1,
      incorrectAnswers: 0,
      scoreTotal: 1,
      difficultyWeightedScore: 1,
      difficultyWeightTotal: 1,
      practiceSessions: 1,
    });

    await deleteQuizAttempt({
      userId: owner.id,
      attemptId: correct.quizAttemptId,
      now: NOW,
    });
    await expect(
      db().learningProgress.findUnique({
        where: {
          userId_courseId_topicId: {
            userId: owner.id,
            courseId: course.id,
            topicId: topic.id,
          },
        },
      }),
    ).resolves.toBeNull();
  });

  it("enforces ownership across courses, answers, attempts and queries", async () => {
    const ownerCourse = await createCourse(owner.id, "OWNER");
    const otherCourse = await createCourse(other.id, "OTHER");
    const { quiz, question } = await createQuestion({
      userId: owner.id,
      courseId: ownerCourse.id,
      topicNames: ["Private Topic"],
    });
    const recorded = await record({
      userId: owner.id,
      quizId: quiz.id,
      questionId: question.id,
      score: 0,
      correct: false,
    });

    await expect(
      createLearningTopic({
        userId: other.id,
        courseId: ownerCourse.id,
        name: "Stolen Topic",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      record({
        userId: other.id,
        quizId: quiz.id,
        questionId: question.id,
        score: 1,
        correct: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      deleteQuizAttempt({
        userId: other.id,
        attemptId: recorded.quizAttemptId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getRecommendedPracticeTopics({
        userId: other.id,
        courseId: ownerCourse.id,
      }),
    ).resolves.toEqual([]);
    await expect(
      getWeakTopics({ userId: other.id, courseId: otherCourse.id }),
    ).resolves.toEqual([]);
  });
});
