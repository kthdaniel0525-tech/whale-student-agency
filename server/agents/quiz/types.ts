import type { AIUsage } from "../../ai/types";
import type { ContextCategory } from "../../context/types";
import type { AgentSource } from "../types";
import type { QuizDifficulty, QuizQuestionKind } from "./schemas";

export type PublicQuizQuestion = {
  readonly id: string;
  readonly type: QuizQuestionKind;
  readonly prompt: string;
  readonly choices: readonly string[] | null;
  readonly topics: readonly string[];
};

export type GeneratedQuiz = {
  readonly id: string;
  readonly title: string;
  readonly topic: string | null;
  readonly courseId: string | null;
  readonly difficulty: QuizDifficulty;
  readonly questions: readonly PublicQuizQuestion[];
  readonly sources: readonly AgentSource[];
  readonly metadata: {
    readonly model?: string;
    readonly usage?: AIUsage;
    readonly durationMs?: number;
    readonly contextCategories?: readonly ContextCategory[];
  };
};

export type QuizEvaluation = {
  readonly quizId: string;
  readonly questionId: string;
  readonly quizAttemptId: string;
  readonly correct: boolean;
  readonly score: number;
  readonly feedback: string;
  readonly explanation: string;
  readonly method: "deterministic" | "semantic";
};

export type QuizAgentErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "AUTHENTICATION_FAILURE"
  | "NOT_QUIZ_REQUEST"
  | "QUIZ_NOT_FOUND"
  | "SOURCE_CONTEXT_UNAVAILABLE"
  | "STORAGE_FAILURE";
