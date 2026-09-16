import { describe, expect, it } from "vitest";
import {
  buildPersonalizationProfile,
  formatPersonalizationForAI,
  PERSONALIZATION_CONFIG,
  type PersonalizationProfile,
} from "@/server/personalization";
import { formatContextForAI } from "@/server/context/format";
import type {
  ContextData,
  LearningTopicContext,
  MemoryContext,
  UserContext,
} from "@/server/context/types";
import { createPlanningBrief } from "@/server/agents/study-planner/priority";

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
      maxCharacters: 24000,
    },
  };
}

function memory(
  key: string,
  value: MemoryContext["value"],
  options: Partial<MemoryContext> = {},
): MemoryContext {
  return {
    id: `memory-${key}-${options.sourceType ?? "explicit"}`,
    category: "preference",
    key,
    value,
    sourceType: "explicit",
    confidence: 95,
    importance: 80,
    stale: false,
    lastUpdated: "2026-09-14T00:00:00.000Z",
    explanation: "fixture",
    ...options,
  };
}

function topic(
  mastery: number,
  confidence: number,
): LearningTopicContext {
  return {
    topicId: "topic-1",
    topic: "Induction",
    course: { id: "course-1", courseCode: "MATH 1240", courseName: "Discrete Math" },
    mastery,
    confidence,
    recentAccuracy: mastery,
    questionsAttempted: confidence < 20 ? 1 : 10,
    practiceSessions: confidence < 20 ? 1 : 3,
    status: mastery < 40 ? "weak" : mastery >= 85 ? "strong" : "developing",
    evidence: confidence >= 60 ? "sufficient" : "limited",
    trend: "stable",
    lastPracticedAt: "2026-09-14T00:00:00.000Z",
  };
}

function learning(mastery: number, confidence: number): ContextData["learning"] {
  const item = topic(mastery, confidence);
  return {
    weakTopics: mastery < 40 ? [item] : [],
    strongTopics: mastery >= 85 ? [item] : [],
    recommendedTopics: [{ ...item, reasons: [mastery < 40 ? "low-mastery" : "stale-practice"] }],
  };
}

function build(
  agentId: string,
  request = "Help me",
  data: ContextData = {},
): PersonalizationProfile {
  return buildPersonalizationProfile({ agentId, request, context: context(data) });
}

