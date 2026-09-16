import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db/client";
import {
  calculateLearningFreshness,
  calculateLearningMetrics,
  difficultyWeight,
  learningStatus,
} from "./calculations";
import {
  LEARNING_CONFIG,
  MILLISECONDS_PER_DAY,
} from "./constants";
import { normalizeTopicName, prepareTopicNames } from "./normalization";
import type {
  LearningAggregate,
  LearningAttemptEvidence,
  LearningDifficulty,
  LearningOverview,
  LearningTopicQuery,
  LearningTopicSummary,
  RecommendedPracticeQuery,
  RecommendedPracticeTopic,
} from "./types";

type Transaction = Prisma.TransactionClient;
type DatabaseDifficulty = "EASY" | "MEDIUM" | "HARD";
type DatabaseTrend =
  | "IMPROVING"
  | "STABLE"
  | "DECLINING"
  | "INSUFFICIENT_DATA";
type MutableLearningAggregate = {
  -readonly [Key in keyof LearningAggregate]: LearningAggregate[Key];
} & { correctAnswers: number; incorrectAnswers: number };

const trendToDatabase = {
  improving: "IMPROVING",
  stable: "STABLE",
  declining: "DECLINING",
  "insufficient-data": "INSUFFICIENT_DATA",
} as const satisfies Record<string, DatabaseTrend>;
const trendFromDatabase = {
  IMPROVING: "improving",
  STABLE: "stable",
  DECLINING: "declining",
  INSUFFICIENT_DATA: "insufficient-data",
} as const;

const querySchema = z
  .object({
    userId: z.string().min(1).max(100),
    courseId: z.string().min(1).max(100).optional(),
    topicId: z.string().min(1).max(100).optional(),
    semester: z.string().min(1).max(80).optional(),
    examTopicNames: z.array(z.string().min(1).max(120)).max(100).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LEARNING_CONFIG.maximumListLimit)
      .optional(),
    now: z.date().optional(),
  })
  .strict();

const recommendedQuerySchema = querySchema.extend({
  upcomingTopicNames: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(LEARNING_CONFIG.maximumTopicNameLength),
    )
    .max(20)
    .optional(),
});

const recordSchema = z
  .object({
    userId: z.string().min(1).max(100),
    quizId: z.string().min(1).max(100),
    questionId: z.string().min(1).max(100),
    quizAttemptId: z.string().min(1).max(100).optional(),
    startNewAttempt: z.boolean().optional(),
    userAnswer: z.string().trim().min(1).max(4000),
    score: z.number().min(0).max(1),
    correct: z.boolean(),
    method: z.enum(["deterministic", "semantic"]),
    attemptedAt: z.date().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quizAttemptId && value.startNewAttempt) {
      context.addIssue({
        code: "custom",
        path: ["startNewAttempt"],
        message: "A saved attempt and a new attempt cannot both be selected.",
      });
    }
  });

const topicSchema = z
  .object({
    userId: z.string().min(1).max(100),
    courseId: z.string().min(1).max(100),
    name: z
      .string()
      .trim()
      .min(1)
      .max(LEARNING_CONFIG.maximumTopicNameLength),
    description: z.string().trim().max(1000).optional(),
  })
  .strict();

const courseResolutionSchema = z
  .object({
    userId: z.string().min(1).max(100),
    topicNames: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(LEARNING_CONFIG.maximumTopicNameLength),
      )
      .min(1)
      .max(100),
  })
  .strict();

const deletionSchema = z
  .object({
    userId: z.string().min(1).max(100),
    attemptId: z.string().min(1).max(100),
    now: z.date().optional(),
  })
  .strict();

export type LearningServiceErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "STORAGE_FAILURE";

const errorMessages: Record<LearningServiceErrorCode, string> = {
  INVALID_REQUEST: "Check the learning data request.",
  NOT_FOUND: "The requested learning record was not found.",
  STORAGE_FAILURE: "Learning progress could not be updated or loaded.",
};

export class LearningServiceError extends Error {
  constructor(readonly code: LearningServiceErrorCode) {
    super(errorMessages[code]);
    this.name = "LearningServiceError";
  }
}

function learningDifficulty(
  difficulty: DatabaseDifficulty | string | null | undefined,
): LearningDifficulty {
  if (difficulty === "EASY") return "easy";
  if (difficulty === "HARD") return "hard";
  return "medium";
}

