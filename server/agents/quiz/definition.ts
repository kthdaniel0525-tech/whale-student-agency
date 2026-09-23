import "server-only";
import { copyAgent } from "../metadata";
import type { Agent } from "../types";

const definition: Agent = {
  id: "quiz",
  name: "Quiz",
  description: "Creates grounded practice questions and evaluates answers.",
  capabilities: [
    "generate-questions",
    "generate-multiple-choice",
    "generate-short-answer",
    "generate-long-answer",
    "evaluate-answers",
    "explain-wrong-answers",
  ],
  contextRequirements: {
    profile: true,
    course: true,
    documents: true,
    learning: true,
    memories: true,
    memoryCategories: ["preference", "learning-pattern"],
    memoryKeys: ["quizDifficulty", "questionType"],
    limits: { memories: 4 },
  },
};

export function getQuizAgentDefinition(): Agent {
  return copyAgent(definition);
}
