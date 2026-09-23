import "server-only";
import { PERSONALIZATION_CONFIG } from "./config";
import { parseExplicitRequestPreferences } from "./request";
import type {
  AnswerLength,
  BuildPersonalizationInput,
  CareerGoals,
  ConfidenceHandling,
  ExplanationDepth,
  ExplanationRigor,
  ExplanationStructure,
  NoteStyle,
  PersonalizationProfile,
  PersonalizationSource,
  PersonalizedValue,
  PlanningIntensity,
  QuizDifficultyRecommendation,
  WeakTopicBehavior,
} from "./types";
import type { LearningTopicContext, MemoryContext } from "../context/types";

type Signal<T> = {
  value: T;
  source: PersonalizationSource;
  confidence: number;
  label: string;
};

const SOURCE_PRIORITY: Readonly<Record<PersonalizationSource, number>> = {
  "current-request": 700,
  "task-context": 600,
  "explicit-profile": 500,
  "explicit-memory": 400,
  "inferred-memory": 300,
  "learning-intelligence": 200,
  default: 100,
};

const FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  tutor: new Set(["explanationStyle", "explanationDepth", "preferredAnswerLength", "explanationStructure", "explanationRigor", "examplePreference", "learningStrategies", "weakTopicBehavior", "confidenceHandling"]),
  notes: new Set(["preferredAnswerLength", "noteStyle", "noteStructure", "noteDetail"]),
  quiz: new Set(["quizDifficulty", "recommendedDifficulty", "preferredQuestionTypes", "weakTopicBehavior", "confidenceHandling"]),
  "study-planner": new Set(["studySessionMinutes", "maxContinuousMinutes", "planningIntensity", "preferredStudyTime", "learningStrategies", "academicGoals"]),
  "academic-manager": new Set(["preferredAnswerLength", "planningIntensity", "learningStrategies", "academicGoals", "communicationPreferences"]),
  career: new Set(["preferredAnswerLength", "careerGoals", "communicationPreferences"]),
};

function strength(confidence: number): "normal" | "soft" {
  return confidence >= PERSONALIZATION_CONFIG.normalConfidence ? "normal" : "soft";
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return clean ? clean.slice(0, PERSONALIZATION_CONFIG.maximumGoalLength) : undefined;
}

function cleanStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(cleanString).filter((item): item is string => Boolean(item)))];
}

function memorySignal<T>(memory: MemoryContext, value: T): Signal<T> | undefined {
  if (memory.stale) return undefined;
  if (memory.sourceType !== "explicit" && memory.confidence < PERSONALIZATION_CONFIG.softConfidence) return undefined;
  return {
    value,
    source: memory.sourceType === "explicit" ? "explicit-memory" : "inferred-memory",
    confidence: memory.confidence,
    label: `memory:${memory.key}`,
  };
}

function memoryFor(context: BuildPersonalizationInput["context"], key: string): MemoryContext[] {
  return (context.memories ?? [])
    .filter((memory) => memory.key === key)
    .sort((a, b) => {
      const source = Number(b.sourceType === "explicit") - Number(a.sourceType === "explicit");
      return source || b.confidence - a.confidence || b.importance - a.importance;
    });
}

function choose<T>(
  field: string,
  signals: readonly (Signal<T> | undefined)[],
  state: { applied: string[]; ignored: string[]; conflicts: string[] },
): PersonalizedValue<T> | undefined {
  const usable = signals.filter((item): item is Signal<T> => Boolean(item));
  if (!usable.length) return undefined;
  const sorted = usable.slice().sort((a, b) =>
    SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source] || b.confidence - a.confidence,
  );
  const selected = sorted[0];
  state.applied.push(`${field}:${selected.label}`);
  for (const candidate of sorted.slice(1)) {
    if (JSON.stringify(candidate.value) !== JSON.stringify(selected.value)) {
      state.conflicts.push(`${field}:${selected.source}>${candidate.source}`);
    }
  }
  return {
    value: selected.value,
    source: selected.source,
    confidence: selected.confidence,
    strength: strength(selected.confidence),
  };
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const normalized = cleanString(value)?.toLocaleLowerCase();
  return allowed.find((item) => item === normalized);
}

