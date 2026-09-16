import "server-only";
import { z } from "zod";
import { LEARNING_CONFIG, normalizeTopicName } from "../../learning";

export const questionTypes = [
  "multiple-choice",
  "true-false",
  "short-answer",
  "long-answer",
] as const;
export const quizDifficulties = ["easy", "medium", "hard"] as const;
export const quizRequestDifficulties = [
  ...quizDifficulties,
  "adaptive",
] as const;
export type QuizQuestionKind = (typeof questionTypes)[number];
export type QuizDifficulty = (typeof quizDifficulties)[number];
export type QuizQuestionRequestKind = QuizQuestionKind | "mixed";

export const quizGenerationRequestSchema = z
  .object({
    request: z.string().trim().min(3).max(1000),
    courseId: z.string().min(1).max(100).optional(),
    documentIds: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(20)
      .transform((ids) => [...new Set(ids)])
      .optional(),
    topic: z.string().trim().min(1).max(200).optional(),
    count: z.number().int().min(1).max(20).optional(),
    questionType: z.enum([...questionTypes, "mixed"]).optional(),
    difficulty: z.enum(quizRequestDifficulties).optional(),
  })
  .strict();

export type QuizGenerationRequest = z.input<typeof quizGenerationRequestSchema>;

export function selectQuizSettings(
  input: z.output<typeof quizGenerationRequestSchema>,
) {
  const lower = input.request.toLowerCase();
  const countMatch = lower.match(/\b(\d+)\s+(?:practice\s+)?questions?\b/);
  const inferredCount = countMatch ? Number(countMatch[1]) : 5;
  const count = input.count ?? inferredCount;
  if (!Number.isInteger(count) || count < 1 || count > 20) return undefined;

  let questionType: QuizQuestionRequestKind = "mixed";
  if (/multiple[ -]choice/.test(lower)) questionType = "multiple-choice";
  else if (/true[ /-]false/.test(lower)) questionType = "true-false";
  else if (/short[ -]answer/.test(lower)) questionType = "short-answer";
  else if (/long[ -]answer|essay/.test(lower)) questionType = "long-answer";
  else if (/\bmixed\b/.test(lower)) questionType = "mixed";
  questionType = input.questionType ?? questionType;

  let difficulty: QuizDifficulty | "adaptive" = "medium";
  if (/\badaptive\b/.test(lower)) difficulty = "adaptive";
  else if (/\bhard(?:er)?\b|\bdifficult\b/.test(lower)) difficulty = "hard";
  else if (/\beas(?:y|ier)\b|\bbeginner\b/.test(lower)) difficulty = "easy";
  difficulty = input.difficulty ?? difficulty;
  return { count, questionType, difficulty } as const;
}

const questionTopicsSchema = z
  .array(
    z.string().trim().min(1).max(LEARNING_CONFIG.maximumTopicNameLength),
  )
  .min(1)
  .max(LEARNING_CONFIG.maximumTopicsPerQuestion)
  .superRefine((topics, ctx) => {
    const normalized = topics.map(normalizeTopicName);
    if (new Set(normalized).size !== normalized.length) {
      ctx.addIssue({
        code: "custom",
        message: "Question topics must be distinct after normalization.",
      });
    }
  });

const generatedQuestionSchema = z
  .object({
    type: z.enum(questionTypes),
    prompt: z.string().trim().min(1).max(2000),
    choices: z.array(z.string().trim().min(1).max(500)).max(4).nullable(),
    correctAnswer: z.string().trim().min(1).max(2000),
    explanation: z.string().trim().min(1).max(2000),
    topics: questionTopicsSchema,
  })
  .strict()
  .superRefine((question, ctx) => {
    if (question.type === "multiple-choice") {
      const normalized = question.choices?.map((choice) =>
        choice.toLowerCase(),
      );
      if (
        !normalized ||
        normalized.length !== 4 ||
        new Set(normalized).size !== 4 ||
        !normalized.includes(question.correctAnswer.toLowerCase())
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Multiple choice requires four distinct choices and one exact answer.",
        });
      }
    } else if (question.type === "true-false") {
      const choices = question.choices?.map((choice) => choice.toLowerCase());
      if (
        !choices ||
        choices.length !== 2 ||
        !choices.includes("true") ||
        !choices.includes("false") ||
        !["true", "false"].includes(question.correctAnswer.toLowerCase())
      ) {
        ctx.addIssue({
          code: "custom",
          message: "True/false requires True and False choices.",
        });
      }
    } else if (question.choices !== null) {
      ctx.addIssue({
        code: "custom",
        message: "Written questions do not have choices.",
      });
    }
  });

export function quizOutputSchema(
  count: number,
  requestedType: QuizQuestionRequestKind | (() => QuizQuestionRequestKind),
  expectedDifficulty?: QuizDifficulty | (() => QuizDifficulty | undefined),
) {
  return z
    .object({
      quizTitle: z.string().trim().min(1).max(200),
      topic: z.string().trim().min(1).max(200).nullable(),
      difficulty: z.enum(quizDifficulties),
      questions: z.array(generatedQuestionSchema).length(count),
    })
    .strict()
    .superRefine((quiz, ctx) => {
      const resolvedType = typeof requestedType === "function"
        ? requestedType()
        : requestedType;
      const resolvedDifficulty = typeof expectedDifficulty === "function"
        ? expectedDifficulty()
        : expectedDifficulty;
      if (
        resolvedType !== "mixed" &&
        quiz.questions.some((question) => question.type !== resolvedType)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["questions"],
          message: "Question type does not match the request.",
        });
      }
      if (
        resolvedType === "mixed" &&
        count > 1 &&
        new Set(quiz.questions.map((question) => question.type)).size < 2
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["questions"],
          message: "Mixed quizzes require at least two question types.",
        });
      }
      if (resolvedDifficulty && quiz.difficulty !== resolvedDifficulty) {
        ctx.addIssue({
          code: "custom",
          path: ["difficulty"],
          message: "Difficulty does not match the request.",
        });
      }
    });
}

export type GeneratedQuizData = z.infer<ReturnType<typeof quizOutputSchema>>;

export const quizEvaluationRequestSchema = z
  .object({
    quizId: z.string().min(1).max(100),
    questionId: z.string().min(1).max(100),
    quizAttemptId: z.string().min(1).max(100).optional(),
    startNewAttempt: z.boolean().optional(),
    userAnswer: z.string().trim().min(1).max(4000),
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
export type QuizEvaluationRequest = z.input<typeof quizEvaluationRequestSchema>;

export const semanticEvaluationSchema = z
  .object({
    correct: z.boolean(),
    score: z.number().min(0).max(1),
    feedback: z.string().trim().min(1).max(500),
    explanation: z.string().trim().min(1).max(1000),
  })
  .strict();
