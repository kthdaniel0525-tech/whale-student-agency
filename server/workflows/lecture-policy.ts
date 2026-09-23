import type { LearningTopicSummary } from "../learning/types";
import type { AgentSource } from "../agents/types";
import { normalizeTopicName } from "../learning/normalization";
import { WorkflowError } from "./errors";

export type LectureStudyMode = "quick-review" | "standard-study" | "deep-study";
export type LectureDifficulty = "easy" | "medium" | "hard";
export const LECTURE_CONFIG = Object.freeze({
  maximumDocuments: 10, maximumConcepts: 12, maximumTutorConcepts: 3,
  confidenceMinimum: 60, weakMastery: 70, strongMastery: 85, improvementMinimum: 5,
  modes: {
    "quick-review": { minimumQuestions: 3, questions: 4, minutesPerQuestion: 2, notesMinutes: 6, tutorMinutes: 0, minimumNotes: 6, minimumTutor: 0, detail: "concise" },
    "standard-study": { minimumQuestions: 5, questions: 6, minutesPerQuestion: 3, notesMinutes: 10, tutorMinutes: 15, minimumNotes: 7, minimumTutor: 8, detail: "structured" },
    "deep-study": { minimumQuestions: 8, questions: 10, minutesPerQuestion: 4, notesMinutes: 15, tutorMinutes: 30, minimumNotes: 12, minimumTutor: 16, detail: "detailed" },
  },
} as const);
export type LectureEffort = { notesMinutes: number; tutorMinutes: number; quizMinutes: number; totalMinutes: number; questionCount: number };
export function lectureStudySettings(input: { goal: string; mode?: LectureStudyMode; availableMinutes?: number }) {
  const writtenMinutes = /\b(\d+)\s*(?:minutes?|mins?)\b|(?<!\d)(\d+)\s*분/.exec(input.goal);
  const availableMinutes = input.availableMinutes ?? (writtenMinutes ? Number(writtenMinutes[1] ?? writtenMinutes[2]) : undefined);
  if (availableMinutes !== undefined && (!Number.isInteger(availableMinutes) || availableMinutes < 1 || availableMinutes > 480)) throw new WorkflowError("INVALID_REQUEST");
  const mode = input.mode ?? (/\b(quick|rapid|brief)\b|빠른|간단히/.test(input.goal.toLowerCase()) ? "quick-review"
    : /\b(deep|in.depth|thorough)\b|심층|깊이/.test(input.goal.toLowerCase()) ? "deep-study"
    : availableMinutes !== undefined && availableMinutes < 30 ? "quick-review" : availableMinutes !== undefined && availableMinutes >= 120 ? "deep-study" : "standard-study");
  const policy = LECTURE_CONFIG.modes[mode];
  const budget = availableMinutes ?? policy.notesMinutes + policy.tutorMinutes + policy.questions * policy.minutesPerQuestion;
  const minimum = policy.minimumNotes + policy.minimumTutor + policy.minimumQuestions * policy.minutesPerQuestion;
  if (budget < minimum) throw new WorkflowError("INSUFFICIENT_STUDY_TIME");
  const questionCount = Math.min(policy.questions, Math.floor((budget - policy.minimumNotes - policy.minimumTutor) / policy.minutesPerQuestion));
  const quizMinutes = questionCount * policy.minutesPerQuestion;
  const notesMinutes = Math.min(policy.notesMinutes, budget - quizMinutes - policy.minimumTutor);
  const tutorMinutes = Math.min(policy.tutorMinutes, budget - quizMinutes - notesMinutes);
  return { mode, availableMinutes, effort: { notesMinutes, tutorMinutes, quizMinutes, totalMinutes: notesMinutes + tutorMinutes + quizMinutes, questionCount } };
}
export type LectureLearningState = Pick<LearningTopicSummary, "id" | "topic" | "mastery" | "confidence" | "questionsAttempted" | "trend" | "recentAccuracy">;
export type LectureConcept = { topic: string; keyIdea: string; complexity: "basic" | "intermediate" | "advanced"; sourceRefs: string[] };
export type LectureSource = AgentSource & { id: string };
export type LectureState = {
  documents: { id: string; title: string; pageCount: number | null; updatedAt: string }[];
  mode: LectureStudyMode; availableMinutes?: number; effort: LectureEffort;
  topicFocus?: string; requestedDifficulty?: LectureDifficulty;
  concepts: LectureConcept[]; tutorTargets: string[]; practiceTopics: string[];
  learningBefore: LectureLearningState[]; sources: LectureSource[];
  quiz: { id: string; attemptId: string | null; questionCount: number; difficulty: LectureDifficulty } | null;
  summary: LectureStudySummary | null;
};
export type LectureStudySummary = {
  lecture: { id: string; title: string }[]; conceptsStudied: string[]; topicsPracticed: string[];
  quizScore: { percentage: number; correctAnswers: number; totalQuestions: number };
  identifiedWeakTopics: LectureLearningState[]; improvedTopics: { topic: string; previousMastery: number; currentMastery: number; confidence: number }[];
  insufficientEvidenceTopics: string[]; notPracticedTopics: string[]; recommendedNextAction: string;
  recommendedWorkflowId?: "weak-topic-recovery"; recommendedAgent?: "study-planner" | "quiz";
};
export function lectureLearningState(t: LearningTopicSummary): LectureLearningState {
  return { id: t.id, topic: t.topic, mastery: t.mastery, confidence: t.confidence, questionsAttempted: t.questionsAttempted, trend: t.trend, recentAccuracy: t.recentAccuracy };
}
export function selectLectureTargets(state: LectureState) {
  const byName = new Map(state.learningBefore.map((t) => [normalizeTopicName(t.topic), t]));
  const ranked = [...state.concepts].map((concept) => {
    const evidence = byName.get(normalizeTopicName(concept.topic));
    const confident = evidence && evidence.confidence >= LECTURE_CONFIG.confidenceMinimum && evidence.questionsAttempted >= 3;
    const focus = state.topicFocus && normalizeTopicName(concept.topic) === normalizeTopicName(state.topicFocus);
    const weakness = confident ? (100 - evidence.mastery) + (evidence.trend === "declining" ? 15 : 0) : 50;
    return { concept, evidence, score: (focus ? 100 : 0) + weakness + (concept.complexity === "advanced" ? 20 : concept.complexity === "intermediate" ? 10 : 0) };
  }).sort((a, b) => b.score - a.score || a.concept.topic.localeCompare(b.concept.topic));
  const tutorTargets = state.mode === "quick-review" ? [] : ranked.filter(({ concept, evidence }) => state.mode === "deep-study" || concept.complexity !== "basic" || !evidence || evidence.mastery < LECTURE_CONFIG.strongMastery || evidence.confidence < LECTURE_CONFIG.confidenceMinimum || evidence.trend === "declining")
    .slice(0, state.mode === "deep-study" ? LECTURE_CONFIG.maximumTutorConcepts : 2).map((t) => t.concept.topic);
  const practiceTopics = ranked.slice(0, state.effort.questionCount).map((t) => t.concept.topic);
  const known = practiceTopics.map((name) => byName.get(normalizeTopicName(name)));
  const difficulty = state.requestedDifficulty ?? (known.length && known.every((t) => t && t.mastery >= LECTURE_CONFIG.strongMastery && t.confidence >= LECTURE_CONFIG.confidenceMinimum) ? "hard" : "medium");
  return { tutorTargets, practiceTopics, difficulty };
}
export function summarizeLecture(state: LectureState, current: readonly LearningTopicSummary[], score: LectureStudySummary["quizScore"]): LectureStudySummary {
  const before = new Map(state.learningBefore.map((t) => [t.id, t]));
  const supported = current.filter((t) => t.questionsAttempted >= 3 && t.confidence >= LECTURE_CONFIG.confidenceMinimum);
  const weak = supported.filter((t) => t.mastery < LECTURE_CONFIG.weakMastery).sort((a, b) => a.mastery - b.mastery);
  const improved = current.filter((t) => {
    const previous = before.get(t.id);
    return previous && previous.questionsAttempted > 0 && t.questionsAttempted > previous.questionsAttempted && t.mastery - previous.mastery >= LECTURE_CONFIG.improvementMinimum && t.confidence >= LECTURE_CONFIG.confidenceMinimum;
  });
  const insufficient = current.filter((t) => t.questionsAttempted < 3 || t.confidence < LECTURE_CONFIG.confidenceMinimum).map((t) => t.topic);
  const untested = state.concepts.filter((c) => !current.some((t) => normalizeTopicName(t.topic) === normalizeTopicName(c.topic))).map((c) => c.topic);
  const recommendedNextAction = weak.length ? `Review ${weak[0].topic}; Weak Topic Recovery can provide targeted help.`
    : insufficient.length || untested.length ? `Practice ${[...insufficient, ...untested].slice(0, 3).join(", ")} in a later session; gather further evidence where confidence is low.`
    : "Move to the next lecture and keep a short spaced review of these concepts.";
  return { lecture: state.documents.map(({ id, title }) => ({ id, title })), conceptsStudied: state.concepts.map((c) => c.topic), topicsPracticed: current.map((t) => t.topic), quizScore: score,
    identifiedWeakTopics: weak.map(lectureLearningState), improvedTopics: improved.map((t) => ({ topic: t.topic, previousMastery: before.get(t.id)!.mastery, currentMastery: t.mastery, confidence: t.confidence })),
    insufficientEvidenceTopics: insufficient, notPracticedTopics: untested, recommendedNextAction,
    ...(weak.length ? { recommendedWorkflowId: "weak-topic-recovery" as const } : insufficient.length || untested.length ? { recommendedAgent: "quiz" as const } : {}) };
}
