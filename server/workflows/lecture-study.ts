import "server-only";
import { WorkflowError } from "./errors";
import type { WorkflowContext, WorkflowDefinition } from "./types";
export function lectureState(context: Readonly<WorkflowContext>) {
  if (!context.lecture || !context.documentIds?.length) throw new WorkflowError("INVALID_REQUEST");
  return context.lecture;
}
export const lectureStudy: WorkflowDefinition = {
  id: "lecture-study", name: "Lecture Study", description: "Study selected lecture passages through Notes, targeted explanation, graded practice and a learning summary.",
  intents: ["help me study this lecture", "teach me this lecture", "study this PDF with me", "go through this lecture and quiz me"],
  maxSteps: 4, maxAgentCalls: 1, maxRetries: 0, maxDurationMs: 300000, maxOutputCharacters: 48000, failurePolicy: "fail-workflow",
  steps: [
    { id: "notes", agentId: "notes", outputKey: "notes", purpose: "Create source-grounded notes and identify lecture concepts in one generation.",
      input: (c) => ({ request: `Create ${lectureState(c).mode === "quick-review" ? "concise review" : "structured study"} notes from the selected lecture documents. ${lectureState(c).topicFocus ? `Focus on ${lectureState(c).topicFocus}.` : "Identify key concepts, definitions, formulas and procedures."} Selected titles: ${lectureState(c).documents.map((d) => d.title).join(", ").slice(0, 180)}. Goal: ${c.goal.slice(0, 450)}` }) },
    { id: "tutor", agentId: "tutor", outputKey: "explanation", purpose: "Explain selected difficult or weak lecture concepts with grounded examples.", failurePolicy: "continue-with-warning",
      condition: (c) => ({ run: lectureState(c).tutorTargets.length > 0, reason: "Quick review or well-understood basic concepts do not need a separate explanation." }),
      input: (c) => ({ request: `Explain these concepts using the selected lecture passages: ${lectureState(c).tutorTargets.join(", ")}. Use the supplied Notes key ideas and learning evidence. Give a worked example and an understanding check; do not repeat the whole lecture.` }) },
    { id: "quiz", agentId: "quiz", outputKey: "quiz", purpose: "Generate selected-document practice and wait for the student's answers.", invalidates: ["learning", "academicOverview"],
      input: (c) => ({ request: `Create a quiz from the selected lecture material on ${lectureState(c).practiceTopics.join(", ").slice(0, 720)}. Include applied problems and written reasoning.` }) },
    { id: "learning", agentId: "deterministic", outputKey: "study-summary", purpose: "Refresh actual graded learning evidence and summarize the study session.", invalidates: ["learning", "academicOverview"],
      input: () => ({ request: "Summarize the completed graded lecture practice using current Learning Intelligence." }) },
  ],
};
