import "server-only";
import { AIError, AI_GUARD_CODES } from "../ai/errors";
export const WORKFLOW_ERRORS = [...AI_GUARD_CODES, "AI_SERVICE_TEMPORARILY_UNAVAILABLE", "AI_STREAM_INTERRUPTED", "TIMEOUT", "UNSUPPORTED_CAPABILITY", "CONTEXT_TOO_LARGE", "INVALID_REQUEST", "INVALID_DEFINITION", "UNAUTHENTICATED", "REFERENCE_NOT_FOUND", "EXAM_SELECTION_REQUIRED", "EXAM_UNAVAILABLE", "RUN_NOT_FOUND", "LIMIT_EXCEEDED", "STORAGE_FAILURE", "STEP_FAILURE", "CONTEXT_FAILURE", "INVALID_RESPONSE", "PROVIDER_FAILURE", "RATE_LIMIT", "AUTHENTICATION", "CONFIGURATION", "CANCELLED", "SOURCE_CONTEXT_UNAVAILABLE", "NO_AVAILABILITY", "INVALID_PLAN_RESPONSE", "TOPIC_NOT_FOUND", "TOPIC_SELECTION_REQUIRED", "NO_LEARNING_DATA", "QUIZ_INCOMPLETE", "GRADING_FAILURE", "LEARNING_REFRESH_FAILURE", "DOCUMENT_REQUIRED", "DOCUMENT_NOT_READY", "DOCUMENT_CHANGED", "INSUFFICIENT_STUDY_TIME", "ASSIGNMENT_CHANGED", "ASSIGNMENT_DESCRIPTION_REQUIRED", "ASSIGNMENT_CONTEXT_UNAVAILABLE", "TARGET_ROLE_REQUIRED", "CAREER_DATA_REQUIRED", "CAREER_DATA_CHANGED", "CAREER_PLAN_FAILURE"] as const;
export type WorkflowErrorCode = typeof WORKFLOW_ERRORS[number];
export class WorkflowError extends Error {
  constructor(readonly code: WorkflowErrorCode) {
    const messages: Partial<Record<WorkflowErrorCode, string>> = { ASSIGNMENT_CHANGED: "Assignment requirements changed. Start a new support run to analyze the current instructions; saved work remains available.", ASSIGNMENT_DESCRIPTION_REQUIRED: "Add the official assignment instructions to its description before requesting support.", ASSIGNMENT_CONTEXT_UNAVAILABLE: "The complete assignment instructions could not be prepared. Check the saved assignment description.", DOCUMENT_REQUIRED: "Select at least one lecture document.", DOCUMENT_NOT_READY: "Wait until all selected documents are ready.", DOCUMENT_CHANGED: "Selected material changed. Start a new session with the updated material.", INSUFFICIENT_STUDY_TIME: "Allow more study time or choose a shorter study mode.", UNAUTHENTICATED: "Sign in to run a workflow.", REFERENCE_NOT_FOUND: "A selected item was not found.", EXAM_SELECTION_REQUIRED: "Select the exam to prepare for.", EXAM_UNAVAILABLE: "Select an upcoming exam within the next 90 days.", RUN_NOT_FOUND: "This workflow run was not found.", TOPIC_NOT_FOUND: "The selected topic was not found.", TOPIC_SELECTION_REQUIRED: "Select one course and topic for recovery.", NO_LEARNING_DATA: "No suitable recovery topic is available. Select a topic for diagnostic practice or review.", QUIZ_INCOMPLETE: "Finish all questions in the selected quiz before continuing.", GRADING_FAILURE: "The answer could not be graded. Retry the answer before continuing.", LEARNING_REFRESH_FAILURE: "Learning progress could not be refreshed; recovery has not been confirmed." };
    Object.assign(messages, {
      TARGET_ROLE_REQUIRED: "Choose a target role before creating a career preparation plan.",
      CAREER_DATA_REQUIRED: "Provide resume, experience, project, skill, or portfolio evidence to continue.",
      CAREER_DATA_CHANGED: "Saved career evidence changed. Start a new preparation run so recommendations use current data.",
      CAREER_PLAN_FAILURE: "The career preparation plan could not be saved.",
    });
    const guardCode = AI_GUARD_CODES.find(value => value === code);
    super((guardCode ? new AIError(guardCode).message : messages[code]) ?? "The workflow could not complete this operation. Check its status and selected inputs.");
    this.name = "WorkflowError";
  }
}
export function workflowError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return new WorkflowError(WORKFLOW_ERRORS.includes(code as WorkflowErrorCode) ? code as WorkflowErrorCode : "STEP_FAILURE");
}
