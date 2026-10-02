import "server-only";
import { copyAgent } from "../metadata";
import type { Agent } from "../types";

const definition: Agent = {
  id: "tutor",
  name: "Tutor",
  description: "Explains academic concepts using course materials.",
  capabilities: [
    "explain-concepts",
    "answer-course-questions",
    "provide-examples",
    "clarify-mistakes",
    "use-course-materials",
  ],
  contextRequirements: {
    profile: true,
    course: true,
    documents: true,
    selectedDocumentCoverage: true,
    learning: true,
    memories: true,
    memoryCategories: ["preference", "learning-pattern", "successful-strategy"],
    memoryKeys: ["explanationStyle", "answerLength"],
    limits: { memories: 5 },
  },
};

/** Routing metadata only; execution instructions are configured separately. */
export function getTutorAgentDefinition(): Agent {
  return copyAgent(definition);
}
