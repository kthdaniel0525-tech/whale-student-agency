import "server-only";
import { WorkflowError } from "./errors";
import type { WorkflowContext, WorkflowDefinition } from "./types";

export function careerPreparationState(context: Readonly<WorkflowContext>) {
  if (!context.careerPreparation) throw new WorkflowError("INVALID_REQUEST");
  return context.careerPreparation;
}

export const careerPreparation: WorkflowDefinition = {
  id: "career-preparation", name: "Career Preparation",
  description: "Assess supplied career evidence, prioritize role-relevant gaps and persist a realistic preparation plan.",
  intents: ["prepare for internships", "make a career preparation plan", "improve my resume and portfolio", "what career skills or projects am I missing"],
  maxSteps: 3, maxAgentCalls: 1, maxRetries: 0, maxDurationMs: 300000, maxOutputCharacters: 48000, failurePolicy: "fail-workflow",
  steps: [
    { id: "assess-current-state", agentId: "deterministic", outputKey: "career-state", purpose: "Create a compact evidence and readiness state or request essential missing data.",
      input: () => ({ request: "Assess the supplied career evidence and determine whether role-specific preparation can proceed." }) },
    { id: "identify-gaps", agentId: "career", outputKey: "career-gap-analysis", purpose: "Use Career Agent once for gaps, project priorities, resume, portfolio and interview actions.",
      condition: (context) => ({ run: careerPreparationState(context).missingInputs.length === 0, reason: "Essential career evidence is still missing." }),
      input: (context) => ({ request: `Prepare evidence-based guidance for ${careerPreparationState(context).targetRole}. ${context.goal.slice(0, 650)}` }) },
    { id: "create-plan", agentId: "deterministic", outputKey: "career-plan", purpose: "Allocate prioritized actions within the application timeline and weekly availability, then persist them.",
      condition: (context) => ({ run: Boolean(careerPreparationState(context).analysis), reason: "A validated gap analysis is required before plan creation." }),
      input: () => ({ request: "Create and persist the bounded career preparation plan from the validated actions." }) },
  ],
};
