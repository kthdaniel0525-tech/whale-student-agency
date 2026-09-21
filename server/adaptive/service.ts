import { hasEntitlement, assertEntitlement } from "../entitlements/service";
import "server-only";
import { z } from "zod";
import { auth } from "../auth/config";
import { db } from "../db/client";
import { recordMemoryObservation } from "../memory";
import { STUDENT_AGENT_IDS, type StudentAgentId } from "../agents/types";
import { ADAPTIVE_CONFIG } from "./config";
import {
  buildAdaptiveStrategy,
  explicitConfusion,
  explicitUnderstanding,
} from "./engine";
import type {
  AdaptiveOutcomeRecord,
  AdaptiveOutcomeStrategySnapshot,
  AdaptiveOutcomeType,
  BuildAdaptiveStrategyInput,
  PreparedAdaptiveStrategy,
  RecordAdaptiveOutcomeInput,
} from "./types";

const outcomeTypes = [
  "agent-response",
  "explicit-understanding",
  "explicit-confusion",
  "quiz-performance",
  "study-task-completed",
  "study-task-skipped",
  "recommendation",
  "workflow-result",
] as const satisfies readonly AdaptiveOutcomeType[];

const inputSchema = z.object({
  userId: z.string().trim().min(1).max(100),
  agentId: z.enum(STUDENT_AGENT_IDS),
  courseId: z.string().trim().min(1).max(100).optional(),
  topicId: z.string().trim().min(1).max(100).optional(),
  strategyKey: z.string().trim().min(1).max(160),
  strategy: z.object({
    explanationApproach: z.enum(["intuitive", "formal", "example-first", "step-by-step", "analogy", "worked-example", "concise-review"]).optional(),
    difficulty: z.enum(["easy", "medium", "hard"]).optional(),
    questionMix: z.array(z.enum(["multiple-choice", "true-false", "short-answer", "long-answer"])).max(4).optional(),
    planningIntensity: z.enum(["light", "moderate", "high"]).optional(),
    recommendedSessionMinutes: z.number().int().min(15).max(180).optional(),
    diagnosticMode: z.boolean().optional(),
    noteMode: z.enum(["concept-learning", "structured-review", "exam-review", "concise-maintenance"]).optional(),
    careerFocus: z.enum(["projects", "resume", "portfolio", "interview", "applications", "current-gap"]).optional(),
    recommendedAgent: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  outcomeType: z.enum(outcomeTypes),
  score: z.number().min(0).max(1).optional(),
  successful: z.boolean().optional(),
  action: z.string().trim().min(1).max(300).optional(),
  evidenceKey: z.string().trim().min(1).max(180),
  memoryCandidate: z.object({
    key: z.string().trim().min(1).max(70),
    value: z.string().trim().min(1).max(500),
    source: z.string().trim().min(1).max(200),
  }).strict().optional(),
}).strict();

type OutcomeRow = Awaited<ReturnType<ReturnType<typeof db>["adaptiveOutcome"]["findFirst"]>>;

function publicOutcome(row: NonNullable<OutcomeRow>): AdaptiveOutcomeRecord {
  return {
    id: row.id,
    userId: row.userId,
    agentId: row.agentId as StudentAgentId,
    courseId: row.courseId,
    topicId: row.topicId,
    strategyKey: row.strategyKey,
    strategy: row.strategy as unknown as AdaptiveOutcomeStrategySnapshot,
    outcomeType: row.outcomeType as AdaptiveOutcomeType,
    score: row.score,
    successful: row.successful,
    action: row.action,
    evidenceKey: row.evidenceKey,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Trusted internal write. Resource references are rechecked against the owner. */
export async function recordAdaptiveOutcome(
  raw: RecordAdaptiveOutcomeInput,
): Promise<AdaptiveOutcomeRecord> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("INVALID_ADAPTIVE_OUTCOME");
  const input = parsed.data;
  const row = await db().$transaction(async (transaction) => {
    const [user, course, topic] = await Promise.all([
      transaction.user.findUnique({ where: { id: input.userId }, select: { id: true } }),
      input.courseId
        ? transaction.course.findFirst({ where: { id: input.courseId, userId: input.userId }, select: { id: true } })
        : Promise.resolve(null),
      input.topicId
        ? transaction.learningTopic.findFirst({ where: { id: input.topicId, userId: input.userId }, select: { id: true, courseId: true } })
        : Promise.resolve(null),
    ]);
    if (!user || (input.courseId && !course) || (input.topicId && !topic))
      throw new Error("ADAPTIVE_REFERENCE_NOT_FOUND");
    if (topic && input.courseId && topic.courseId !== input.courseId)
      throw new Error("ADAPTIVE_REFERENCE_NOT_FOUND");
    const existing = await transaction.adaptiveOutcome.findUnique({
      where: { userId_evidenceKey: { userId: input.userId, evidenceKey: input.evidenceKey } },
    });
    if (existing) return existing;
    await assertEntitlement(input.userId, "personalization.adaptive", transaction);
    return transaction.adaptiveOutcome.create({
      data: {
        userId: input.userId,
        agentId: input.agentId,
        courseId: input.courseId,
        topicId: input.topicId,
        strategyKey: input.strategyKey,
        strategy: input.strategy,
        outcomeType: input.outcomeType,
        score: input.score,
        successful: input.successful,
        action: input.action,
        evidenceKey: input.evidenceKey,
      },
    });
  });
  if (input.successful === true && input.memoryCandidate) {
    try {
      await recordMemoryObservation({
        userId: input.userId,
        category: "successful-strategy",
        key: input.memoryCandidate.key,
        observedValue: input.memoryCandidate.value,
        source: input.memoryCandidate.source,
        evidenceKey: `adaptive:${row.id}`,
        evidenceType: "outcome",
        sourceType: "system-derived",
        importance: 75,
      });
    } catch {
      // Outcome evidence is authoritative. Optional long-term promotion remains
      // best-effort and still follows the existing Memory observation rules.
    }
  }
  return publicOutcome(row);
}

/** Internal owner-scoped retrieval used by the shared strategy engine. */
export async function getRecentAdaptiveOutcomes(input: {
  userId: string;
  agentId: StudentAgentId;
  courseId?: string;
  topicId?: string;
  limit?: number;
}): Promise<AdaptiveOutcomeRecord[]> {
  const limit = input.limit ?? ADAPTIVE_CONFIG.recentOutcomeLimit;
  if (!input.userId || !STUDENT_AGENT_IDS.includes(input.agentId) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("INVALID_ADAPTIVE_QUERY");
  const rows = await db().adaptiveOutcome.findMany({
    where: {
      userId: input.userId,
      agentId: input.agentId,
      AND: [
        ...(input.courseId ? [{ OR: [{ courseId: input.courseId }, { courseId: null }] }] : []),
        ...(input.topicId ? [{ OR: [{ topicId: input.topicId }, { topicId: null }] }] : []),
      ],
      createdAt: { gte: new Date(Date.now() - ADAPTIVE_CONFIG.maximumOutcomeAgeDays * 86_400_000) },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.map(publicOutcome);
}

async function sessionUser(headers: Headers): Promise<string | undefined> {
  try {
    const session = await auth().api.getSession({
      headers: new Headers(headers),
      query: { disableRefresh: true },
    });
    return session?.user.id;
  } catch {
    return undefined;
  }
}

function requestedLearningTopic(input: Omit<BuildAdaptiveStrategyInput, "userId" | "recentOutcomes">) {
  const request = input.request.normalize("NFKC").toLocaleLowerCase();
  const learning = input.context.learning;
  const topics = learning
    ? [
        ...(learning.examTopics ?? []),
        ...learning.recommendedTopics,
        ...learning.weakTopics,
        ...learning.strongTopics,
      ]
    : [];
  return topics.find((topic) =>
    request.includes(topic.topic.normalize("NFKC").toLocaleLowerCase()),
  ) ?? learning?.recommendedTopics[0] ?? learning?.weakTopics[0];
}

/** Builds one short-lived strategy. Missing optional outcome storage falls back
 * to current owned context rather than breaking an otherwise valid Agent call. */
export async function prepareAdaptiveStrategy(
  input: Omit<BuildAdaptiveStrategyInput, "userId" | "recentOutcomes">,
  requestHeaders: Headers,
): Promise<PreparedAdaptiveStrategy> {
  const userId = await sessionUser(requestHeaders);
  let recentOutcomes: AdaptiveOutcomeRecord[] = [];
  if (userId && await hasEntitlement(userId, "personalization.adaptive")) {
    try {
      if (!STUDENT_AGENT_IDS.includes(input.agentId as StudentAgentId))
        throw new Error("UNSUPPORTED_ADAPTIVE_AGENT");
      const topic = requestedLearningTopic(input);
      recentOutcomes = await getRecentAdaptiveOutcomes({
        userId,
        agentId: input.agentId as StudentAgentId,
        ...(input.context.course?.id ? { courseId: input.context.course.id } : {}),
        ...(topic?.topicId ? { topicId: topic.topicId } : {}),
      });
    } catch {
      recentOutcomes = [];
    }
  }
  return {
    ...(userId ? { userId } : {}),
    strategy: buildAdaptiveStrategy({ ...input, ...(userId ? { userId } : {}), recentOutcomes }),
  };
}

function snapshot(strategy: PreparedAdaptiveStrategy["strategy"]): AdaptiveOutcomeStrategySnapshot {
  return {
    explanationApproach: strategy.explanationApproach,
    difficulty: strategy.difficulty,
    questionMix: strategy.questionMix,
    planningIntensity: strategy.planningIntensity,
    recommendedSessionMinutes: strategy.recommendedSessionMinutes,
    diagnosticMode: strategy.diagnosticMode,
    noteMode: strategy.noteMode,
    careerFocus: strategy.careerFocus,
  };
}

/** Records only compact execution and explicit feedback signals. */
export async function recordAdaptiveExecution(input: {
  userId: string;
  agentId: StudentAgentId;
  request: string;
  strategy: PreparedAdaptiveStrategy["strategy"];
  evidenceKey: string;
}): Promise<void> {
  const common = {
    userId: input.userId,
    agentId: input.agentId,
    courseId: input.strategy.metadata.selectedCourseId,
    topicId: input.strategy.metadata.selectedTopicId,
  };
  await recordAdaptiveOutcome({
    ...common,
    strategyKey: input.strategy.metadata.strategyKey,
    strategy: snapshot(input.strategy),
    outcomeType: "agent-response",
    evidenceKey: `${input.evidenceKey}:${input.agentId}:response`,
  });
  const priorKey = input.strategy.metadata.priorStrategyKey;
  const priorApproach = input.strategy.metadata.priorExplanationApproach;
  if (priorKey && (explicitConfusion(input.request) || explicitUnderstanding(input.request))) {
    const successful = explicitUnderstanding(input.request);
    await recordAdaptiveOutcome({
      ...common,
      strategyKey: priorKey,
      strategy: { ...(priorApproach ? { explanationApproach: priorApproach } : {}) },
      outcomeType: successful ? "explicit-understanding" : "explicit-confusion",
      successful,
      evidenceKey: `${input.evidenceKey}:${input.agentId}:${successful ? "understood" : "confused"}`,
      ...(successful && priorApproach
        ? {
            memoryCandidate: {
              key: `${input.agentId}-${priorApproach}`,
              value: `${priorApproach} was explicitly helpful for learning`,
              source: "Repeated explicit Agent strategy success",
            },
          }
        : {}),
    });
  }
}

/** Authenticated adapter for handlers that need to save compact recommendations. */
export async function recordOwnedAdaptiveOutcome(
  input: Omit<RecordAdaptiveOutcomeInput, "userId">,
  requestHeaders: Headers,
): Promise<AdaptiveOutcomeRecord | undefined> {
  const userId = await sessionUser(requestHeaders);
  if (!userId) return undefined;
  return recordAdaptiveOutcome({ ...input, userId });
}