function daysSince(date: string | null, now: Date): number {
  if (!date) return 365;
  return Math.max(
    0,
    (now.getTime() - new Date(date).getTime()) / MILLISECONDS_PER_DAY,
  );
}

type TopicStateRow = {
  id: string;
  name: string;
  courseId: string;
  course: { courseCode: string; courseName: string };
  progress: null | {
    masteryScore: number;
    confidenceScore: number;
    recentAccuracy: number;
    questionsAttempted: number;
    practiceSessions: number;
    trend: DatabaseTrend;
    lastPracticedAt: Date | null;
  };
};

function summary(row: TopicStateRow, now: Date): LearningTopicSummary {
  const progress = row.progress;
  const attempted = Boolean(progress?.questionsAttempted);
  const freshness = calculateLearningFreshness(
    progress?.lastPracticedAt ?? null,
    now,
  );
  const mastery = attempted
    ? Math.round(
        Math.max(
          0,
          Math.min(100, progress!.masteryScore - freshness.masteryPenalty),
        ),
      )
    : 50;
  const confidence = attempted
    ? Math.round(
        Math.max(
          0,
          Math.min(
            100,
            progress!.confidenceScore * freshness.confidenceMultiplier,
          ),
        ),
      )
    : 0;
  return {
    id: row.id,
    topic: row.name,
    courseId: row.courseId,
    courseCode: row.course.courseCode,
    courseName: row.course.courseName,
    mastery,
    confidence,
    recentAccuracy: attempted ? Math.round(progress!.recentAccuracy) : 50,
    questionsAttempted: progress?.questionsAttempted ?? 0,
    practiceSessions: progress?.practiceSessions ?? 0,
    trend: progress
      ? trendFromDatabase[progress.trend]
      : "insufficient-data",
    lastPracticedAt: progress?.lastPracticedAt?.toISOString() ?? null,
    status: learningStatus(mastery, attempted),
    evidence:
      confidence >= LEARNING_CONFIG.weakConfidenceMinimum
        ? "sufficient"
        : "limited",
  };
}

function weakPriority(topic: LearningTopicSummary, now: Date): number {
  const masteryGap = (100 - topic.mastery) / 100;
  const recentError = (100 - topic.recentAccuracy) / 100;
  const staleness = Math.min(daysSince(topic.lastPracticedAt, now) / 90, 1);
  return (
    0.55 * masteryGap +
    0.2 * recentError +
    0.15 * staleness +
    0.1 * (topic.confidence / 100)
  );
}

function recommendation(
  topic: LearningTopicSummary,
  now: Date,
  upcoming: ReadonlySet<string>,
): RecommendedPracticeTopic {
  const unpracticed = topic.questionsAttempted === 0;
  const masteryGap = unpracticed ? 0.5 : (100 - topic.mastery) / 100;
  const recentGap = unpracticed
    ? 0.5
    : (100 - topic.recentAccuracy) / 100;
  const staleness = Math.min(daysSince(topic.lastPracticedAt, now) / 90, 1);
  const confidenceGap = (100 - topic.confidence) / 100;
  const upcomingNeed = upcoming.has(normalizeTopicName(topic.topic)) ? 1 : 0;
  const priority = Math.round(
    100 *
      (0.4 * masteryGap +
        0.2 * recentGap +
        0.15 * staleness +
        0.15 * confidenceGap +
        0.1 * upcomingNeed),
  );
  const reasons: RecommendedPracticeTopic["reasons"][number][] = [];
  if (unpracticed) reasons.push("unpracticed");
  else {
    if (topic.mastery < 70) reasons.push("low-mastery");
    if (topic.recentAccuracy < 70)
      reasons.push("low-recent-performance");
  }
  if (staleness >= 0.5) reasons.push("stale-practice");
  if (topic.confidence < 60) reasons.push("low-confidence");
  if (upcomingNeed) reasons.push("upcoming-need");
  return { ...topic, priority, reasons };
}

