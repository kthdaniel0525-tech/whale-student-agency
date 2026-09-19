import "server-only";
import { z } from "zod";
import { auth } from "../../auth/config";
import { db } from "../../db/client";
import { getAIProvider } from "../../ai";
import { AIError } from "../../ai/errors";
import type { AIProvider } from "../../ai/types";
import {
  LearningServiceError,
  mapQuizQuestionsToTopics,
  recordQuestionEvaluation,
  resolveLearningCourseId,
} from "../../learning";
import type { AgentSource } from "../types";
import { AgentExecutor, AgentExecutionError } from "../executor";
import type { AgentExecutorOptions } from "../executor";
import type { AgentRegistry } from "../registry";
import { AgentRouter } from "../router";
import type { AgentRouterOptions } from "../router";
import { createStudentAgentRegistry } from "../student-service";
import { QUIZ_INSTRUCTIONS } from "./instructions";
import {
  quizEvaluationRequestSchema,
  quizGenerationRequestSchema,
  quizOutputSchema,
  selectQuizSettings,
  semanticEvaluationSchema,
  type QuizEvaluationRequest,
  type QuizGenerationRequest,
  type QuizQuestionKind,
} from "./schemas";
import type {
  GeneratedQuiz,
  QuizAgentErrorCode,
  QuizEvaluation,
} from "./types";
import {
  getRecentAdaptiveOutcomes,
  recordAdaptiveOutcome,
} from "../../adaptive";
import { refreshRecommendationsBestEffort } from "../../recommendations";

export interface QuizAgentServiceOptions {
  readonly router?: AgentRouterOptions;
  readonly executor?: AgentExecutorOptions;
  readonly getProvider?: () => AIProvider | Promise<AIProvider>;
}

const errorMessages: Record<QuizAgentErrorCode, string> = {
  INVALID_REQUEST: "Check the quiz request, question count and answer.",
  UNAUTHENTICATED: "Sign in to use quizzes.",
  AUTHENTICATION_FAILURE:
    "Authentication could not be verified. Try again later.",
  NOT_QUIZ_REQUEST: "This request was not selected for the Quiz agent.",
  QUIZ_NOT_FOUND: "This quiz or question was not found.",
  SOURCE_CONTEXT_UNAVAILABLE:
    "Relevant course material was not available for this quiz.",
  STORAGE_FAILURE: "The quiz could not be saved or loaded. Try again later.",
};

export class QuizAgentError extends Error {
  constructor(readonly code: QuizAgentErrorCode) {
    super(errorMessages[code]);
    this.name = "QuizAgentError";
  }
}

const typeToDb = {
  "multiple-choice": "MULTIPLE_CHOICE",
  "true-false": "TRUE_FALSE",
  "short-answer": "SHORT_ANSWER",
  "long-answer": "LONG_ANSWER",
} as const;
const typeFromDb = Object.fromEntries(
  Object.entries(typeToDb).map(([key, value]) => [value, key]),
) as Record<(typeof typeToDb)[QuizQuestionKind], QuizQuestionKind>;
const difficultyToDb = {
  easy: "EASY",
  medium: "MEDIUM",
  hard: "HARD",
} as const;
const difficultyFromDb = {
  EASY: "easy",
  MEDIUM: "medium",
  HARD: "hard",
} as const;

const sourceSchema = z
  .object({
    documentId: z.string(),
    documentTitle: z.string(),
    pageNumber: z.number().int().nullable(),
    pageEnd: z.number().int().nullable(),
    courseId: z.string().nullable(),
    courseCode: z.string().nullable(),
    chunkIndex: z.number().int(),
  })
  .strict();

function normalizedAnswer(value: string): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (["t", "yes"].includes(normalized)) return "true";
  if (["f", "no"].includes(normalized)) return "false";
  return normalized;
}

function sourceRequest(request: string): boolean {
  return /\b(?:lecture|pdf|document|uploaded|course notes|professor)\b/i.test(
    request,
  );
}

