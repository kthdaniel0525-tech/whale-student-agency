import type { WorkflowResult } from "../../workflows/types";
/** Adapt observed execution records, not self-reported model claims. Provider call
 * counts can be supplied by the existing boundary telemetry (including retries). */
export function workflowObservation(result: WorkflowResult, calls?: readonly string[]) {
  const steps = result.steps.filter(s => s.agentId !== "deterministic");
  return { status: result.status, text: result.summary, nextAction: result.recommendedNextAction,
    artifactIds: Object.keys(result.outputs).filter(key => result.outputs[key] !== null && result.outputs[key] !== undefined),
    totalCalls: calls?.length ?? steps.reduce((n, s) => n + s.attempts, 0),
    tutorCalls: calls ? calls.filter(c => c === "tutor" || c === "lecture_explanation").length : steps.filter(s => s.agentId === "tutor").reduce((n, s) => n + s.attempts, 0),
    quizCalls: calls ? calls.filter(c => c === "quiz_generation").length : steps.filter(s => s.agentId === "quiz").reduce((n, s) => n + s.attempts, 0),
    ...(result.recovery ? { startingMastery: result.recovery.startingState.mastery, endingMastery: result.recovery.endingState.mastery, confidence: result.recovery.endingState.confidence, recoveryStatus: result.recovery.status } : {}) };
}
