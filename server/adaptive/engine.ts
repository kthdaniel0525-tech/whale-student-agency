import "server-only";
import { ADAPTIVE_CONFIG } from "./config";
import type {
  AdaptiveCareerFocus,
  AdaptiveDifficulty,
  AdaptiveOutcomeRecord,
  AdaptiveQuestionType,
  AdaptiveStrategy,
  BuildAdaptiveStrategyInput,
  ExplanationApproach,
} from "./types";
import type { LearningTopicContext } from "../context/types";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function allTopics(input: BuildAdaptiveStrategyInput): LearningTopicContext[] {
  const learning = input.context.learning;
  if (!learning) return [];
  const result = new Map<string, LearningTopicContext>();
  for (const topic of [
    ...(learning.examTopics ?? []),
    ...learning.recommendedTopics,
    ...learning.weakTopics,
    ...learning.strongTopics,
  ]) {
    if (!result.has(topic.topicId)) result.set(topic.topicId, topic);
  }
  return [...result.values()];
}

function targetTopic(input: BuildAdaptiveStrategyInput): LearningTopicContext | undefined {
  const request = normalize(input.request);
  const topics = allTopics(input);
  return (
    topics.find((topic) => request.includes(normalize(topic.topic))) ??
    input.context.learning?.recommendedTopics[0] ??
    input.context.learning?.weakTopics[0] ??
    input.context.learning?.strongTopics[0]
  );
}