async function loadStates(
  query: LearningTopicQuery,
): Promise<{ states: LearningTopicSummary[]; limit: number; now: Date }> {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new LearningServiceError("INVALID_REQUEST");
  const limit = parsed.data.limit ?? LEARNING_CONFIG.defaultListLimit;
  const now = parsed.data.now ?? new Date();
  try {
    const rows = await db().learningTopic.findMany({
      where: {
        userId: parsed.data.userId,
        ...(parsed.data.topicId ? { id: parsed.data.topicId } : {}),
        course: {
          userId: parsed.data.userId,
          ...(parsed.data.semester ? { semester: parsed.data.semester } : {}),
        },
        ...(parsed.data.courseId
          ? { courseId: parsed.data.courseId }
          : {}),
      },
      select: {
        id: true,
        name: true,
        courseId: true,
        course: { select: { courseCode: true, courseName: true } },
        progress: {
          select: {
            masteryScore: true,
            confidenceScore: true,
            recentAccuracy: true,
            questionsAttempted: true,
            practiceSessions: true,
            trend: true,
            lastPracticedAt: true,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });
    return { states: rows.map((row) => summary(row, now)), limit, now };
  } catch (error) {
    if (error instanceof LearningServiceError) throw error;
    throw new LearningServiceError("STORAGE_FAILURE");
  }
}

export async function createLearningTopic(input: {
  readonly userId: string;
  readonly courseId: string;
  readonly name: string;
  readonly description?: string;
}) {
  const parsed = topicSchema.safeParse(input);
  if (!parsed.success) throw new LearningServiceError("INVALID_REQUEST");
  const normalizedName = normalizeTopicName(parsed.data.name);
  try {
    const course = await db().course.findUnique({
      where: {
        id_userId: {
          id: parsed.data.courseId,
          userId: parsed.data.userId,
        },
      },
      select: { id: true },
    });
    if (!course) throw new LearningServiceError("NOT_FOUND");
    return await db().learningTopic.upsert({
      where: {
        userId_courseId_normalizedName: {
          userId: parsed.data.userId,
          courseId: parsed.data.courseId,
          normalizedName,
        },
      },
      create: {
        userId: parsed.data.userId,
        courseId: parsed.data.courseId,
        name: parsed.data.name,
        normalizedName,
        description: parsed.data.description,
      },
      update: parsed.data.description
        ? { description: parsed.data.description }
        : {},
    });
  } catch (error) {
    if (error instanceof LearningServiceError) throw error;
    throw new LearningServiceError("STORAGE_FAILURE");
  }
}

export async function resolveLearningCourseId(input: {
  readonly userId: string;
  readonly topicNames: readonly string[];
}): Promise<string | undefined> {
  const parsed = courseResolutionSchema.safeParse(input);
  if (!parsed.success) throw new LearningServiceError("INVALID_REQUEST");
  const names = [
    ...new Set(parsed.data.topicNames.map((name) => normalizeTopicName(name))),
  ];
  try {
    const topics = await db().learningTopic.findMany({
      where: {
        userId: parsed.data.userId,
        normalizedName: { in: names },
        course: { userId: parsed.data.userId },
      },
      select: { courseId: true, normalizedName: true },
    });
    const matches = new Map<string, Set<string>>();
    for (const topic of topics) {
      const courseTopics = matches.get(topic.courseId) ?? new Set<string>();
      courseTopics.add(topic.normalizedName);
      matches.set(topic.courseId, courseTopics);
    }
    const completeMatches = [...matches].filter(([, courseTopics]) =>
      names.every((name) => courseTopics.has(name)),
    );
    return completeMatches.length === 1 ? completeMatches[0][0] : undefined;
  } catch {
    throw new LearningServiceError("STORAGE_FAILURE");
  }
}

export async function mapQuestionToTopics(
  transaction: Transaction,
  input: {
    readonly userId: string;
    readonly courseId: string;
    readonly questionId: string;
    readonly topicNames: readonly string[];
  },
) {
  const question = await transaction.quizQuestion.findFirst({
    where: {
      id: input.questionId,
      userId: input.userId,
      quiz: {
        userId: input.userId,
        courseId: input.courseId,
      },
    },
    select: { id: true },
  });
  if (!question) throw new LearningServiceError("NOT_FOUND");
  const topics = prepareTopicNames(input.topicNames);
  const saved = [];
  for (const topic of topics) {
    const row = await transaction.learningTopic.upsert({
      where: {
        userId_courseId_normalizedName: {
          userId: input.userId,
          courseId: input.courseId,
          normalizedName: topic.normalizedName,
        },
      },
      create: {
        userId: input.userId,
        courseId: input.courseId,
        name: topic.name,
        normalizedName: topic.normalizedName,
      },
      update: {},
    });
    await transaction.quizQuestionTopic.upsert({
      where: {
        questionId_topicId: {
          questionId: input.questionId,
          topicId: row.id,
        },
      },
      create: {
        questionId: input.questionId,
        topicId: row.id,
        userId: input.userId,
        courseId: input.courseId,
      },
      update: {},
    });
    saved.push(row);
  }
  return saved;
}

export async function mapQuizQuestionsToTopics(
  transaction: Transaction,
  input: {
    readonly userId: string;
    readonly courseId: string;
    readonly questions: readonly {
      readonly id: string;
      readonly topicNames: readonly string[];
    }[];
  },
): Promise<void> {
  const questionIds = [...new Set(input.questions.map(({ id }) => id))];
  if (!questionIds.length) return;
  const ownedQuestions = await transaction.quizQuestion.count({
    where: {
      id: { in: questionIds },
      userId: input.userId,
      quiz: {
        userId: input.userId,
        courseId: input.courseId,
      },
    },
  });
  if (ownedQuestions !== questionIds.length)
    throw new LearningServiceError("NOT_FOUND");
  const prepared = input.questions.map((question) => ({
    id: question.id,
    topics: prepareTopicNames(question.topicNames),
  }));
  const unique = new Map<
    string,
    { name: string; normalizedName: string }
  >();
  for (const question of prepared)
    for (const topic of question.topics)
      unique.set(topic.normalizedName, topic);

  const topicIds = new Map<string, string>();
  for (const topic of unique.values()) {
    const row = await transaction.learningTopic.upsert({
      where: {
        userId_courseId_normalizedName: {
          userId: input.userId,
          courseId: input.courseId,
          normalizedName: topic.normalizedName,
        },
      },
      create: {
        userId: input.userId,
        courseId: input.courseId,
        name: topic.name,
        normalizedName: topic.normalizedName,
      },
      update: {},
      select: { id: true },
    });
    topicIds.set(topic.normalizedName, row.id);
  }
  await transaction.quizQuestionTopic.createMany({
    data: prepared.flatMap((question) =>
      question.topics.map((topic) => ({
        questionId: question.id,
        topicId: topicIds.get(topic.normalizedName)!,
        userId: input.userId,
        courseId: input.courseId,
      })),
    ),
    skipDuplicates: true,
  });
}

async function ensureQuestionTopics(
  transaction: Transaction,
  question: {
    id: string;
    userId: string;
    topicNames: string[];
    quiz: { courseId: string | null; topic: string | null };
    topicMappings: { topic: { id: string; courseId: string } }[];
  },
) {
  if (question.topicMappings.length || !question.quiz.courseId) {
    return question.topicMappings.map((mapping) => mapping.topic);
  }
  const fallback = question.topicNames.length
    ? question.topicNames
    : question.quiz.topic
      ? [question.quiz.topic]
      : [];
  if (!fallback.length) return [];
  return mapQuestionToTopics(transaction, {
    userId: question.userId,
    courseId: question.quiz.courseId,
    questionId: question.id,
    topicNames: fallback,
  });
}

function evidenceFromRows(
  rows: readonly {
    id: string;
    score: number;
    isCorrect: boolean;
    attemptedAt: Date;
    quizAttemptId: string;
    question: { quiz: { difficulty: DatabaseDifficulty } };
  }[],
): LearningAttemptEvidence[] {
  return rows.map((row) => ({
    id: row.id,
    score: row.score,
    correct: row.isCorrect,
    attemptedAt: row.attemptedAt,
    sessionId: row.quizAttemptId,
    difficulty: learningDifficulty(row.question.quiz.difficulty),
  }));
}

async function recentEvidence(
  transaction: Transaction,
  userId: string,
  topicId: string,
) {
  const rows = await transaction.questionAttempt.findMany({
    where: {
      userId,
      question: {
        topicMappings: { some: { topicId, userId } },
      },
    },
    select: {
      id: true,
      score: true,
      isCorrect: true,
      attemptedAt: true,
      quizAttemptId: true,
      question: { select: { quiz: { select: { difficulty: true } } } },
    },
    orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
    take: LEARNING_CONFIG.trendWindow * 2,
  });
  return evidenceFromRows(rows);
}

function aggregateAfterAttempt(
  progress: {
    questionsAttempted: number;
    correctAnswers: number;
    incorrectAnswers: number;
    scoreTotal: number;
    difficultyWeightedScore: number;
    difficultyWeightTotal: number;
    practiceSessions: number;
    easyAttempts: number;
    mediumAttempts: number;
    hardAttempts: number;
    firstPracticedAt: Date | null;
    lastPracticedAt: Date | null;
  } | null,
  input: {
    score: number;
    correct: boolean;
    difficulty: LearningDifficulty;
    attemptedAt: Date;
    sessionIsNew: boolean;
    previous: { score: number; isCorrect: boolean } | null;
  },
): LearningAggregate & { correctAnswers: number; incorrectAnswers: number } {
  const previous = input.previous;
  const countDelta = previous ? 0 : 1;
  const weight = difficultyWeight(input.difficulty);
  const first = progress?.firstPracticedAt;
  const last = progress?.lastPracticedAt;
  const result = {
    questionsAttempted: (progress?.questionsAttempted ?? 0) + countDelta,
    correctAnswers:
      (progress?.correctAnswers ?? 0) +
      (input.correct ? 1 : 0) -
      (previous?.isCorrect ? 1 : 0),
    incorrectAnswers:
      (progress?.incorrectAnswers ?? 0) +
      (input.correct ? 0 : 1) -
      (previous && !previous.isCorrect ? 1 : 0),
    scoreTotal:
      (progress?.scoreTotal ?? 0) + input.score - (previous?.score ?? 0),
    difficultyWeightedScore:
      (progress?.difficultyWeightedScore ?? 0) +
      (input.score - (previous?.score ?? 0)) * weight,
    difficultyWeightTotal:
      (progress?.difficultyWeightTotal ?? 0) + countDelta * weight,
    practiceSessions:
      (progress?.practiceSessions ?? 0) + (input.sessionIsNew ? 1 : 0),
    easyAttempts:
      (progress?.easyAttempts ?? 0) +
      (countDelta && input.difficulty === "easy" ? 1 : 0),
    mediumAttempts:
      (progress?.mediumAttempts ?? 0) +
      (countDelta && input.difficulty === "medium" ? 1 : 0),
    hardAttempts:
      (progress?.hardAttempts ?? 0) +
      (countDelta && input.difficulty === "hard" ? 1 : 0),
    firstPracticedAt:
      !first || input.attemptedAt < first ? input.attemptedAt : first,
    lastPracticedAt:
      !last || input.attemptedAt > last ? input.attemptedAt : last,
  };
  return result;
}

async function saveProgress(
  transaction: Transaction,
  input: {
    userId: string;
    courseId: string;
    topicId: string;
    aggregate: LearningAggregate & {
      correctAnswers: number;
      incorrectAnswers: number;
    };
    recentAttempts: readonly LearningAttemptEvidence[];
    now: Date;
  },
) {
  const metrics = calculateLearningMetrics({
    aggregate: input.aggregate,
    recentAttempts: input.recentAttempts,
    // Persist the estimate at its latest evidence date. Query-time freshness
    // then ages mastery/confidence without replaying historical attempts.
    now: input.aggregate.lastPracticedAt ?? input.now,
  });
  const values = {
    ...input.aggregate,
    masteryScore: metrics.mastery,
    confidenceScore: metrics.confidence,
    recentAccuracy: metrics.recentAccuracy,
    trend: trendToDatabase[metrics.trend],
  };
  return transaction.learningProgress.upsert({
    where: {
      userId_courseId_topicId: {
        userId: input.userId,
        courseId: input.courseId,
        topicId: input.topicId,
      },
    },
    create: {
      userId: input.userId,
      courseId: input.courseId,
      topicId: input.topicId,
      ...values,
    },
    update: values,
  });
}

async function lockLearningUpdates(
  transaction: Transaction,
  userId: string,
): Promise<void> {
  // Quiz answers can arrive concurrently. A transaction-scoped PostgreSQL
  // advisory lock prevents split sessions and lost read/modify/write updates
  // while still allowing different students to grade answers in parallel.
  await transaction.$queryRaw`
    SELECT 1 AS "locked"
    FROM pg_advisory_xact_lock(
      hashtext('learning-progress'),
      hashtext(${userId})
    )
  `;
}

export async function recordQuestionEvaluation(rawInput: {
  readonly userId: string;
  readonly quizId: string;
  readonly questionId: string;
  readonly quizAttemptId?: string;
  readonly startNewAttempt?: boolean;
  readonly userAnswer: string;
  readonly score: number;
  readonly correct: boolean;
  readonly method: "deterministic" | "semantic";
  readonly attemptedAt?: Date;
}) {
  const parsed = recordSchema.safeParse(rawInput);
  if (!parsed.success) throw new LearningServiceError("INVALID_REQUEST");
  try {
    return await db().$transaction(async (transaction) => {
      const input = parsed.data;
      const attemptedAt = input.attemptedAt ?? new Date();
      await lockLearningUpdates(transaction, input.userId);
      const question = await transaction.quizQuestion.findFirst({
        where: {
          id: input.questionId,
          quizId: input.quizId,
          userId: input.userId,
          quiz: { userId: input.userId },
        },
        include: {
          quiz: {
            select: {
              courseId: true,
              topic: true,
              difficulty: true,
            },
          },
          topicMappings: { include: { topic: true } },
        },
      });
      if (!question) throw new LearningServiceError("NOT_FOUND");
      const topics = await ensureQuestionTopics(transaction, question);

      let quizAttempt = input.quizAttemptId
        ? await transaction.quizAttempt.findFirst({
            where: {
              id: input.quizAttemptId,
              quizId: input.quizId,
              userId: input.userId,
              quiz: { userId: input.userId },
            },
          })
        : input.startNewAttempt
          ? null
          : await transaction.quizAttempt.findFirst({
            where: {
              quizId: input.quizId,
              userId: input.userId,
              completedAt: null,
              quiz: { userId: input.userId },
            },
            orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          });
      if (input.quizAttemptId && !quizAttempt)
        throw new LearningServiceError("NOT_FOUND");
      quizAttempt ??= await transaction.quizAttempt.create({
        data: {
          userId: input.userId,
          quizId: input.quizId,
          startedAt: attemptedAt,
        },
      });

      const previous = await transaction.questionAttempt.findUnique({
        where: {
          quizAttemptId_questionId: {
            quizAttemptId: quizAttempt.id,
            questionId: question.id,
          },
        },
        select: { score: true, isCorrect: true },
      });
      const sessions = new Map<string, boolean>();
      for (const topic of topics) {
        const priorInSession = await transaction.questionAttempt.count({
          where: {
            quizAttemptId: quizAttempt.id,
            userId: input.userId,
            question: {
              topicMappings: {
                some: { topicId: topic.id, userId: input.userId },
              },
            },
          },
        });
        sessions.set(topic.id, priorInSession > 0);
      }

      const questionAttempt = await transaction.questionAttempt.upsert({
        where: {
          quizAttemptId_questionId: {
            quizAttemptId: quizAttempt.id,
            questionId: question.id,
          },
        },
        create: {
          userId: input.userId,
          quizId: input.quizId,
          quizAttemptId: quizAttempt.id,
          questionId: question.id,
          userAnswer: input.userAnswer,
          score: input.score,
          isCorrect: input.correct,
          evaluationMethod:
            input.method === "deterministic" ? "DETERMINISTIC" : "SEMANTIC",
          attemptedAt,
        },
        update: {
          userAnswer: input.userAnswer,
          score: input.score,
          isCorrect: input.correct,
          evaluationMethod:
            input.method === "deterministic" ? "DETERMINISTIC" : "SEMANTIC",
          attemptedAt,
        },
      });

      const difficulty = learningDifficulty(question.quiz.difficulty);
      for (const topic of topics) {
        const progress = await transaction.learningProgress.findUnique({
          where: {
            userId_courseId_topicId: {
              userId: input.userId,
              courseId: topic.courseId,
              topicId: topic.id,
            },
          },
        });
        if (!progress) {
          // Mappings or aggregates may have been removed independently while
          // canonical attempts remain. Rebuild this topic instead of applying
          // a delta to an empty aggregate.
          await rebuildTopicProgress(
            transaction,
            input.userId,
            topic.id,
            attemptedAt,
          );
          continue;
        }
        const aggregate = aggregateAfterAttempt(progress, {
          score: input.score,
          correct: input.correct,
          difficulty,
          attemptedAt,
          sessionIsNew: !previous && !sessions.get(topic.id),
          previous,
        });
        await saveProgress(transaction, {
          userId: input.userId,
          courseId: topic.courseId,
          topicId: topic.id,
          aggregate,
          recentAttempts: await recentEvidence(
            transaction,
            input.userId,
            topic.id,
          ),
          now: attemptedAt,
        });
      }

      const [answered, questionCount] = await Promise.all([
        transaction.questionAttempt.count({
          where: { quizAttemptId: quizAttempt.id, userId: input.userId },
        }),
        transaction.quizQuestion.count({
          where: { quizId: input.quizId, userId: input.userId },
        }),
      ]);
      if (!quizAttempt.completedAt && answered >= questionCount) {
        quizAttempt = await transaction.quizAttempt.update({
          where: { id: quizAttempt.id },
          data: { completedAt: attemptedAt },
        });
      }
      return {
        quizAttemptId: quizAttempt.id,
        questionAttemptId: questionAttempt.id,
        updatedTopicIds: topics.map((topic) => topic.id),
        completed: quizAttempt.completedAt !== null,
      };
    });
  } catch (error) {
    if (error instanceof LearningServiceError) throw error;
    throw new LearningServiceError("STORAGE_FAILURE");
  }
}

async function rebuildTopicProgress(
  transaction: Transaction,
  userId: string,
  topicId: string,
  now: Date,
) {
  const topic = await transaction.learningTopic.findFirst({
    where: { id: topicId, userId, course: { userId } },
    select: { id: true, courseId: true },
  });
  if (!topic) return;
  const rows = await transaction.questionAttempt.findMany({
    where: {
      userId,
      question: { topicMappings: { some: { topicId, userId } } },
    },
    select: {
      id: true,
      score: true,
      isCorrect: true,
      attemptedAt: true,
      quizAttemptId: true,
      question: { select: { quiz: { select: { difficulty: true } } } },
    },
    orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
  });
  if (!rows.length) {
    await transaction.learningProgress.deleteMany({
      where: { topicId, userId, courseId: topic.courseId },
    });
    return;
  }
  const attempts = evidenceFromRows(rows);
  const aggregate = attempts.reduce<MutableLearningAggregate>(
    (value, attempt) => {
      const weight = difficultyWeight(attempt.difficulty);
      value.questionsAttempted += 1;
      value.scoreTotal += attempt.score;
      value.difficultyWeightedScore += attempt.score * weight;
      value.difficultyWeightTotal += weight;
      value.correctAnswers += attempt.correct ? 1 : 0;
      value.incorrectAnswers += attempt.correct ? 0 : 1;
      if (attempt.difficulty === "easy") value.easyAttempts += 1;
      else if (attempt.difficulty === "hard") value.hardAttempts += 1;
      else value.mediumAttempts += 1;
      if (
        !value.firstPracticedAt ||
        attempt.attemptedAt < value.firstPracticedAt
      )
        value.firstPracticedAt = attempt.attemptedAt;
      if (
        !value.lastPracticedAt ||
        attempt.attemptedAt > value.lastPracticedAt
      )
        value.lastPracticedAt = attempt.attemptedAt;
      return value;
    },
    {
      questionsAttempted: 0,
      correctAnswers: 0,
      incorrectAnswers: 0,
      scoreTotal: 0,
      difficultyWeightedScore: 0,
      difficultyWeightTotal: 0,
      practiceSessions: new Set(
        attempts.map((attempt) => attempt.sessionId),
      ).size,
      easyAttempts: 0,
      mediumAttempts: 0,
      hardAttempts: 0,
      firstPracticedAt: null,
      lastPracticedAt: null,
    },
  );
  await saveProgress(transaction, {
    userId,
    courseId: topic.courseId,
    topicId,
    aggregate,
    recentAttempts: attempts.slice(0, LEARNING_CONFIG.trendWindow * 2),
    now,
  });
}

export async function deleteQuizAttempt(input: {
  readonly userId: string;
  readonly attemptId: string;
  readonly now?: Date;
}): Promise<void> {
  const parsed = deletionSchema.safeParse(input);
  if (!parsed.success) throw new LearningServiceError("INVALID_REQUEST");
  try {
    await db().$transaction(async (transaction) => {
      await lockLearningUpdates(transaction, parsed.data.userId);
      const attempt = await transaction.quizAttempt.findFirst({
        where: {
          id: parsed.data.attemptId,
          userId: parsed.data.userId,
          quiz: { userId: parsed.data.userId },
        },
        select: {
          id: true,
          questionAttempts: {
            select: {
              question: {
                select: {
                  topicMappings: { select: { topicId: true } },
                },
              },
            },
          },
        },
      });
      if (!attempt) throw new LearningServiceError("NOT_FOUND");
      const topicIds = new Set(
        attempt.questionAttempts.flatMap((questionAttempt) =>
          questionAttempt.question.topicMappings.map(
            (mapping) => mapping.topicId,
          ),
        ),
      );
      await transaction.quizAttempt.delete({ where: { id: attempt.id } });
      for (const topicId of topicIds) {
        await rebuildTopicProgress(
          transaction,
          parsed.data.userId,
          topicId,
          parsed.data.now ?? new Date(),
        );
      }
    });
  } catch (error) {
    if (error instanceof LearningServiceError) throw error;
    throw new LearningServiceError("STORAGE_FAILURE");
  }
}

/** Aggregate-only states for deterministic planning/recovery. Exact topicId
 * reads use the topic index; no historical attempts are replayed. */
export async function getLearningTopicStates(query: LearningTopicQuery): Promise<LearningTopicSummary[]> {
  return (await loadStates(query)).states;
}

export async function getWeakTopics(
  query: LearningTopicQuery,
): Promise<LearningTopicSummary[]> {
  const { states, limit, now } = await loadStates(query);
  return states
    .filter(
      (topic) =>
        topic.questionsAttempted > 0 &&
        topic.mastery < 70 &&
        topic.confidence >= LEARNING_CONFIG.weakConfidenceMinimum,
    )
    .sort((a, b) => weakPriority(b, now) - weakPriority(a, now))
    .slice(0, limit);
}

export async function getStrongTopics(
  query: LearningTopicQuery,
): Promise<LearningTopicSummary[]> {
  const { states, limit } = await loadStates(query);
  return states
    .filter(
      (topic) =>
        topic.mastery >= 85 &&
        topic.confidence >= LEARNING_CONFIG.strongConfidenceMinimum &&
        topic.recentAccuracy >=
          LEARNING_CONFIG.strongRecentAccuracyMinimum,
    )
    .sort(
      (a, b) =>
        b.mastery - a.mastery ||
        b.confidence - a.confidence ||
        a.topic.localeCompare(b.topic),
    )
    .slice(0, limit);
}

export async function getRecommendedPracticeTopics(
  query: RecommendedPracticeQuery,
): Promise<RecommendedPracticeTopic[]> {
  const parsed = recommendedQuerySchema.safeParse(query);
  if (!parsed.success) throw new LearningServiceError("INVALID_REQUEST");
  const { upcomingTopicNames = [], ...base } = parsed.data;
  const { states, limit, now } = await loadStates(base);
  const upcoming = new Set(upcomingTopicNames.map(normalizeTopicName));
  return states
    .map((topic) => recommendation(topic, now, upcoming))
    .sort(
      (a, b) =>
        b.priority - a.priority || a.topic.localeCompare(b.topic),
    )
    .slice(0, limit);
}

export async function getLearningOverview(
  query: LearningTopicQuery,
): Promise<LearningOverview | undefined> {
  const { states, limit, now } = await loadStates(query);
  if (!states.length) return undefined;
  const weakTopics = states
    .filter(
      (topic) =>
        topic.questionsAttempted > 0 &&
        topic.mastery < 70 &&
        topic.confidence >= LEARNING_CONFIG.weakConfidenceMinimum,
    )
    .sort((a, b) => weakPriority(b, now) - weakPriority(a, now))
    .slice(0, limit);
  const strongTopics = states
    .filter(
      (topic) =>
        topic.mastery >= 85 &&
        topic.confidence >= LEARNING_CONFIG.strongConfidenceMinimum &&
        topic.recentAccuracy >=
          LEARNING_CONFIG.strongRecentAccuracyMinimum,
    )
    .sort((a, b) => b.mastery - a.mastery || b.confidence - a.confidence)
    .slice(0, limit);
  const recommendedTopics = states
    .map((topic) => recommendation(topic, now, new Set()))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
  const requestedNames = new Set(query.examTopicNames?.map(normalizeTopicName));
  return {
    weakTopics,
    strongTopics,
    recommendedTopics,
    ...(query.examTopicNames ? {
      examTopics: states
        .filter((topic) => requestedNames.has(normalizeTopicName(topic.topic)))
        .sort((a, b) => a.mastery - b.mastery || a.id.localeCompare(b.id))
        .slice(0, 100),
    } : {}),
  };
}
