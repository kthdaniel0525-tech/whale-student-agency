import type { LearningTopicSummary } from "../learning/types";

/** Recovery policy is separate from (and never replaces) Learning's score formula. */
export const RECOVERY_CONFIG = Object.freeze({
  masteryThreshold: 70, confidenceThreshold: 60, minimumEvidence: 3,
  meaningfulImprovement: 8, veryWeakMastery: 40, repairMastery: 55,
  recentAccuracyThreshold: 70, diagnosticQuestions: 5, practiceQuestions: 6,
  verificationQuestions: 5, maxTutorCalls: 2, maxQuizCalls: 2,
  maxSteps: 6, maxDurationMs: 300000,
});
export type RecoveryStatus = "recovered" | "improving" | "needs-more-practice" | "insufficient-evidence";
export type RecoverySnapshot = Pick<LearningTopicSummary, "mastery" | "confidence" | "trend" | "recentAccuracy" | "questionsAttempted" | "lastPracticedAt">;
export type RecoveryEvaluation = {
  previousMastery: number; currentMastery: number; previousConfidence: number;
  currentConfidence: number; improvement: number; status: RecoveryStatus;
};
export type RecoveryState = {
  topicId: string; topicName: string; courseId: string;
  startingState: RecoverySnapshot; currentState: RecoverySnapshot;
  entry: "tutor" | "diagnostic" | "practice" | "review" | "skip";
  tutorAttempts: number; quizAttempts: number;
  quizzes: { id: string; mode: "diagnostic" | "practice" | "verification"; difficulty: "easy" | "medium" | "hard"; attemptId: string | null }[];
  evaluation: RecoveryEvaluation | null;
  stop: boolean;
};
export type RecoveryResult = {
  topic: { id: string; name: string; courseId: string };
  startingState: RecoverySnapshot; endingState: RecoverySnapshot;
  status: RecoveryStatus | "awaiting-answers" | "not-needed" | "in-progress" | "failed" | "cancelled";
  evaluation: RecoveryEvaluation | null; completedSteps: string[];
  improvementSummary: string; nextAction: string; recommendedAgent?: "tutor" | "quiz";
};
export function recoverySnapshot(t: LearningTopicSummary): RecoverySnapshot {
  return { mastery: t.mastery, confidence: t.confidence, trend: t.trend, recentAccuracy: t.recentAccuracy, questionsAttempted: t.questionsAttempted, lastPracticedAt: t.lastPracticedAt };
}
export function hasRecoveryEvidence(t: RecoverySnapshot) {
  return t.confidence >= RECOVERY_CONFIG.confidenceThreshold && t.questionsAttempted >= RECOVERY_CONFIG.minimumEvidence;
}
export function recoveryEntry(t: RecoverySnapshot, review = false): RecoveryState["entry"] {
  if (!hasRecoveryEvidence(t)) return "diagnostic";
  if (t.mastery >= RECOVERY_CONFIG.masteryThreshold) return review ? "review" : "skip";
  return t.mastery < RECOVERY_CONFIG.repairMastery || t.trend === "declining" || t.recentAccuracy < RECOVERY_CONFIG.recentAccuracyThreshold ? "tutor" : "practice";
}
export function recoveryPriority(t: LearningTopicSummary, now = new Date()) {
  const age = t.lastPracticedAt ? Math.max(0, (now.getTime() - new Date(t.lastPracticedAt).getTime()) / 86400000) : 90;
  return .45 * (100 - t.mastery) + .2 * (100 - t.recentAccuracy) + .15 * t.confidence
    + (t.trend === "declining" ? 10 : 0) + 10 * Math.min(age / 90, 1);
}
export function selectRecoveryTopic(topics: readonly LearningTopicSummary[], now = new Date()) {
  const weak = topics.filter((t) => t.mastery < RECOVERY_CONFIG.masteryThreshold && hasRecoveryEvidence(t));
  // Low-evidence fallback is explicitly diagnostic, never a claim of weakness.
  const candidates = weak.length ? weak : topics.filter((t) => !hasRecoveryEvidence(t));
  return [...candidates].sort((a, b) => recoveryPriority(b, now) - recoveryPriority(a, now) || a.id.localeCompare(b.id))[0];
}
export function evaluateRecovery(previous: RecoverySnapshot, current: RecoverySnapshot, challengingEvidence = true): RecoveryEvaluation {
  const improvement = Math.round((current.mastery - previous.mastery) * 10) / 10;
  const status: RecoveryStatus = !hasRecoveryEvidence(current) ? "insufficient-evidence"
    : current.mastery >= RECOVERY_CONFIG.masteryThreshold && challengingEvidence ? "recovered"
    : improvement >= RECOVERY_CONFIG.meaningfulImprovement ? "improving" : "needs-more-practice";
  return { previousMastery: previous.mastery, currentMastery: current.mastery, previousConfidence: previous.confidence, currentConfidence: current.confidence, improvement, status };
}
export function recoveryQuizSettings(state: RecoveryState) {
  const first = state.quizAttempts === 0;
  const mode = first && state.entry === "diagnostic" ? "diagnostic" : first && state.entry !== "review" ? "practice" : "verification";
  const difficulty = mode === "practice" && state.currentState.mastery < RECOVERY_CONFIG.veryWeakMastery ? "easy"
    : mode === "verification" && state.currentState.mastery >= RECOVERY_CONFIG.masteryThreshold ? "hard" : "medium";
  const count = mode === "diagnostic" ? RECOVERY_CONFIG.diagnosticQuestions : mode === "practice" ? RECOVERY_CONFIG.practiceQuestions : RECOVERY_CONFIG.verificationQuestions;
  return { mode, difficulty, count } as const;
}
export function shouldTutorAgain(state: RecoveryState) {
  return !state.stop && state.tutorAttempts < RECOVERY_CONFIG.maxTutorCalls && state.evaluation?.status === "needs-more-practice" && recoveryEntry(state.currentState) === "tutor";
}
export function recoveryResult(state: RecoveryState, runStatus: string, completedSteps: string[]): RecoveryResult {
  const status: RecoveryResult["status"] = runStatus === "FAILED" ? "failed" : runStatus === "CANCELLED" ? "cancelled"
    : runStatus === "WAITING_FOR_INPUT" ? "awaiting-answers" : runStatus !== "COMPLETED" ? "in-progress"
    : state.entry === "skip" ? "not-needed" : state.evaluation?.status ?? "insufficient-evidence";
  const nextAction = status === "awaiting-answers" ? "Answer every question in the saved quiz, then continue recovery after grading."
    : status === "recovered" || status === "not-needed" ? "Maintain this topic with a short spaced review; continue with another learning priority."
    : status === "improving" ? "Continue independent practice, then check retention in a later quiz."
    : status === "insufficient-evidence" ? "Practice again in a separate session to build reliable evidence before choosing more tutoring."
    : status === "needs-more-practice" ? "This topic still needs work. Try a different explanation approach or more independent practice."
    : status === "cancelled" ? "Resume learning when ready by starting a new recovery request."
    : status === "failed" ? "Review the failed step. Recovery has not been confirmed; retry grading if an answer failed."
    : "Follow the current recovery step.";
  const improvementSummary = state.evaluation && !["failed", "cancelled"].includes(status)
    ? `${state.topicName}: mastery ${state.startingState.mastery} → ${state.currentState.mastery}; confidence ${state.startingState.confidence} → ${state.currentState.confidence}. ${status === "awaiting-answers" ? "The next quiz still needs your answers." : "Based on graded practice."}`
    : status === "not-needed" ? `${state.topicName} already meets the recovery threshold; no remediation was needed.`
    : `${state.topicName}: recovery has not yet been verified with completed graded practice.`;
  return { topic: { id: state.topicId, name: state.topicName, courseId: state.courseId }, startingState: state.startingState, endingState: state.currentState,
    status, evaluation: state.evaluation, completedSteps, improvementSummary, nextAction,
    ...(status === "needs-more-practice" ? { recommendedAgent: "tutor" as const } : ["improving", "insufficient-evidence", "awaiting-answers"].includes(status) ? { recommendedAgent: "quiz" as const } : {}) };
}