describe("Personalization Engine", () => {
  it("builds deterministic defaults without an AI call", () => {
    const profile = build("tutor");
    expect(profile.explanationDepth).toMatchObject({ value: "intermediate", source: "default" });
    expect(profile.preferredAnswerLength?.value).toBe("medium");
    expect(PERSONALIZATION_CONFIG.softConfidence).toBe(60);
  });

  it("returns only Tutor-relevant explanation and learning behavior", () => {
    const profile = build("tutor", "Explain it", {
      memories: [memory("explanationStyle", "concise-with-examples")],
      learning: learning(30, 90),
    });
    expect(profile.explanationStyle?.value).toBe("concise-with-examples");
    expect(profile.examplePreference?.value).toBe("example-first");
    expect(profile.weakTopicBehavior?.value).toBe("foundational-review");
    expect(profile.quizDifficulty).toBeUndefined();
    expect(profile.noteStyle).toBeUndefined();
  });

  it("returns only Notes style, structure and detail", () => {
    const profile = build("notes", "Make detailed notes", {
      memories: [memory("noteStyle", "definitions-first")],
    });
    expect(profile.noteStyle).toMatchObject({ value: "detailed", source: "current-request" });
    expect(profile.noteDetail?.value).toBe("detailed");
    expect(profile.explanationDepth).toBeUndefined();
    expect(profile.studySessionMinutes).toBeUndefined();
  });

  it("returns only Quiz assessment preferences and learning adaptation", () => {
    const profile = build("quiz", "Quiz me", {
      memories: [memory("questionType", "multiple-choice")],
      learning: learning(55, 85),
    });
    expect(profile.preferredQuestionTypes?.value).toEqual(["multiple-choice"]);
    expect(profile.recommendedDifficulty?.value).toBe("medium");
    expect(profile.confidenceHandling?.value).toBe("balanced");
    expect(profile.preferredAnswerLength).toBeUndefined();
  });

  it("returns Study Planner session, intensity, goals and strategies", () => {
    const profile = build("study-planner", "Plan my week", {
      profile: {
        name: "Student", school: "U", program: "Math", currentYear: 2,
        semester: "Fall", academicGoal: "Earn an A", explanationDifficulty: "INTERMEDIATE",
        studySessionMinutes: 60, timezone: "UTC",
      },
      memories: [
        memory("planningIntensity", "intensive"),
        memory("studySessionMinutes", 30),
        memory("workedExamples", "worked example before practice", { category: "successful-strategy" }),
      ],
    });
    expect(profile.studySessionMinutes).toMatchObject({ value: 60, source: "explicit-profile" });
    expect(profile.planningIntensity?.value).toBe("intensive");
    expect(profile.academicGoals?.value).toEqual(["Earn an A"]);
    expect(profile.learningStrategies?.value).toEqual(["worked example before practice"]);
    expect(profile.quizDifficulty).toBeUndefined();
  });

  it("returns Academic Manager goals and communication guidance without hiding risks", () => {
    const profile = build("academic-manager", "Give me an overview", {
      memories: [memory("academicGoal", "Pass every course", { category: "academic-goal" })],
    });
    expect(profile.academicGoals?.value).toEqual(["Pass every course"]);
    expect(profile.communicationPreferences?.value).toEqual(["answer-length:medium"]);
    expect(profile.recommendedDifficulty).toBeUndefined();
  });

  it("returns Career goals and advice length only", () => {
    const profile = build("career", "Help with my career", {
      memories: [
        memory("targetRole", "Backend Engineer", { category: "career-goal" }),
        memory("targetIndustry", "Education Technology", { category: "career-goal" }),
      ],
    });
    expect(profile.careerGoals?.value).toMatchObject({
      targetRoles: ["Backend Engineer"],
      targetIndustry: "Education Technology",
    });
    expect(profile.studySessionMinutes).toBeUndefined();
  });

  it("lets an explicit request override stored memory", () => {
    const profile = build("quiz", "Give me an easy quiz", {
      memories: [memory("quizDifficulty", "hard")],
    });
    expect(profile.quizDifficulty).toMatchObject({ value: "easy", source: "current-request" });
    expect(profile.recommendedDifficulty).toMatchObject({ value: "easy", source: "current-request" });
    expect(profile.metadata.conflictsResolved).toContain("quizDifficulty:current-request>explicit-memory");
  });

  it("uses explicit memory over higher-scoring inferred memory", () => {
    const profile = build("tutor", "Explain this", {
      memories: [
        memory("answerLength", "detailed", { sourceType: "inferred", confidence: 85 }),
        memory("answerLength", "concise", { sourceType: "explicit", confidence: 80 }),
      ],
    });
    expect(profile.preferredAnswerLength).toMatchObject({ value: "concise", source: "explicit-memory" });
  });

  it("ignores inferred memory below the configured confidence floor", () => {
    const profile = build("notes", "Make notes", {
      memories: [memory("noteStyle", "exam-focused", { sourceType: "inferred", confidence: 59 })],
    });
    expect(profile.noteStyle).toMatchObject({ value: "structured", source: "default" });
    expect(profile.metadata.ignoredSignals).toContain("memory:noteStyle");
  });

  it("marks 60-79 inferred memory as a soft preference", () => {
    const profile = build("notes", "Make notes", {
      memories: [memory("noteStyle", "exam-focused", { sourceType: "inferred", confidence: 70 })],
    });
    expect(profile.noteStyle).toMatchObject({
      value: "exam-focused",
      source: "inferred-memory",
      strength: "soft",
    });
  });

  it("lets current request override a hard task setting, then task override memory", () => {
    const userContext = context({ memories: [memory("quizDifficulty", "easy")] });
    const taskWins = buildPersonalizationProfile({
      agentId: "quiz", request: "Quiz me", context: userContext,
      task: { requiredDifficulty: "hard" },
    });
    expect(taskWins.quizDifficulty).toMatchObject({ value: "hard", source: "task-context" });
    const requestWins = buildPersonalizationProfile({
      agentId: "quiz", request: "Give me an easy quiz", context: userContext,
      task: { requiredDifficulty: "hard" },
    });
    expect(requestWins.quizDifficulty).toMatchObject({ value: "easy", source: "current-request" });
  });

  it("raises challenge when mastery and confidence are both high", () => {
    const profile = build("quiz", "Quiz me", { learning: learning(92, 95) });
    expect(profile.recommendedDifficulty).toMatchObject({ value: "hard", source: "learning-intelligence" });
    expect(profile.confidenceHandling?.value).toBe("challenge");
  });

  it("uses diagnostic behavior when learning confidence is low", () => {
    const profile = build("quiz", "Quiz me", { learning: learning(30, 15) });
    expect(profile.confidenceHandling?.value).toBe("diagnostic");
    expect(profile.weakTopicBehavior?.value).toBe("diagnostic-first");
    expect(profile.recommendedDifficulty?.value).toBe("medium");
  });

  it("moderates a hard stored preference when reliable mastery is low", () => {
    const profile = build("quiz", "Quiz me normally", {
      memories: [memory("quizDifficulty", "hard")],
      learning: learning(25, 90),
    });
    expect(profile.quizDifficulty).toMatchObject({ value: "hard", source: "explicit-memory" });
    expect(profile.recommendedDifficulty).toMatchObject({ value: "medium", source: "learning-intelligence" });
  });

  it("keeps hard availability above a preferred session length", () => {
    const userContext = context({
      profile: {
        name: "Student", school: "U", program: "Math", currentYear: 2,
        semester: "Fall", academicGoal: "Learn", explanationDifficulty: "INTERMEDIATE",
        studySessionMinutes: 60, timezone: "UTC",
      },
    });
    const personalization = buildPersonalizationProfile({ agentId: "study-planner", request: "What should I study now?", context: userContext });
    const brief = createPlanningBrief(userContext, {
      mode: "now", request: "What should I study now?", availableMinutes: 30,
    }, personalization);
    expect(brief.preferredSessionMinutes).toBe(60);
    expect(brief.totalAvailableMinutes).toBe(30);
    expect(brief.availability[0].availableMinutes).toBe(30);
  });

  it("removes duplicated preference/profile behavior from executor context formatting", () => {
    const userContext = context({
      profile: {
        name: "Student", school: "U", program: "Math", currentYear: 2,
        semester: "Fall", academicGoal: "Private goal", explanationDifficulty: "BEGINNER",
        studySessionMinutes: 60, timezone: "UTC",
      },
      memories: [memory("answerLength", "concise")],
    });
    const formatted = formatContextForAI(userContext, { omitPersonalizationSignals: true });
    expect(formatted).toContain('"program":"Math"');
    expect(formatted).not.toMatch(/PREFERENCES|answerLength|explanationDifficulty|studySessionMinutes|Private goal/);
  });

  it("keeps Context Builder data factual and separately formatable", () => {
    const userContext = context({ memories: [memory("answerLength", "concise")] });
    expect(formatContextForAI(userContext)).toContain("[PREFERENCES]");
    expect(formatContextForAI(userContext, { omitPersonalizationSignals: true })).not.toContain("[PREFERENCES]");
  });

  it("is read-only and never changes memory or learning input", () => {
    const userContext = context({
      memories: [memory("quizDifficulty", "hard")],
      learning: learning(20, 90),
    });
    const before = structuredClone(userContext);
    buildPersonalizationProfile({ agentId: "quiz", request: "Quiz me", context: userContext });
    expect(userContext).toEqual(before);
  });

  it("produces a profile that AgentExecutor can add as one compact prompt section", () => {
    const profile = build("tutor", "Explain simply and keep it short", {
      memories: [memory("explanationStyle", "detailed-formal")],
    });
    const formatted = formatPersonalizationForAI(profile);
    expect(formatted.match(/\[PERSONALIZATION\]/g)).toHaveLength(1);
    expect(formatted).toContain('"depth":"beginner"');
    expect(formatted).toContain('"length":"concise"');
    expect(formatted).not.toMatch(/appliedSignals|conflictsResolved|memory-/);
  });

  it("uses the same agent-specific profile for workflow-dispatched agents", () => {
    const direct = build("tutor", "Explain induction simply", { learning: learning(30, 90) });
    const workflow = build("tutor", "Explain induction simply", { learning: learning(30, 90) });
    expect(workflow).toEqual(direct);
    expect(formatPersonalizationForAI(workflow)).toContain("[PERSONALIZATION]");
  });

  it("does not accept or emit identity and relies on authenticated UserContext ownership", () => {
    const profile = buildPersonalizationProfile({
      agentId: "career",
      request: "Career advice",
      context: context({ memories: [memory("targetRole", "Engineer", { category: "career-goal" })] }),
    });
    expect(profile.careerGoals?.value.targetRoles).toEqual(["Engineer"]);
    expect(JSON.stringify(profile)).not.toMatch(/userId|memory-targetRole/);
  });

  it("formats a bounded, machine-friendly profile without debug metadata", () => {
    const profile = build("study-planner", "Plan my week", {
      memories: [
        memory("planningIntensity", "moderate"),
        memory("strategy", "worked examples", { category: "successful-strategy" }),
      ],
    });
    const formatted = formatPersonalizationForAI(profile);
    expect(formatted.startsWith("[PERSONALIZATION]\n")).toBe(true);
    expect(formatted.length).toBeLessThan(800);
    expect(formatted).not.toMatch(/confidence|source|ignoredSignals/);
  });
});