function explanationStyleSignals(memory: MemoryContext): Partial<{
  style: string;
  length: AnswerLength;
  structure: ExplanationStructure;
  rigor: ExplanationRigor;
}> {
  const style = cleanString(memory.value)?.toLocaleLowerCase();
  if (!style) return {};
  return {
    style,
    ...(style.includes("concise") || style.includes("short") ? { length: "concise" as const } : {}),
    ...(style.includes("detailed") || style.includes("thorough") ? { length: "detailed" as const } : {}),
    ...(style.includes("example") ? { structure: "example-first" as const } : {}),
    ...(style.includes("step") ? { structure: "step-by-step" as const } : {}),
    ...(style.includes("formal") || style.includes("rigorous") ? { rigor: "formal" as const } : {}),
    ...(style.includes("intuitive") ? { rigor: "intuitive" as const } : {}),
  };
}

function learningTopics(context: BuildPersonalizationInput["context"]): LearningTopicContext[] {
  if (!context.learning) return [];
  const result = new Map<string, LearningTopicContext>();
  for (const item of [...context.learning.recommendedTopics, ...context.learning.weakTopics, ...context.learning.strongTopics]) {
    if (!result.has(item.topicId)) result.set(item.topicId, item);
  }
  return [...result.values()];
}

function learningAdaptation(topics: readonly LearningTopicContext[]) {
  const sufficient = topics.filter((topic) => topic.confidence >= PERSONALIZATION_CONFIG.softConfidence);
  const focus = sufficient.sort((a, b) => a.mastery - b.mastery || b.confidence - a.confidence)[0];
  if (!focus) {
    return topics.length
      ? { confidence: 65, handling: "diagnostic" as const, behavior: "diagnostic-first" as WeakTopicBehavior }
      : undefined;
  }
  if (focus.mastery < 40) {
    return {
      confidence: focus.confidence,
      difficulty: (focus.mastery < 25 ? "easy" : "medium") as QuizDifficultyRecommendation,
      depth: "beginner" as ExplanationDepth,
      structure: "example-first" as ExplanationStructure,
      handling: "balanced" as const,
      behavior: "foundational-review" as WeakTopicBehavior,
    };
  }
  if (focus.mastery < 70) {
    return {
      confidence: focus.confidence,
      difficulty: "medium" as QuizDifficultyRecommendation,
      handling: "balanced" as const,
      behavior: "targeted-practice" as WeakTopicBehavior,
    };
  }
  if (focus.mastery >= 85 && focus.confidence >= PERSONALIZATION_CONFIG.normalConfidence) {
    return {
      confidence: focus.confidence,
      difficulty: "hard" as QuizDifficultyRecommendation,
      depth: "advanced" as ExplanationDepth,
      handling: "challenge" as const,
      behavior: "maintenance" as WeakTopicBehavior,
    };
  }
  return {
    confidence: focus.confidence,
    difficulty: "medium" as QuizDifficultyRecommendation,
    handling: "balanced" as const,
    behavior: "maintenance" as WeakTopicBehavior,
  };
}

function strategyValues(context: BuildPersonalizationInput["context"], state: { ignored: string[] }): Signal<readonly string[]> | undefined {
  const candidates = (context.memories ?? []).filter((memory) =>
    memory.category === "successful-strategy" || memory.category === "learning-pattern",
  );
  const accepted: string[] = [];
  let source: PersonalizationSource = "inferred-memory";
  let confidence = 0;
  for (const memory of candidates) {
    if (memory.stale || (memory.sourceType !== "explicit" && memory.confidence < PERSONALIZATION_CONFIG.softConfidence)) {
      state.ignored.push(`learningStrategies:memory:${memory.key}`);
      continue;
    }
    accepted.push(...cleanStrings(memory.value));
    if (memory.sourceType === "explicit") source = "explicit-memory";
    confidence = Math.max(confidence, memory.confidence);
  }
  const values = [...new Set(accepted)].slice(0, PERSONALIZATION_CONFIG.maximumStrategies);
  return values.length ? { value: values, source, confidence, label: "memory:learning-strategies" } : undefined;
}

