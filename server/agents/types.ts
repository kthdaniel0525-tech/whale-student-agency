import type { AIUsage } from "../ai/types";
import type {
  ContextCategory,
  ContextOptions,
  DocumentContext,
  UserContext,
} from "../context/types";

export const STUDENT_AGENT_IDS = [
  "academic-manager",
  "tutor",
  "notes",
  "quiz",
  "study-planner",
  "career",
] as const;

export type StudentAgentId = (typeof STUDENT_AGENT_IDS)[number];
// Extensions must be declared explicitly; the default does not accept arbitrary IDs.
export type AgentId<Extension extends string = never> =
  | StudentAgentId
  | Extension;

export const AGENT_CAPABILITIES = [
  "explain-concepts",
  "answer-course-questions",
  "summarize-documents",
  "create-notes",
  "generate-questions",
  "evaluate-answers",
  "create-study-plan",
  "update-study-plan",
  "prioritize-deadlines",
  "prioritize-weak-topics",
  "allocate-study-time",
  "rebalance-study-plan",
  "create-daily-plan",
  "create-weekly-plan",
  "exam-preparation",
  "academic-coordination",
  "prioritize-academic-work",
  "semester-overview",
  "recommend-next-actions",
  "identify-risks",
  "route-specialist-work",
  "academic-readiness-analysis",
  "career-guidance",
  "resume-improvement",
  "resume-bullet-generation",
  "portfolio-guidance",
  "project-positioning",
  "internship-preparation",
  "skill-gap-analysis",
  "provide-examples",
  "clarify-mistakes",
  "use-course-materials",
  "extract-key-concepts",
  "extract-definitions",
  "create-review-notes",
  "generate-multiple-choice",
  "generate-short-answer",
  "generate-long-answer",
  "explain-wrong-answers",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/** Metadata only. Registration does not imply an executable implementation exists. */
export interface Agent<Extension extends string = never> {
  readonly id: AgentId<Extension>;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly AgentCapability[];
  readonly contextRequirements: Readonly<ContextOptions>;
}

export interface AgentExecutionInput {
  readonly request: string;
  readonly context: UserContext;
  readonly conversation?: {
    readonly id: string;
    readonly turnId?: string;
  };
}

export type AgentSource = Pick<
  DocumentContext,
  | "documentId"
  | "documentTitle"
  | "pageNumber"
  | "pageEnd"
  | "courseId"
  | "courseCode"
  | "chunkIndex"
>;

export interface AgentExecutionResult<
  StructuredData = unknown,
  Extension extends string = never,
> {
  readonly content: string;
  readonly agentId: AgentId<Extension>;
  readonly structuredData?: StructuredData;
  readonly sources?: readonly AgentSource[];
  readonly metadata?: {
    readonly model?: string;
    readonly usage?: AIUsage;
    readonly durationMs?: number;
    readonly contextCategories?: readonly ContextCategory[];
    readonly contextCharacters?: number;
    readonly contextEstimatedTokens?: number;
  };
}