/** Quiz domain coordination; generation itself remains inside AgentExecutor. */
export class QuizAgentService {
  readonly #router: AgentRouter;
  readonly #executor: AgentExecutor;
  readonly #getProvider: () => AIProvider | Promise<AIProvider>;

  constructor(registry: AgentRegistry, options: QuizAgentServiceOptions = {}) {
    this.#router = new AgentRouter(registry, options.router);
    this.#executor = new AgentExecutor(registry, {
      ...options.executor,
      instructions: {
        quiz: QUIZ_INSTRUCTIONS,
        ...options.executor?.instructions,
      },
    });
    this.#getProvider =
      options.getProvider ?? options.executor?.getProvider ?? getAIProvider;
  }

  async generateQuiz(
    rawInput: QuizGenerationRequest,
    requestHeaders: Headers,
    support?: Pick<import("../executor").AgentStructuredExecutionOptions<unknown>, "referenceData" | "contextOverrides" | "maxOutputTokens">,
  ): Promise<GeneratedQuiz> {
    const { userId, headers } = await this.authenticate(requestHeaders);
    const parsed = quizGenerationRequestSchema.safeParse(rawInput);
    if (!parsed.success) throw new QuizAgentError("INVALID_REQUEST");
    const settings = selectQuizSettings(parsed.data);
    if (!settings) throw new QuizAgentError("INVALID_REQUEST");
    const routing = await this.#router.routeAgent({
      request: parsed.data.request,
    });
    if (routing.agentId !== "quiz")
      throw new QuizAgentError("NOT_QUIZ_REQUEST");

    const explicitlyRequestedDifficulty =
      parsed.data.difficulty !== undefined ||
      /\badaptive\b|\bhard(?:er)?\b|\bdifficult\b|\beas(?:y|ier)\b|\bbeginner\b/i.test(parsed.data.request);
    const explicitlyRequestedQuestionType =
      parsed.data.questionType !== undefined ||
      /\bmultiple[ -]choice\b|\btrue[ /-]false\b|\bshort[ -]answer\b|\blong[ -]answer\b|\bessay\b|\bmixed\b/i.test(parsed.data.request);
    let appliedDifficulty = settings.difficulty;
    let appliedQuestionType = settings.questionType;
    const schema = quizOutputSchema(
      settings.count,
      () => appliedQuestionType,
      () => appliedDifficulty === "adaptive" ? undefined : appliedDifficulty,
    );
    const contextRequest = parsed.data.topic
      ? `${parsed.data.request}\nTopic: ${parsed.data.topic}`
      : parsed.data.request;
    let execution;
    try {
      execution = await this.#executor.executeStructured(
        {
          agentId: "quiz",
          request: contextRequest,
          ...(parsed.data.conversation ? { conversation: parsed.data.conversation } : {}),
          ...(parsed.data.courseId ? { courseId: parsed.data.courseId } : {}),
          ...(parsed.data.documentIds
            ? { documentIds: parsed.data.documentIds }
            : {}),
        },
        headers,
        {
          ...support,
          schemaName: "quiz_generation",
          schema,
          buildDirective: (_context, personalization, adaptiveStrategy) => {
            if (!explicitlyRequestedDifficulty) {
              appliedDifficulty = adaptiveStrategy.difficulty ??
                personalization.recommendedDifficulty?.value ?? "medium";
            }
            if (!explicitlyRequestedQuestionType) {
              const adaptiveMix = adaptiveStrategy.questionMix;
              const preferred = adaptiveMix?.length
                ? adaptiveMix.length > 1 ? "mixed" : adaptiveMix[0]
                : personalization.preferredQuestionTypes?.value[0];
              if (
                preferred === "multiple-choice" ||
                preferred === "true-false" ||
                preferred === "short-answer" ||
                preferred === "long-answer" ||
                preferred === "mixed"
              ) {
                appliedQuestionType = preferred;
              }
            }
            return JSON.stringify({
              count: settings.count,
              questionType: appliedQuestionType,
              difficulty: appliedDifficulty,
              adaptiveFallback: "medium",
              diagnosticMode: adaptiveStrategy.diagnosticMode ?? false,
              questionMix: adaptiveStrategy.questionMix ?? [],
              feedbackStyle: adaptiveStrategy.feedbackStyle ?? "brief-correction",
              topic: parsed.data.topic ?? null,
            });
          },
          maxOutputTokens: support?.maxOutputTokens ?? Math.min(8192, 600 + settings.count * 350),
          requireDocumentSources:
            Boolean(parsed.data.documentIds?.length) ||
            sourceRequest(parsed.data.request),
        },
      );
    } catch (error) {
      if (
        error instanceof AgentExecutionError &&
        error.code === "SOURCE_CONTEXT_UNAVAILABLE"
      ) {
        throw new QuizAgentError("SOURCE_CONTEXT_UNAVAILABLE");
      }
      throw error;
    }
    const generated = execution.structuredData;
    if (!generated) throw new QuizAgentError("STORAGE_FAILURE");
    if (
      appliedDifficulty === "adaptive" &&
      !execution.metadata?.contextCategories?.includes("learning") &&
      generated.difficulty !== "medium"
    ) {
      throw new AIError("INVALID_RESPONSE");
    }
    if (appliedDifficulty !== "adaptive" && generated.difficulty !== appliedDifficulty) {
      throw new AIError("INVALID_RESPONSE");
    }
    const sources = execution.sources ?? [];
    const sourceCourseIds = new Set(
      sources
        .map((source) => source.courseId)
        .filter((courseId): courseId is string => Boolean(courseId)),
    );
    let resolvedCourseId =
      parsed.data.courseId ??
      (sourceCourseIds.size === 1 ? [...sourceCourseIds][0] : undefined);
    if (!resolvedCourseId && sourceCourseIds.size === 0) {
      try {
        resolvedCourseId = await resolveLearningCourseId({
          userId,
          topicNames: generated.questions.flatMap(
            (question) => question.topics,
          ),
        });
      } catch {
        throw new QuizAgentError("STORAGE_FAILURE");
      }
    }
    const storedSources = sources.length
      ? JSON.parse(JSON.stringify(sources))
      : undefined;

    let saved;
    try {
      saved = await db().$transaction(async (transaction) => {
        const quiz = await transaction.quiz.create({
          data: {
            userId,
            ...(resolvedCourseId ? { courseId: resolvedCourseId } : {}),
            title: generated.quizTitle,
            topic: parsed.data.topic ?? generated.topic,
            difficulty: difficultyToDb[generated.difficulty],
            questions: {
              create: generated.questions.map((question, position) => ({
                position,
                type: typeToDb[question.type],
                prompt: question.prompt,
                ...(question.choices ? { choices: question.choices } : {}),
                correctAnswer: question.correctAnswer,
                explanation: question.explanation,
                topicNames: question.topics,
                ...(storedSources ? { sourceMetadata: storedSources } : {}),
              })),
            },
          },
          include: { questions: { orderBy: { position: "asc" } } },
        });
        if (quiz.courseId) {
          await mapQuizQuestionsToTopics(transaction, {
            userId,
            courseId: quiz.courseId,
            questions: quiz.questions,
          });
        }
        return quiz;
      });
    } catch {
      throw new QuizAgentError("STORAGE_FAILURE");
    }
    return {
      id: saved.id,
      title: saved.title,
      topic: saved.topic,
      courseId: saved.courseId,
      difficulty: difficultyFromDb[saved.difficulty],
      questions: saved.questions.map((question) => ({
        id: question.id,
        type: typeFromDb[question.type],
        prompt: question.prompt,
        topics: question.topicNames,
        choices: Array.isArray(question.choices)
          ? question.choices.filter(
              (choice): choice is string => typeof choice === "string",
            )
          : null,
      })),
      sources,
      metadata: execution.metadata ?? {},
    };
  }

  async getQuiz(
    quizId: string,
    requestHeaders: Headers,
  ): Promise<GeneratedQuiz> {
    if (!quizId || quizId.length > 100)
      throw new QuizAgentError("INVALID_REQUEST");
    const { userId } = await this.authenticate(requestHeaders);
    let quiz;
    try {
      quiz = await db().quiz.findFirst({
        where: { id: quizId, userId },
        include: { questions: { orderBy: { position: "asc" } } },
      });
    } catch {
      throw new QuizAgentError("STORAGE_FAILURE");
    }
    if (!quiz) throw new QuizAgentError("QUIZ_NOT_FOUND");
    const sources = new Map<string, AgentSource>();
    for (const question of quiz.questions) {
      const parsed = z.array(sourceSchema).safeParse(question.sourceMetadata);
      if (!parsed.success) continue;
      for (const source of parsed.data) {
        const key = JSON.stringify([
          source.documentId,
          source.chunkIndex,
          source.pageNumber,
          source.pageEnd,
        ]);
        sources.set(key, source);
      }
    }
    return {
      id: quiz.id,
      title: quiz.title,
      topic: quiz.topic,
      courseId: quiz.courseId,
      difficulty: difficultyFromDb[quiz.difficulty],
      questions: quiz.questions.map((question) => ({
        id: question.id,
        type: typeFromDb[question.type],
        prompt: question.prompt,
        topics: question.topicNames,
        choices: Array.isArray(question.choices)
          ? question.choices.filter(
              (choice): choice is string => typeof choice === "string",
            )
          : null,
      })),
      sources: [...sources.values()],
      metadata: {},
    };
  }

  async evaluateAnswer(
    rawInput: QuizEvaluationRequest,
    requestHeaders: Headers,
  ): Promise<QuizEvaluation> {
    const parsed = quizEvaluationRequestSchema.safeParse(rawInput);
    if (!parsed.success) throw new QuizAgentError("INVALID_REQUEST");
    const { userId } = await this.authenticate(requestHeaders);
    let question;
    try {
      question = await db().quizQuestion.findFirst({
        where: {
          id: parsed.data.questionId,
          quizId: parsed.data.quizId,
          userId,
          quiz: { userId },
        },
        include: {
          quiz: { select: { courseId: true, difficulty: true } },
          topicMappings: { select: { topicId: true } },
        },
      });
    } catch {
      throw new QuizAgentError("STORAGE_FAILURE");
    }
    if (!question) throw new QuizAgentError("QUIZ_NOT_FOUND");
    const primaryTopicId = question.topicMappings[0]?.topicId;
    const recentOutcomes = await getRecentAdaptiveOutcomes({
      userId,
      agentId: "quiz",
      ...(question.quiz.courseId ? { courseId: question.quiz.courseId } : {}),
      ...(primaryTopicId ? { topicId: primaryTopicId } : {}),
      limit: 12,
    }).catch(() => []);
    const repeatedErrors = recentOutcomes.filter(
      (outcome) =>
        outcome.outcomeType === "quiz-performance" &&
        outcome.successful === false,
    ).length;
    const objective =
      question.type === "MULTIPLE_CHOICE" || question.type === "TRUE_FALSE";
    let grading: Omit<
      QuizEvaluation,
      "quizId" | "questionId" | "quizAttemptId"
    >;
    if (objective) {
      const correct =
        normalizedAnswer(parsed.data.userAnswer) ===
        normalizedAnswer(question.correctAnswer);
      grading = {
        correct,
        score: correct ? 1 : 0,
        feedback: correct
          ? "Correct."
          : `Incorrect. The correct answer is ${question.correctAnswer}.`,
        explanation: question.explanation,
        method: "deterministic",
      };
    } else {
      let evaluation;
      try {
        const provider = await this.#getProvider();
        const result = await provider.generateStructuredOutput({
          schemaName: "quiz_answer_evaluation",
          usageContext: { userId, agentId: "quiz", operationType: "evaluation" },
          schema: semanticEvaluationSchema,
          maxOutputTokens: 512,
          messages: [
            {
              role: "system",
              content:
                "Grade the answer against the expected answer. Return concise educational feedback. Do not require exact wording when meaning is correct.",
            },
            {
              role: "user",
              content: JSON.stringify({
                question: question.prompt,
                expectedAnswer: question.correctAnswer,
                userAnswer: parsed.data.userAnswer,
              }),
            },
          ],
        });
        const validated = semanticEvaluationSchema.safeParse(result.data);
        if (!validated.success) throw new AIError("INVALID_RESPONSE");
        evaluation = validated.data;
      } catch (error) {
        throw error instanceof AIError
          ? error
          : new AIError("PROVIDER_FAILURE");
      }
      grading = { ...evaluation, method: "semantic" };
    }
    let recorded;
    try {
      recorded = await recordQuestionEvaluation({
        userId,
        quizId: parsed.data.quizId,
        questionId: question.id,
        ...(parsed.data.quizAttemptId
          ? { quizAttemptId: parsed.data.quizAttemptId }
          : {}),
        ...(parsed.data.startNewAttempt ? { startNewAttempt: true } : {}),
        userAnswer: parsed.data.userAnswer,
        score: grading.score,
        correct: grading.correct,
        method: grading.method,
      });
    } catch (error) {
      if (
        error instanceof LearningServiceError &&
        error.code === "NOT_FOUND"
      ) {
        throw new QuizAgentError("QUIZ_NOT_FOUND");
      }
      throw new QuizAgentError("STORAGE_FAILURE");
    }
    if (!grading.correct && repeatedErrors >= 1) {
      grading = {
        ...grading,
        feedback:
          `${grading.feedback} This concept has been missed repeatedly; use Tutor for a different explanation before the next attempt.`,
      };
    }
    try {
      const topics = recorded.updatedTopicIds.length
        ? recorded.updatedTopicIds
        : [undefined];
      await Promise.all(
        topics.map((topicId) =>
          recordAdaptiveOutcome({
            userId,
            agentId: "quiz",
            ...(question.quiz.courseId ? { courseId: question.quiz.courseId } : {}),
            ...(topicId ? { topicId } : {}),
            strategyKey: `quiz:${difficultyFromDb[question.quiz.difficulty]}:${typeFromDb[question.type]}`,
            strategy: {
              difficulty: difficultyFromDb[question.quiz.difficulty],
              questionMix: [typeFromDb[question.type]],
            },
            outcomeType: "quiz-performance",
            score: grading.score,
            successful: grading.correct,
            evidenceKey: `question-attempt:${recorded.questionAttemptId}:${topicId ?? "general"}`,
          }),
        ),
      );
    } catch {
      // LearningProgress is authoritative; optional adaptation evidence cannot
      // make a successfully graded answer fail.
    }
    if (recorded.completed) await refreshRecommendationsBestEffort(userId);
    return {
      quizId: parsed.data.quizId,
      questionId: question.id,
      quizAttemptId: recorded.quizAttemptId,
      ...grading,
    };
  }

  private async authenticate(requestHeaders: Headers) {
    const headers = new Headers(requestHeaders);
    try {
      const session = await auth().api.getSession({
        headers,
        query: { disableRefresh: true },
      });
      if (!session?.user.id) throw new QuizAgentError("UNAUTHENTICATED");
      return { userId: session.user.id, headers };
    } catch (error) {
      if (error instanceof QuizAgentError) throw error;
      throw new QuizAgentError("AUTHENTICATION_FAILURE");
    }
  }
}

export function createQuizAgentService(
  options: QuizAgentServiceOptions = {},
): QuizAgentService {
  return new QuizAgentService(createStudentAgentRegistry(), options);
}