function careerGoals(context: BuildPersonalizationInput["context"]): Signal<CareerGoals> | undefined {
  const get = (key: string) => memoryFor(context, key).find((memory) =>
    !memory.stale &&
    (memory.sourceType === "explicit" || memory.confidence >= PERSONALIZATION_CONFIG.softConfidence),
  );
  const role = get("targetRole");
  const industry = get("targetIndustry");
  const companies = get("targetCompanies");
  const timeline = get("internshipTimeline");
  const portfolio = get("portfolioGoal");
  const memories = [role, industry, companies, timeline, portfolio].filter((item): item is MemoryContext => Boolean(item));
  if (!memories.length) return undefined;
  const explicit = memories.some((item) => item.sourceType === "explicit");
  const result: CareerGoals = {
    ...(role ? { targetRoles: cleanStrings(role.value).slice(0, 5) } : {}),
    ...(industry && cleanString(industry.value) ? { targetIndustry: cleanString(industry.value) } : {}),
    ...(companies ? { targetCompanies: cleanStrings(companies.value).slice(0, 5) } : {}),
    ...(timeline && cleanString(timeline.value) ? { internshipTimeline: cleanString(timeline.value) } : {}),
    ...(portfolio && cleanString(portfolio.value) ? { portfolioGoal: cleanString(portfolio.value) } : {}),
  };
  return {
    value: result,
    source: explicit ? "explicit-memory" : "inferred-memory",
    confidence: Math.max(...memories.map((item) => item.confidence)),
    label: "memory:career-goals",
  };
}

function allowed(agentId: string | undefined, field: string): boolean {
  if (!agentId) return true;
  return FIELDS[agentId]?.has(field) ?? false;
}

