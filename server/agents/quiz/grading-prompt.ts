import type { AIMessage } from "../../ai/types";
export const GRADING_PROMPT_VERSION = "semantic-grading-v1";
export const GRADING_INSTRUCTIONS = "Grade the answer against the expected answer. Return concise educational feedback. Do not require exact wording when meaning is correct.";
export function semanticGradingMessages(question: string, expectedAnswer: string, userAnswer: string): AIMessage[] {
  return [{ role: "system", content: GRADING_INSTRUCTIONS }, { role: "user", content: JSON.stringify({ question, expectedAnswer, userAnswer }) }];
}
