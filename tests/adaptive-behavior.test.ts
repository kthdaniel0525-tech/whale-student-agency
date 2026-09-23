import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildAdaptiveStrategy,
  getRecentAdaptiveOutcomes,
  recordAdaptiveOutcome,
  type AdaptiveOutcomeRecord,
} from "@/server/adaptive";
import { AgentExecutor } from "@/server/agents/executor";
import { AgentRegistry } from "@/server/agents/registry";
import { getTutorAgentDefinition } from "@/server/agents/tutor/definition";
import type { AIProvider } from "@/server/ai/types";
import { buildUserContext } from "@/server/context/builder";
import type {
  ContextData,
  LearningTopicContext,
  UserContext,
} from "@/server/context/types";
import { db } from "@/server/db/client";
import type { PersonalizationProfile } from "@/server/personalization";

vi.mock("@/server/context/builder", () => ({ buildUserContext: vi.fn() }));
const buildContext = vi.mocked(buildUserContext);

function topic(
  mastery: number,
  confidence: number,
  overrides: Partial<LearningTopicContext> = {},
): LearningTopicContext {
  return {
    topicId: "topic-1",
    topic: "Mathematical Induction",
    course: { id: "course-1", courseCode: "MATH 1240", courseName: "Discrete Math" },
    mastery,
    confidence,
    recentAccuracy: mastery,
    questionsAttempted: confidence < 30 ? 1 : 12,
    practiceSessions: confidence < 30 ? 1 : 4,
    status: mastery < 40 ? "weak" : mastery >= 85 ? "strong" : mastery >= 70 ? "good" : "developing",
    evidence: confidence >= 60 ? "sufficient" : "limited",
    trend: "stable",
    lastPracticedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

function context(data: ContextData = {}): UserContext {
  return {
    ...structuredClone(data),
    metadata: {
      generatedAt: "2026-09-15T12:00:00.000Z",
      requestedCategories: Object.keys(data) as UserContext["metadata"]["requestedCategories"],
      unavailableCategories: [],
      truncatedCategories: [],
      estimatedContextSize: JSON.stringify(data).length,
      estimatedTokens: 100,
      maxCharacters: 40_000,
    },
  };
}

function learning(item: LearningTopicContext): ContextData["learning"] {
  return {
    weakTopics: item.mastery < 70 ? [item] : [],
    strongTopics: item.mastery >= 85 ? [item] : [],
    recommendedTopics: [{ ...item, reasons: [item.confidence < 45 ? "low-confidence" : "low-mastery"] }],
  };
}

function personalization(
  values: Partial<PersonalizationProfile> = {},
): PersonalizationProfile {
  return {
    metadata: { appliedSignals: [], ignoredSignals: [], conflictsResolved: [] },
    ...values,
  };
}

function outcome(
  overrides: Partial<AdaptiveOutcomeRecord> = {},
): AdaptiveOutcomeRecord {
  return {
    id: randomUUID(),
    userId: "user-1",
    agentId: "tutor",
    courseId: "course-1",
    topicId: "topic-1",
    strategyKey: "tutor:formal",
    strategy: { explanationApproach: "formal" },
    outcomeType: "agent-response",
    score: null,
    successful: null,
    action: null,
    evidenceKey: randomUUID(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function strategy(
  agentId: string,
  request: string,
  data: ContextData = {},
  recentOutcomes: AdaptiveOutcomeRecord[] = [],
) {
  return buildAdaptiveStrategy({
    agentId,
    request,
    personalization: personalization(),
    context: context(data),
    recentOutcomes,
  });
}

describe("Adaptive Behavior Engine", () => {
  it("uses a foundational worked example for a supported low-mastery Tutor topic", () => {
    const result = strategy("tutor", "Explain induction", { learning: learning(topic(28, 88)) });
    expect(result).toMatchObject({ responseDepth: "foundational", explanationApproach: "worked-example" });
  });

  it("uses formal advanced treatment for high mastery with sufficient confidence", () => {
    const result = strategy("tutor", "Explain induction", { learning: learning(topic(92, 94)) });
    expect(result).toMatchObject({ responseDepth: "advanced", explanationApproach: "formal" });
  });

  it("switches away from a failed Tutor explanation approach", () => {
    const result = strategy("tutor", "I still don't understand induction", { learning: learning(topic(45, 80)) }, [outcome()]);
    expect(result.explanationApproach).toBe("intuitive");
    expect(result.retryStrategy).toBe("switch-approach");
    expect(result.metadata.priorStrategyKey).toBe("tutor:formal");
  });

  it("treats a repeated conceptual question as short-term misunderstanding", () => {
    const result = buildAdaptiveStrategy({
      agentId: "tutor",
      request: "Why does induction prove every natural number?",
      personalization: personalization(),
      context: context({ learning: learning(topic(55, 75)) }),
      recentOutcomes: [outcome({ strategy: { explanationApproach: "example-first" } })],
      conversationState: {
        conversationId: "conversation-1",
        courseId: "course-1",
        recentMessages: [{
          id: "message-1", conversationId: "conversation-1", sequence: 1,
          turnId: "turn-1", role: "user",
          content: "Why does induction prove every natural number?",
          agentId: null, metadata: null, tokenEstimate: 9,
          createdAt: "2026-09-15T10:00:00.000Z",
        }],
        relevantHistoricalMessages: [],
        metadata: {
          recentMessagesUsed: 1, historicalMessagesUsed: 0, summaryUsed: false,
          estimatedConversationTokens: 20, compressionTriggered: false,
          targetConversationTokens: 2800, totalAssembledContextEstimate: 120,
        },
      },
    });
    expect(result).toMatchObject({ responseDepth: "foundational", explanationApproach: "step-by-step" });
  });

  it("raises Quiz difficulty only after several strong results", () => {
    const performances = Array.from({ length: 4 }, (_, index) => outcome({
      id: `quiz-${index}`, agentId: "quiz", outcomeType: "quiz-performance",
      strategyKey: "quiz:medium:short-answer", strategy: { difficulty: "medium", questionMix: ["short-answer"] },
      score: 0.9, successful: true, createdAt: `2026-09-15T0${index}:00:00.000Z`,
    }));
    expect(strategy("quiz", "Quiz me", { learning: learning(topic(72, 85)) }, performances).difficulty).toBe("hard");
  });

  it("reduces Quiz difficulty after several weak results", () => {
    const performances = Array.from({ length: 3 }, (_, index) => outcome({
      id: `quiz-${index}`, agentId: "quiz", outcomeType: "quiz-performance",
      strategyKey: "quiz:hard:short-answer", strategy: { difficulty: "hard", questionMix: ["short-answer"] },
      score: 0.3, successful: false, createdAt: `2026-09-15T0${index}:00:00.000Z`,
    }));
    const result = strategy("quiz", "Quiz me", { learning: learning(topic(90, 90)) }, performances);
    expect(result.difficulty).toBe("medium");
  });

  it("uses a diverse diagnostic mix when confidence is low", () => {
    const result = strategy("quiz", "Quiz me on induction", { learning: learning(topic(45, 20)) });
    expect(result.diagnosticMode).toBe(true);
    expect(result.questionMix).toEqual(["multiple-choice", "short-answer", "true-false"]);
  });

  it("emphasizes written questions when selected-response evidence is stronger", () => {
    const performances = [
      ...Array.from({ length: 2 }, (_, i) => outcome({ id: `mc-${i}`, agentId: "quiz", outcomeType: "quiz-performance", strategy: { questionMix: ["multiple-choice"] }, score: 1, successful: true })),
      ...Array.from({ length: 2 }, (_, i) => outcome({ id: `sa-${i}`, agentId: "quiz", outcomeType: "quiz-performance", strategy: { questionMix: ["short-answer"] }, score: 0.3, successful: false })),
    ];
    const result = strategy("quiz", "Quiz me", { learning: learning(topic(65, 80)) }, performances);
    expect(result.questionMix?.[0]).toBe("short-answer");
    expect(result.questionMix).toContain("long-answer");
  });

  it("deepens Quiz feedback after repeated errors and recommends Tutor", () => {
    const failures = Array.from({ length: 3 }, (_, i) => outcome({
      id: `failure-${i}`, agentId: "quiz", outcomeType: "quiz-performance",
      strategy: { questionMix: ["short-answer"] }, score: 0.2, successful: false,
    }));
    const result = strategy("quiz", "Quiz me", { learning: learning(topic(50, 80)) }, failures);
    expect(result.feedbackStyle).toBe("deep-remediation");
    expect(result.escalationStrategy).toBe("recommend-tutor");
  });

  it("reduces planner intensity after repeated skipped sessions", () => {
    const skipped = Array.from({ length: 4 }, (_, i) => outcome({
      id: `skip-${i}`, agentId: "study-planner", outcomeType: "study-task-skipped",
      strategyKey: "study-session:60", strategy: { recommendedSessionMinutes: 60 }, successful: false,
    }));
    const result = strategy("study-planner", "Update my plan", {}, skipped);
    expect(result.planningIntensity).toBe("light");
  });

  it("maintains a realistic workload after consistent plan completion", () => {
    const completed = Array.from({ length: 5 }, (_, i) => outcome({
      id: `done-${i}`, agentId: "study-planner", outcomeType: "study-task-completed",
      strategyKey: "study-session:45", strategy: { recommendedSessionMinutes: 45 }, successful: true,
    }));
    const result = strategy("study-planner", "Plan my week", {}, completed);
    expect(result.planningIntensity).toBe("moderate");
    expect(result.recommendedSessionMinutes).toBe(45);
  });

  it("temporarily recommends shorter sessions based on actual completion behavior", () => {
    const outcomes = [
      outcome({ agentId: "study-planner", outcomeType: "study-task-completed", strategy: { recommendedSessionMinutes: 30 }, successful: true }),
      ...Array.from({ length: 3 }, () => outcome({ agentId: "study-planner", outcomeType: "study-task-skipped", strategy: { recommendedSessionMinutes: 60 }, successful: false })),
    ];
    const result = strategy("study-planner", "Rebalance my plan", {}, outcomes);
    expect(result.recommendedSessionMinutes).toBe(30);
  });

  it("avoids a recently rejected Academic Manager recommendation", () => {
    const recent = [outcome({
      agentId: "academic-manager", outcomeType: "recommendation",
      action: "Take another quiz", strategyKey: "manager", strategy: { recommendedAgent: "quiz" },
    })];
    const result = strategy("academic-manager", "I already tried that quiz and it did not work", {}, recent);
    expect(result.metadata.avoidRecommendationActions).toEqual(["Take another quiz"]);
    expect(result.escalationStrategy).toBe("weak-topic-recovery");
  });

  it("changes Academic Manager intensity as an exam becomes imminent", () => {
    const result = strategy("academic-manager", "What should I do?", {
      exams: [{
        id: "exam-1", title: "Final", examDate: "2026-09-16T12:00:00.000Z",
        topics: ["Induction"], daysRemaining: 1,
        course: { id: "course-1", courseCode: "MATH 1240", courseName: "Discrete Math" },
      }],
    });
    expect(result.planningIntensity).toBe("high");
    expect(result.recommendations.join(" ")).toContain("imminent");
  });

  it("switches Notes to exam-review mode near an exam", () => {
    const result = strategy("notes", "Make review notes", {
      exams: [{
        id: "exam-1", title: "Midterm", examDate: "2026-09-18T12:00:00.000Z",
        topics: [], daysRemaining: 3,
        course: { id: "course-1", courseCode: "MATH 1240", courseName: "Discrete Math" },
      }],
    });
    expect(result.noteMode).toBe("exam-review");
  });

  it("recomputes Career focus when current project evidence closes an old gap", () => {
    const result = strategy("career", "What should I improve next?", {
      career: {
        profile: {
          updatedAt: "2026-09-15T00:00:00.000Z", careerGoal: "Backend engineer",
          targetRoles: ["Backend Engineer"], targetIndustries: [], experiences: [],
          portfolioLinks: [], resumeText: null,
        },
        projects: [{
          id: "project-1", updatedAt: "2026-09-15T00:00:00.000Z", evidenceId: "project:1",
          name: "API", description: "Built a backend API", technologies: ["Node.js"],
          role: "Developer", outcomes: [], link: null, repositoryUrl: null, course: null,
        }],
        skills: [], academicEvidence: [], limitations: [],
      },
    });
    expect(result.careerFocus).toBe("resume");
  });

  it("lets the current explicit difficulty request override low mastery", () => {
    const result = strategy("quiz", "Give me hard induction questions", { learning: learning(topic(20, 90)) });
    expect(result.difficulty).toBe("hard");
  });

  it("keeps short-term adaptation pure and does not mutate context or outcomes", () => {
    const userContext = context({ learning: learning(topic(25, 80)) });
    const outcomes = [outcome()];
    const beforeContext = structuredClone(userContext);
    const beforeOutcomes = structuredClone(outcomes);
    buildAdaptiveStrategy({
      agentId: "tutor", request: "I still don't understand",
      personalization: personalization(), context: userContext, recentOutcomes: outcomes,
    });
    expect(userContext).toEqual(beforeContext);
    expect(outcomes).toEqual(beforeOutcomes);
  });
});

describe.sequential("Adaptive outcome persistence", () => {
  const userIds: string[] = [];

  afterAll(async () => {
    if (userIds.length) await db().user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("uses repeated successful outcomes as Memory observations instead of direct preference writes", async () => {
    const userId = randomUUID();
    userIds.push(userId);
    await db().user.create({ data: { id: userId, name: "Adaptive Student", email: `${userId}@example.test` } });
    for (let index = 0; index < 3; index++) {
      await recordAdaptiveOutcome({
        userId, agentId: "tutor", strategyKey: "tutor:worked-example",
        strategy: { explanationApproach: "worked-example" },
        outcomeType: "explicit-understanding", successful: true,
        evidenceKey: `success:${index}`,
        memoryCandidate: {
          key: "tutor-worked-example",
          value: "worked-example was explicitly helpful for learning",
          source: "Repeated explicit Agent strategy success",
        },
      });
    }
    const memory = await db().userMemory.findUnique({
      where: { userId_category_key: { userId, category: "SUCCESSFUL_STRATEGY", key: "tutor-worked-example" } },
      include: { observations: true },
    });
    expect(memory).toMatchObject({ status: "ACTIVE", sourceType: "SYSTEM_DERIVED" });
    expect(memory?.observations).toHaveLength(3);
  });

  it("enforces user ownership for outcome references and retrieval", async () => {
    const ownerId = randomUUID();
    const otherId = randomUUID();
    userIds.push(ownerId, otherId);
    await db().user.createMany({ data: [
      { id: ownerId, name: "Owner", email: `${ownerId}@example.test` },
      { id: otherId, name: "Other", email: `${otherId}@example.test` },
    ] });
    const otherCourse = await db().course.create({ data: {
      userId: otherId, courseCode: "OTHER", courseName: "Private", semester: "Fall 2026",
    } });
    await expect(recordAdaptiveOutcome({
      userId: ownerId, agentId: "quiz", courseId: otherCourse.id,
      strategyKey: "quiz:medium", strategy: { difficulty: "medium" },
      outcomeType: "quiz-performance", score: 1, successful: true,
      evidenceKey: "foreign-course",
    })).rejects.toThrow("ADAPTIVE_REFERENCE_NOT_FOUND");
    await recordAdaptiveOutcome({
      userId: otherId, agentId: "quiz", courseId: otherCourse.id,
      strategyKey: "quiz:medium", strategy: { difficulty: "medium" },
      outcomeType: "quiz-performance", score: 1, successful: true,
      evidenceKey: "owned-course",
    });
    expect(await getRecentAdaptiveOutcomes({ userId: ownerId, agentId: "quiz" })).toHaveLength(0);
    expect(await getRecentAdaptiveOutcomes({ userId: otherId, agentId: "quiz" })).toHaveLength(1);
  });
});

describe("AgentExecutor adaptive integration", () => {
  it("injects one resolved strategy before generation so workflows inherit it", async () => {
    const userContext = context({ learning: learning(topic(25, 90)) });
    buildContext.mockResolvedValueOnce(userContext);
    const generateText = vi.fn<AIProvider["generateText"]>().mockResolvedValue({
      id: "response-1", model: "adaptive-test", text: "Explanation",
    });
    const provider: AIProvider = {
      generateText,
      generateStructuredOutput: vi.fn() as AIProvider["generateStructuredOutput"],
      streamText: vi.fn() as AIProvider["streamText"],
      generateEmbedding: vi.fn() as AIProvider["generateEmbedding"],
    };
    const registry = new AgentRegistry();
    registry.register(getTutorAgentDefinition());
    const executor = new AgentExecutor(registry, { getProvider: () => provider });
    const result = await executor.execute(
      { agentId: "tutor", request: "Explain mathematical induction" },
      new Headers({ cookie: "missing-test-session" }),
    );
    const system = generateText.mock.calls[0][0].messages[0].content;
    expect(system.match(/\[ADAPTATION\]/g)).toHaveLength(1);
    expect(system).toContain('"explanationApproach":"worked-example"');
    expect(result.metadata?.adaptiveStrategyKey).toContain("tutor:worked-example");
  });
});