export function buildPersonalizationProfile(input: BuildPersonalizationInput): PersonalizationProfile {
  const explicit = parseExplicitRequestPreferences(input.request);
  const state = { applied: [] as string[], ignored: [] as string[], conflicts: [] as string[] };
  const profile: Record<string, unknown> = {};
  const set = <T>(field: string, value: PersonalizedValue<T> | undefined) => {
    if (value && allowed(input.agentId, field)) profile[field] = value;
  };
  const requestSignal = <T>(value: T | undefined, label: string): Signal<T> | undefined =>
    value === undefined ? undefined : { value, source: "current-request", confidence: 100, label };
  const taskSignal = <T>(value: T | undefined, label: string): Signal<T> | undefined =>
    value === undefined ? undefined : { value, source: "task-context", confidence: 100, label };
  const defaultSignal = <T>(value: T, label: string): Signal<T> =>
    ({ value, source: "default", confidence: 100, label });
  const learning = learningAdaptation(learningTopics(input.context));
  const profileDepth = input.context.profile?.explanationDifficulty.toLocaleLowerCase() as ExplanationDepth | undefined;
  const explanationMemories = memoryFor(input.context, "explanationStyle");
  const explanationMemory = explanationMemories[0];
  const parsedStyle = explanationMemory ? explanationStyleSignals(explanationMemory) : {};
  const asMemory = <T>(memory: MemoryContext | undefined, value: T | undefined) =>
    memory && value !== undefined ? memorySignal(memory, value) : undefined;

  set("explanationStyle", choose("explanationStyle", [asMemory(explanationMemory, parsedStyle.style), defaultSignal("balanced", "default:balanced")], state));
  set("explanationDepth", choose("explanationDepth", [
    requestSignal(explicit.explanationDepth, "request:explanation-depth"),
    profileDepth ? { value: profileDepth, source: "explicit-profile", confidence: 100, label: "profile:explanationDifficulty" } : undefined,
    learning?.depth ? { value: learning.depth, source: "learning-intelligence", confidence: learning.confidence, label: "learning:mastery" } : undefined,
    defaultSignal(PERSONALIZATION_CONFIG.defaults.explanationDepth as ExplanationDepth, "default:explanation-depth"),
  ], state));
  const answerMemory = memoryFor(input.context, "answerLength")[0];
  set("preferredAnswerLength", choose("preferredAnswerLength", [
    requestSignal(explicit.answerLength, "request:answer-length"),
    asMemory(answerMemory, enumValue(answerMemory?.value, ["concise", "medium", "detailed"] as const)),
    asMemory(explanationMemory, parsedStyle.length),
    defaultSignal(PERSONALIZATION_CONFIG.defaults.answerLength as AnswerLength, "default:answer-length"),
  ], state));
  set("explanationStructure", choose("explanationStructure", [
    requestSignal(explicit.explanationStructure, "request:explanation-structure"),
    asMemory(explanationMemory, parsedStyle.structure),
    learning?.structure ? { value: learning.structure, source: "learning-intelligence", confidence: learning.confidence, label: "learning:mastery" } : undefined,
    defaultSignal(PERSONALIZATION_CONFIG.defaults.explanationStructure as ExplanationStructure, "default:explanation-structure"),
  ], state));
  set("explanationRigor", choose("explanationRigor", [
    requestSignal(explicit.explanationRigor, "request:rigor"),
    profileDepth ? {
      value: profileDepth === "beginner" ? "intuitive" : profileDepth === "advanced" ? "formal" : "balanced",
      source: "explicit-profile",
      confidence: 100,
      label: "profile:explanationDifficulty",
    } : undefined,
    asMemory(explanationMemory, parsedStyle.rigor),
    defaultSignal(PERSONALIZATION_CONFIG.defaults.explanationRigor as ExplanationRigor, "default:rigor"),
  ], state));
  const structure = profile.explanationStructure as PersonalizedValue<ExplanationStructure> | undefined;
  set("examplePreference", structure ? {
    value: structure.value === "example-first" ? "example-first" : "as-needed",
    source: structure.source,
    confidence: structure.confidence,
    strength: structure.strength,
  } : undefined);

  const quizMemory = memoryFor(input.context, "quizDifficulty")[0];
  const rememberedDifficulty = enumValue(quizMemory?.value, ["easy", "medium", "hard"] as const);
  const preferredDifficulty = choose("quizDifficulty", [
    requestSignal(explicit.quizDifficulty, "request:quiz-difficulty"),
    taskSignal(input.task?.requiredDifficulty, "task:required-difficulty"),
    asMemory(quizMemory, rememberedDifficulty),
    defaultSignal(PERSONALIZATION_CONFIG.defaults.quizDifficulty as QuizDifficultyRecommendation, "default:quiz-difficulty"),
  ], state);
  set("quizDifficulty", preferredDifficulty);
  // Recommended difficulty is deliberately learning-aware. It preserves the stored
  // preference separately, but prevents a weak learner's historical 'hard' setting
  // from overriding current evidence. A current explicit request still wins.
  const adaptedDifficulty: Signal<QuizDifficultyRecommendation> | undefined = learning?.difficulty
    ? { value: learning.difficulty, source: "learning-intelligence", confidence: learning.confidence, label: "learning:mastery" }
    : preferredDifficulty
      ? { value: preferredDifficulty.value, source: preferredDifficulty.source, confidence: preferredDifficulty.confidence, label: "resolved:quiz-preference" }
      : undefined;
  set("recommendedDifficulty", choose("recommendedDifficulty", [
    requestSignal(explicit.quizDifficulty, "request:quiz-difficulty"),
    taskSignal(input.task?.requiredDifficulty, "task:required-difficulty"),
    adaptedDifficulty,
    defaultSignal(PERSONALIZATION_CONFIG.defaults.quizDifficulty as QuizDifficultyRecommendation, "default:quiz-difficulty"),
  ], state));
  const questionMemory = memoryFor(input.context, "questionType")[0];
  set("preferredQuestionTypes", choose("preferredQuestionTypes", [
    requestSignal(explicit.questionTypes, "request:question-types"),
    taskSignal(input.task?.requiredQuestionTypes, "task:question-types"),
    asMemory(questionMemory, cleanStrings(questionMemory?.value)),
    defaultSignal(["mixed"] as const, "default:question-types"),
  ], state));
  set("confidenceHandling", choose<ConfidenceHandling>("confidenceHandling", [
    learning ? { value: learning.handling, source: "learning-intelligence", confidence: learning.confidence, label: "learning:confidence" } : undefined,
    defaultSignal<ConfidenceHandling>("balanced", "default:confidence-handling"),
  ], state));
  set("weakTopicBehavior", learning ? {
    value: learning.behavior,
    source: "learning-intelligence",
    confidence: learning.confidence,
    strength: strength(learning.confidence),
  } : undefined);

  const sessionMemory = memoryFor(input.context, "studySessionMinutes")[0];
  const sessionValue = typeof sessionMemory?.value === "number" ? Math.round(sessionMemory.value) : undefined;
  set("studySessionMinutes", choose("studySessionMinutes", [
    input.context.profile?.studySessionMinutes ? { value: input.context.profile.studySessionMinutes, source: "explicit-profile", confidence: 100, label: "profile:studySessionMinutes" } : undefined,
    asMemory(sessionMemory, sessionValue),
    defaultSignal(PERSONALIZATION_CONFIG.defaults.studySessionMinutes, "default:study-session"),
  ], state));
  const preferredSession = profile.studySessionMinutes as PersonalizedValue<number> | undefined;
  set("maxContinuousMinutes", choose("maxContinuousMinutes", [
    requestSignal(explicit.availableMinutes, "request:available-minutes"),
    taskSignal(input.task?.availableMinutes, "task:available-minutes"),
    preferredSession ? { value: Math.min(120, Math.max(90, preferredSession.value)), source: preferredSession.source, confidence: preferredSession.confidence, label: "resolved:study-session" } : undefined,
    defaultSignal(PERSONALIZATION_CONFIG.defaults.maxContinuousMinutes, "default:max-continuous"),
  ], state));
  const intensityMemory = memoryFor(input.context, "planningIntensity")[0];
  const intensityValue = enumValue(intensityMemory?.value, ["light", "moderate", "intensive"] as const) ??
    (cleanString(intensityMemory?.value)?.toLocaleLowerCase() === "balanced" ? "moderate" : undefined);
  set("planningIntensity", choose("planningIntensity", [
    requestSignal(explicit.planningIntensity, "request:planning-intensity"),
    asMemory(intensityMemory, intensityValue as PlanningIntensity | undefined),
    defaultSignal(PERSONALIZATION_CONFIG.defaults.planningIntensity as PlanningIntensity, "default:planning-intensity"),
  ], state));
  const timeMemory = memoryFor(input.context, "preferredStudyTime")[0];
  set("preferredStudyTime", choose("preferredStudyTime", [asMemory(timeMemory, cleanString(timeMemory?.value))], state));

  const noteMemory = memoryFor(input.context, "noteStyle")[0];
  const noteStyle = enumValue(noteMemory?.value, ["concise", "structured", "detailed", "exam-focused", "definitions-first", "concept-first"] as const);
  set("noteStyle", choose("noteStyle", [
    requestSignal(explicit.noteStyle, "request:note-style"),
    asMemory(noteMemory, noteStyle),
    defaultSignal(PERSONALIZATION_CONFIG.defaults.noteStyle as NoteStyle, "default:note-style"),
  ], state));
  const resolvedNote = profile.noteStyle as PersonalizedValue<NoteStyle> | undefined;
  set("noteStructure", resolvedNote ? { ...resolvedNote, value: resolvedNote.value } : undefined);
  const length = profile.preferredAnswerLength as PersonalizedValue<AnswerLength> | undefined;
  set("noteDetail", length ? { ...length, value: length.value } : undefined);

  set("learningStrategies", choose("learningStrategies", [strategyValues(input.context, state)], state));
  const academicMemory = memoryFor(input.context, "academicGoal")[0];
  const academicGoalSignals: Array<Signal<readonly string[]> | undefined> = [
    input.context.profile?.academicGoal ? { value: [input.context.profile.academicGoal], source: "explicit-profile", confidence: 100, label: "profile:academicGoal" } : undefined,
    academicMemory ? memorySignal(academicMemory, cleanStrings(academicMemory.value)) : undefined,
  ];
  set("academicGoals", choose("academicGoals", academicGoalSignals, state));
  const careerProfile = input.context.career?.profile;
  const explicitCareerGoals: Signal<CareerGoals> | undefined = careerProfile &&
    (careerProfile.careerGoal || careerProfile.targetRoles.length || careerProfile.targetIndustries.length)
    ? {
        value: {
          ...(careerProfile.targetRoles.length ? { targetRoles: careerProfile.targetRoles.slice(0, 5) } : {}),
          ...(careerProfile.targetIndustries[0] ? { targetIndustry: careerProfile.targetIndustries[0] } : {}),
          ...(careerProfile.careerGoal ? { objectives: [careerProfile.careerGoal.slice(0, PERSONALIZATION_CONFIG.maximumGoalLength)] } : {}),
        },
        source: "explicit-profile",
        confidence: 100,
        label: "career-profile:goals",
      }
    : undefined;
  set("careerGoals", choose("careerGoals", [explicitCareerGoals, careerGoals(input.context)], state));
  if (length) set("communicationPreferences", { ...length, value: [`answer-length:${length.value}`] });

  for (const memory of input.context.memories ?? []) {
    if (memory.stale || (memory.sourceType !== "explicit" && memory.confidence < PERSONALIZATION_CONFIG.softConfidence)) {
      state.ignored.push(`memory:${memory.key}`);
    }
  }
  return {
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...profile,
    metadata: {
      appliedSignals: [...new Set(state.applied)],
      ignoredSignals: [...new Set(state.ignored)],
      conflictsResolved: [...new Set(state.conflicts)],
    },
  } as unknown as PersonalizationProfile;
}