function explicitConfusion(request: string): boolean {
  return /\b(?:still (?:do not|don't|cannot|can't) understand|does(?: not|n't) make sense|confused|lost|another explanation|explain (?:it )?again|simpler)\b|이해(?:가)? 안|모르겠|헷갈|다시 설명|더 쉽게/i.test(request);
}

function explicitUnderstanding(request: string): boolean {
  return /\b(?:that helped|i understand now|makes sense now|got it now|that example worked|now i get it)\b|이제 이해|도움(?:이)? 됐|알겠어|예시가 좋/i.test(request);
}

function words(value: string): Set<string> {
  return new Set(normalize(value).match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

function repeatedQuestion(input: BuildAdaptiveStrategyInput): boolean {
  const current = words(input.request);
  if (current.size < 2) return false;
  return Boolean(input.conversationState?.recentMessages
    .filter((message) => message.role === "user")
    .slice(-6)
    .some((message) => {
      const previous = words(message.content);
      const overlap = [...current].filter((word) => previous.has(word)).length;
      return overlap / Math.max(1, Math.min(current.size, previous.size)) >= 0.65;
    }));
}

function explicitApproach(request: string): ExplanationApproach | undefined {
  const value = normalize(request);
  if (/\b(?:analogy|metaphor)\b|비유/.test(value)) return "analogy";
  if (/\b(?:worked example|solve (?:one|an) example)\b|풀이 예시/.test(value)) return "worked-example";
  if (/\b(?:step[- ]by[- ]step|one step at a time)\b|단계별/.test(value)) return "step-by-step";
  if (/\b(?:example first|with (?:an )?example|show me an example)\b|예시(?:부터|로)/.test(value)) return "example-first";
  if (/\b(?:formal|rigorous|proof)\b|엄밀|형식적/.test(value)) return "formal";
  if (/\b(?:simple|intuitive|plain language)\b|쉽게|직관적/.test(value)) return "intuitive";
  if (/\b(?:concise|quick review|briefly)\b|간단히|짧게/.test(value)) return "concise-review";
  return undefined;
}

function nextApproach(previous?: ExplanationApproach): ExplanationApproach {
  const changes: Partial<Record<ExplanationApproach, ExplanationApproach>> = {
    formal: "intuitive",
    intuitive: "worked-example",
    "example-first": "step-by-step",
    "worked-example": "analogy",
    "step-by-step": "worked-example",
    analogy: "step-by-step",
    "concise-review": "worked-example",
  };
  return (previous && changes[previous]) || "worked-example";
}

function previousOutcome(
  outcomes: readonly AdaptiveOutcomeRecord[],
): AdaptiveOutcomeRecord | undefined {
  return outcomes.find((outcome) => outcome.outcomeType === "agent-response");
}

function difficultyStep(
  difficulty: AdaptiveDifficulty,
  direction: -1 | 1,
): AdaptiveDifficulty {
  const values: AdaptiveDifficulty[] = ["easy", "medium", "hard"];
  return values[clamp(values.indexOf(difficulty) + direction, 0, values.length - 1)];
}

function requestedDifficulty(request: string): AdaptiveDifficulty | undefined {
  const value = normalize(request);
  if (/\b(?:hard|harder|difficult|challenge)\b|어렵|고난도/.test(value)) return "hard";
  if (/\b(?:easy|easier|beginner)\b|쉽게|쉬운/.test(value)) return "easy";
  if (/\bmedium\b|중간 난이도/.test(value)) return "medium";
  return undefined;
}

function questionType(value: unknown): AdaptiveQuestionType | undefined {
  return typeof value === "string" && [
    "multiple-choice", "true-false", "short-answer", "long-answer",
  ].includes(value) ? value as AdaptiveQuestionType : undefined;
}

function quizStrategy(
  input: BuildAdaptiveStrategyInput,
  topic: LearningTopicContext | undefined,
  outcomes: readonly AdaptiveOutcomeRecord[],
) {
  let difficulty: AdaptiveDifficulty =
    input.personalization.recommendedDifficulty?.value ??
    input.personalization.quizDifficulty?.value ??
    "medium";
  let diagnosticMode = false;
  const reasons: string[] = [];
  if (topic) {
    if (topic.confidence < ADAPTIVE_CONFIG.lowConfidence) {
      diagnosticMode = true;
      reasons.push("Learning confidence is low, so measurement comes before challenge.");
    } else if (topic.mastery < ADAPTIVE_CONFIG.lowMastery) {
      difficulty = "easy";
      reasons.push("Supported low mastery calls for a bounded easier starting point.");
    } else if (topic.mastery >= ADAPTIVE_CONFIG.strongMastery) {
      difficulty = "hard";
      reasons.push("High mastery with sufficient confidence supports challenge questions.");
    }
  }
  const performances = outcomes
    .filter((outcome) => outcome.outcomeType === "quiz-performance" && outcome.score !== null)
    .slice(0, 10);
  if (performances.length >= ADAPTIVE_CONFIG.minimumQuizEvidence) {
    const accuracy = performances.reduce((sum, item) => sum + (item.score ?? 0), 0) / performances.length;
    if (
      accuracy >= ADAPTIVE_CONFIG.highQuizAccuracy &&
      performances.length >= ADAPTIVE_CONFIG.minimumDifficultyIncreaseEvidence &&
      (topic?.confidence ?? 100) >= ADAPTIVE_CONFIG.sufficientConfidence
    ) {
      difficulty = difficultyStep(difficulty, 1);
      reasons.push("Several recent answers were accurate, so difficulty increases one level.");
    } else if (accuracy < ADAPTIVE_CONFIG.lowQuizAccuracy) {
      difficulty = difficultyStep(difficulty, -1);
      diagnosticMode ||= performances.some((item) => (item.score ?? 0) >= 0.8);
      reasons.push("Several recent answers were weak or inconsistent, so challenge is reduced.");
    }
  }
  const byType = new Map<AdaptiveQuestionType, number[]>();
  for (const outcome of performances) {
    const type = questionType(outcome.strategy.questionMix?.[0]);
    if (type && outcome.score !== null) byType.set(type, [...(byType.get(type) ?? []), outcome.score]);
  }
  const averages = [...byType].map(([type, scores]) => ({
    type,
    count: scores.length,
    average: scores.reduce((sum, score) => sum + score, 0) / scores.length,
  }));
  const weakWritten = averages
    .filter((item) => ["short-answer", "long-answer"].includes(item.type) && item.count >= 2)
    .sort((a, b) => a.average - b.average)[0];
  const strongChoice = averages
    .filter((item) => ["multiple-choice", "true-false"].includes(item.type) && item.count >= 2)
    .sort((a, b) => b.average - a.average)[0];
  let questionMix: AdaptiveQuestionType[] = diagnosticMode
    ? ["multiple-choice", "short-answer", "true-false"]
    : (input.personalization.preferredQuestionTypes?.value ?? [])
        .map(questionType)
        .filter((value): value is AdaptiveQuestionType => Boolean(value));
  if (!questionMix.length) questionMix = ["short-answer", "multiple-choice"];
  if (weakWritten && strongChoice && weakWritten.average + 0.2 < strongChoice.average) {
    questionMix = ([weakWritten.type, "long-answer", strongChoice.type] as AdaptiveQuestionType[])
      .filter((value, index, all) => all.indexOf(value) === index);
    reasons.push("Written responses lag selected-response evidence, so the mix emphasizes recall and explanation.");
  }
  const failures = performances.filter((item) => (item.score ?? 0) < 0.6).length;
  const explicit = requestedDifficulty(input.request);
  if (explicit) {
    difficulty = explicit;
    reasons.push("The current request explicitly sets quiz difficulty.");
  }
  return {
    difficulty,
    diagnosticMode,
    questionMix,
    feedbackStyle: failures >= 2 ? "deep-remediation" as const : failures ? "guided-feedback" as const : "brief-correction" as const,
    practiceIntensity: diagnosticMode ? "moderate" as const : difficulty === "hard" ? "high" as const : "moderate" as const,
    escalationStrategy: failures >= 2 ? "recommend-tutor" as const : "none" as const,
    retryStrategy: diagnosticMode ? "diagnose-first" as const : "maintain" as const,
    reasons,
  };
}

function tutorStrategy(
  input: BuildAdaptiveStrategyInput,
  topic: LearningTopicContext | undefined,
  outcomes: readonly AdaptiveOutcomeRecord[],
) {
  let responseDepth: AdaptiveStrategy["responseDepth"] = "standard";
  let explanationApproach: ExplanationApproach = "example-first";
  let measurableStateResolved = false;
  const reasons: string[] = [];
  if (topic && topic.mastery < ADAPTIVE_CONFIG.lowMastery && topic.confidence >= ADAPTIVE_CONFIG.lowConfidence) {
    responseDepth = "foundational";
    explanationApproach = "worked-example";
    measurableStateResolved = true;
    reasons.push("Supported low mastery calls for foundation repair and a worked example.");
  } else if (topic && topic.mastery >= ADAPTIVE_CONFIG.strongMastery && topic.confidence >= ADAPTIVE_CONFIG.sufficientConfidence) {
    responseDepth = "advanced";
    explanationApproach = "formal";
    measurableStateResolved = true;
    reasons.push("Strong, well-supported mastery allows more rigor and edge cases.");
  } else if (topic && topic.confidence < ADAPTIVE_CONFIG.lowConfidence) {
    explanationApproach = "intuitive";
    measurableStateResolved = true;
    reasons.push("Limited evidence favors an accessible explanation plus a check for understanding.");
  }
  if (!measurableStateResolved) {
    const depth = input.personalization.explanationDepth?.value;
    const length = input.personalization.preferredAnswerLength?.value;
    if (depth === "beginner") responseDepth = "foundational";
    else if (depth === "advanced") responseDepth = "advanced";
    else if (length === "concise") responseDepth = "concise";
  }
  const preferred = input.personalization.explanationStructure?.value;
  if (!measurableStateResolved && (preferred === "step-by-step" || preferred === "example-first")) explanationApproach = preferred;
  if (!measurableStateResolved && input.personalization.explanationRigor?.value === "formal") explanationApproach = "formal";
  if (!measurableStateResolved && input.personalization.explanationRigor?.value === "intuitive") explanationApproach = "intuitive";
  const previous = previousOutcome(outcomes);
  const priorApproach = previous?.strategy.explanationApproach;
  const misunderstanding = explicitConfusion(input.request) || repeatedQuestion(input);
  if (misunderstanding) {
    explanationApproach = nextApproach(priorApproach);
    responseDepth = "foundational";
    reasons.push("The prior explanation was not sufficient, so this turn switches approach.");
  }
  const explicit = explicitApproach(input.request);
  if (explicit) {
    explanationApproach = explicit;
    reasons.push("The current request explicitly chooses the explanation approach.");
  }
  return {
    responseDepth,
    explanationApproach,
    feedbackStyle: misunderstanding ? "deep-remediation" as const : "guided-feedback" as const,
    practiceIntensity: topic?.mastery && topic.mastery >= 70 ? "light" as const : "moderate" as const,
    diagnosticMode: Boolean(topic && topic.confidence < ADAPTIVE_CONFIG.lowConfidence),
    retryStrategy: misunderstanding ? "switch-approach" as const : "maintain" as const,
    escalationStrategy: misunderstanding ? "check-understanding" as const : "none" as const,
    priorApproach,
    priorStrategyKey: previous?.strategyKey,
    reasons,
  };
}

function plannerStrategy(
  input: BuildAdaptiveStrategyInput,
  outcomes: readonly AdaptiveOutcomeRecord[],
) {
  const taskOutcomes = outcomes.filter((outcome) =>
    outcome.outcomeType === "study-task-completed" || outcome.outcomeType === "study-task-skipped",
  ).slice(0, 14);
  const completed = taskOutcomes.filter((outcome) => outcome.outcomeType === "study-task-completed");
  const skipped = taskOutcomes.filter((outcome) => outcome.outcomeType === "study-task-skipped");
  const preferred = input.personalization.studySessionMinutes?.value ?? input.context.profile?.studySessionMinutes ?? 45;
  let recommendedSessionMinutes = preferred;
  let planningIntensity: AdaptiveStrategy["planningIntensity"] =
    input.personalization.planningIntensity?.value === "intensive" ? "high" :
      input.personalization.planningIntensity?.value === "light" ? "light" : "moderate";
  const reasons: string[] = [];
  if (taskOutcomes.length >= ADAPTIVE_CONFIG.minimumPlanningEvidence) {
    const completionRate = completed.length / taskOutcomes.length;
    if (completionRate < 0.45) {
      planningIntensity = "light";
      const completedDurations = completed.map((item) => item.strategy.recommendedSessionMinutes).filter((value): value is number => Boolean(value));
      const skippedDurations = skipped.map((item) => item.strategy.recommendedSessionMinutes).filter((value): value is number => Boolean(value));
      const candidate = completedDurations.length
        ? completedDurations.sort((a, b) => a - b)[Math.floor(completedDurations.length / 2)]
        : skippedDurations.length ? Math.min(...skippedDurations) * 0.67 : preferred * 0.75;
      recommendedSessionMinutes = clamp(Math.round(candidate / 5) * 5, 15, preferred);
      reasons.push("Repeated skipped work calls for fewer, shorter sessions instead of added workload.");
    } else if (completionRate >= 0.8) {
      planningIntensity = planningIntensity === "light" ? "moderate" : planningIntensity;
      reasons.push("Consistent completion supports maintaining a realistic moderate workload.");
    }
  }
  if (/\b(?:intensive|cram|maximum effort)\b|집중적으로|빡세게/i.test(input.request)) {
    planningIntensity = "high";
    reasons.push("The current request explicitly asks for an intensive plan.");
  } else if (/\b(?:light|manageable|less work)\b|가볍게|부담 없이/i.test(input.request)) {
    planningIntensity = "light";
    reasons.push("The current request explicitly asks for a lighter plan.");
  }
  return { planningIntensity, recommendedSessionMinutes, reasons };
}

function nearestExamDays(input: BuildAdaptiveStrategyInput): number | undefined {
  const values = input.context.exams?.map((exam) => exam.daysRemaining).filter((days) => days >= 0) ?? [];
  return values.length ? Math.min(...values) : undefined;
}

function managerStrategy(
  input: BuildAdaptiveStrategyInput,
  outcomes: readonly AdaptiveOutcomeRecord[],
) {
  const reasons: string[] = [];
  const days = nearestExamDays(input);
  const failed = /\b(?:already tried|did(?: not|n't) work|not helping|still failing|same advice)\b|이미 했|효과 없|도움 안|같은 추천/i.test(input.request);
  const recentRecommendations = outcomes
    .filter((outcome) => outcome.outcomeType === "recommendation" && outcome.action)
    .slice(0, 4)
    .map((outcome) => outcome.action!);
  const avoid = failed ? [...new Set(recentRecommendations)] : [];
  if (avoid.length) reasons.push("Recent advice was explicitly rejected, so repeating it is avoided.");
  if (days !== undefined && days <= 1) reasons.push("An exam is imminent, so targeted review and practice outrank broad repair work.");
  else if (days !== undefined && days <= 14) reasons.push("An upcoming exam keeps weak-concept repair and practice high priority.");
  return {
    responseDepth:
      input.personalization.preferredAnswerLength?.value === "detailed"
        ? "standard" as const
        : "concise" as const,
    planningIntensity: days !== undefined && days <= 7 ? "high" as const : "moderate" as const,
    escalationStrategy: failed ? "weak-topic-recovery" as const : "none" as const,
    avoid,
    reasons,
  };
}

function notesStrategy(input: BuildAdaptiveStrategyInput, topic?: LearningTopicContext) {
  const request = normalize(input.request);
  const days = nearestExamDays(input);
  let noteMode: AdaptiveStrategy["noteMode"] = "structured-review";
  let responseDepth: AdaptiveStrategy["responseDepth"] = "standard";
  const reasons: string[] = [];
  const preferredMode = input.personalization.noteStyle?.value;
  if (preferredMode === "exam-focused") noteMode = "exam-review";
  else if (preferredMode === "concept-first" || preferredMode === "detailed") noteMode = "concept-learning";
  else if (preferredMode === "concise") noteMode = "concise-maintenance";
  if (input.personalization.noteDetail?.value === "concise") responseDepth = "concise";
  if (input.personalization.noteDetail?.value === "detailed") responseDepth = "foundational";
  if (/\b(?:exam|midterm|final|test review)\b|시험|중간고사|기말/.test(request) || (days !== undefined && days <= 7)) {
    noteMode = "exam-review";
    reasons.push("Exam proximity or the explicit use case calls for retrieval-oriented review notes.");
  } else if (topic && topic.mastery < 70 && topic.confidence >= ADAPTIVE_CONFIG.lowConfidence) {
    noteMode = "concept-learning";
    responseDepth = "foundational";
    reasons.push("A supported learning gap calls for more explanation and examples in the notes.");
  } else if (topic && topic.mastery >= ADAPTIVE_CONFIG.strongMastery && topic.confidence >= ADAPTIVE_CONFIG.sufficientConfidence) {
    noteMode = "concise-maintenance";
    responseDepth = "concise";
    reasons.push("Strong mastery only needs compact maintenance notes.");
  }
  if (/\b(?:detailed|thorough)\b|자세히/.test(request)) responseDepth = "foundational";
  if (/\b(?:concise|brief|quick)\b|간단히|요약/.test(request)) responseDepth = "concise";
  return { noteMode, responseDepth, reasons };
}

function careerFocus(input: BuildAdaptiveStrategyInput): { focus: AdaptiveCareerFocus; reasons: string[] } {
  const request = normalize(input.request);
  const career = input.context.career;
  let focus: AdaptiveCareerFocus = "current-gap";
  const reasons: string[] = [];
  if (/\bresume\b|이력서/.test(request)) focus = "resume";
  else if (/\bportfolio\b|포트폴리오/.test(request)) focus = "portfolio";
  else if (/\binterview\b|면접/.test(request)) focus = "interview";
  else if (/\bapplications?|apply\b|지원/.test(request)) focus = "applications";
  else if (!career?.projects.length) focus = "projects";
  else if (!career.profile?.resumeText) focus = "resume";
  else if (!career.profile.portfolioLinks.length) focus = "portfolio";
  else focus = "interview";
  reasons.push("Career focus is recomputed from current evidence so resolved gaps are not repeated.");
  return { focus, reasons };
}

export function buildAdaptiveStrategy(
  input: BuildAdaptiveStrategyInput,
): AdaptiveStrategy {
  const outcomes = [...(input.recentOutcomes ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, ADAPTIVE_CONFIG.recentOutcomeLimit);
  const topic = targetTopic(input);
  let partial: Omit<AdaptiveStrategy, "recommendations" | "metadata"> & {
    reasons: string[];
    priorStrategyKey?: string;
    priorApproach?: ExplanationApproach;
    avoid?: string[];
  };
  if (input.agentId === "tutor") partial = tutorStrategy(input, topic, outcomes);
  else if (input.agentId === "quiz") partial = quizStrategy(input, topic, outcomes);
  else if (input.agentId === "study-planner") partial = plannerStrategy(input, outcomes);
  else if (input.agentId === "academic-manager") partial = managerStrategy(input, outcomes);
  else if (input.agentId === "notes") partial = notesStrategy(input, topic);
  else if (input.agentId === "career") {
    const career = careerFocus(input);
    partial = {
      careerFocus: career.focus,
      responseDepth:
        input.personalization.preferredAnswerLength?.value === "concise"
          ? "concise"
          : input.personalization.preferredAnswerLength?.value === "detailed"
            ? "advanced"
            : "standard",
      reasons: career.reasons,
    };
  } else {
    partial = { responseDepth: "standard", reasons: [] };
  }
  const {
    reasons,
    priorStrategyKey,
    priorApproach,
    avoid,
    ...strategy
  } = partial;
  const keyParts = [
    input.agentId,
    strategy.explanationApproach,
    strategy.difficulty,
    strategy.planningIntensity,
    strategy.noteMode,
    strategy.careerFocus,
    strategy.diagnosticMode ? "diagnostic" : undefined,
  ].filter(Boolean);
  const recommendations = reasons.slice(0, ADAPTIVE_CONFIG.maximumRecommendations);
  return {
    ...strategy,
    recommendations,
    metadata: {
      strategyKey: keyParts.join(":") || input.agentId,
      reasons: recommendations,
      evidenceCount: outcomes.length,
      shortTerm: true,
      ...(priorStrategyKey ? { priorStrategyKey } : {}),
      ...(priorApproach ? { priorExplanationApproach: priorApproach } : {}),
      ...(topic ? { selectedTopicId: topic.topicId, selectedCourseId: topic.course.id } : {}),
      ...(avoid?.length ? { avoidRecommendationActions: avoid } : {}),
    },
  };
}

export { explicitConfusion, explicitUnderstanding };
