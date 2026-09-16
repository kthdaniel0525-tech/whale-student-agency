import "server-only";
import { WorkflowError } from "./errors";
import type { WorkflowContext, WorkflowDefinition } from "./types";
export function assignmentState(context: Readonly<WorkflowContext>) {
  if (!context.assignment) throw new WorkflowError("INVALID_REQUEST");
  return context.assignment;
}
export const assignmentSupport: WorkflowDefinition = {
  id: "assignment-support", name: "Assignment Support", description: "Understand requirements, plan assignment work, learn concepts and review a student's draft.",
  intents: ["help me with this assignment", "help me start", "check my work", "review my answer"],
  maxSteps: 6, maxAgentCalls: 3, maxRetries: 0, maxDurationMs: 300000, maxOutputCharacters: 48000, failurePolicy: "fail-workflow",
  steps: [
    { id: "understand", agentId: "tutor", outputKey: "assignment-analysis", purpose: "Interpret the official assignment once with traceable requirements.",
      input: (c) => ({ request: `Understand the requirements of ${assignmentState(c).title.slice(0, 200)}.` }) },
    { id: "plan", agentId: "deterministic", outputKey: "assignment-plan", purpose: "Allocate a realistic work session within this assignment.",
      condition: (c) => ({ run: assignmentState(c).path.plan, reason: "The selected stage does not need a separate work plan." }), input: () => ({ request: "Plan assignment subtasks within the available time." }) },
    { id: "notes", agentId: "notes", outputKey: "assignment-notes", purpose: "Condense concepts or formulas only when the student requests useful preparatory notes.", failurePolicy: "continue-with-warning",
      condition: (c) => ({ run: assignmentState(c).path.notes, reason: "No condensed concept or formula review was requested." }),
      input: (c) => ({ request: `Review ${assignmentState(c).analysis?.requiredConcepts.join(", ").slice(0, 450)}. ${c.goal.slice(0, 400)}` }) },
    { id: "help", agentId: "tutor", outputKey: "assignment-help", purpose: "Guide one targeted concept or question with reasoning and analogous examples.",
      condition: (c) => ({ run: assignmentState(c).path.help, reason: "The selected stage needs no additional Tutor explanation." }),
      input: (c) => ({ request: `Explain ${assignmentState(c).specificQuestion?.slice(0, 650) ?? assignmentState(c).analysis?.requiredConcepts.slice(0, 3).join(", ").slice(0, 350) ?? "the first assignment subtask"}. Use reasoning and a similar example.` }) },
    { id: "draft", agentId: "deterministic", outputKey: "draft-request", purpose: "Wait for the student's own draft before reviewing it.",
      condition: (c) => ({ run: assignmentState(c).path.waitForDraft && !assignmentState(c).userWork, reason: "A draft is already available or the requested stage is complete." }),
      input: () => ({ request: "Request the student's draft for review." }) },
    { id: "review", agentId: "tutor", outputKey: "assignment-feedback", purpose: "Give actionable feedback on student work against the official requirements.",
      condition: (c) => ({ run: Boolean(assignmentState(c).userWork) && !assignmentState(c).path.understandOnly, reason: "No student draft was supplied for review." }),
      input: (c) => ({ request: `Review the student's draft about ${assignmentState(c).analysis?.requiredConcepts.join(", ").slice(0, 550)} against the assignment requirements.` }) },
  ],
};
