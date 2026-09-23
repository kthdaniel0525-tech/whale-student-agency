import "server-only";
import { RECOVERY_CONFIG, shouldTutorAgain } from "./recovery-policy";
import { WorkflowError } from "./errors";
import type { WorkflowContext, WorkflowDefinition, WorkflowStep } from "./types";

export function recoveryState(context: Readonly<WorkflowContext>) {
  if (!context.recovery || context.recovery.courseId !== context.courseId) throw new WorkflowError("INVALID_REQUEST");
  return context.recovery;
}
const tutorInput: WorkflowStep["input"] = (c) => {
  const s = recoveryState(c);
  return { topic: s.topicName, request: `Explain ${s.topicName} with a worked example and a short understanding check. ${s.tutorAttempts ? "Use a different representation or example; the previous approach did not sufficiently resolve the difficulty." : "Address likely misconceptions."} Current learning evidence: mastery ${s.currentState.mastery}, confidence ${s.currentState.confidence}, recent accuracy ${s.currentState.recentAccuracy}, trend ${s.currentState.trend}. Use relevant course material from your normal context.` };
};
const quizInput: WorkflowStep["input"] = (c) => {
  const s = recoveryState(c);
  return { topic: s.topicName, request: `Create a quiz focused only on ${s.topicName}. Include conceptual and applied questions that test transfer, not repeated identical examples. Current mastery ${s.currentState.mastery}, confidence ${s.currentState.confidence}, recent accuracy ${s.currentState.recentAccuracy}, trend ${s.currentState.trend}. ${s.entry === "diagnostic" && !s.quizAttempts ? "Diagnose understanding without assuming weakness." : "Check understanding after focused practice; include meaningful challenge."}` };
};
export const weakTopicRecovery: WorkflowDefinition = {
  id: "weak-topic-recovery", name: "Weak Topic Recovery", description: "Recover one topic through confidence-aware tutoring, graded practice, and deterministic learning evaluation.",
  intents: ["help me improve my weakest topic", "help me understand this topic", "fix my weak areas"],
  maxSteps: RECOVERY_CONFIG.maxSteps, maxAgentCalls: 2,
  agentCallLimits: { tutor: RECOVERY_CONFIG.maxTutorCalls, quiz: RECOVERY_CONFIG.maxQuizCalls },
  maxRetries: 0, maxDurationMs: RECOVERY_CONFIG.maxDurationMs, failurePolicy: "fail-workflow",
  steps: [
    { id: "tutor-1", agentId: "tutor", purpose: "Explain a demonstrated weakness.", outputKey: "explanation-1", input: tutorInput,
      condition: (c) => ({ run: recoveryState(c).entry === "tutor", reason: "Diagnosis or practice is more appropriate than an initial explanation." }) },
    { id: "quiz-1", agentId: "quiz", purpose: "Create targeted practice or a diagnostic and wait for graded answers.", outputKey: "quiz-1", input: quizInput,
      condition: (c) => ({ run: !recoveryState(c).stop, reason: "The topic already meets the recovery threshold." }), invalidates: ["learning", "academicOverview"] },
    { id: "evaluate-1", agentId: "deterministic", purpose: "Refresh the topic after grading and evaluate recovery.", outputKey: "evaluation-1", input: () => ({ request: "Evaluate the completed graded quiz." }),
      condition: (c) => ({ run: !recoveryState(c).stop, reason: "No graded recovery work was needed." }), invalidates: ["learning", "academicOverview"] },
    { id: "tutor-2", agentId: "tutor", purpose: "Address confirmed remaining weakness with a different explanation.", outputKey: "explanation-2", input: tutorInput,
      condition: (c) => ({ run: shouldTutorAgain(recoveryState(c)), reason: "Further automatic tutoring is not justified by the refreshed evidence." }) },
    { id: "quiz-2", agentId: "quiz", purpose: "Verify recovery with a challenging follow-up quiz and wait for answers.", outputKey: "quiz-2", input: quizInput,
      condition: (c) => ({ run: !recoveryState(c).stop, reason: "Stop for independent practice, sufficient recovery, or more evidence over time." }), invalidates: ["learning", "academicOverview"] },
    { id: "evaluate-2", agentId: "deterministic", purpose: "Refresh learning and finish the bounded recovery run.", outputKey: "evaluation-2", input: () => ({ request: "Evaluate final graded recovery evidence." }),
      condition: (c) => ({ run: !recoveryState(c).stop, reason: "Recovery has already stopped safely." }), invalidates: ["learning", "academicOverview"] },
  ],
};
