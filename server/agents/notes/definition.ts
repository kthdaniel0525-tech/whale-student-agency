import "server-only";
import { copyAgent } from "../metadata";
import type { Agent } from "../types";

const definition: Agent = {
  id: "notes",
  name: "Notes",
  description: "Summarizes course documents and organizes study notes.",
  capabilities: [
    "summarize-documents",
    "create-notes",
    "extract-key-concepts",
    "extract-definitions",
    "create-review-notes",
  ],
  contextRequirements: {
    course: true,
    documents: true,
    exams: true,
    learning: true,
    memories: true,
    memoryCategories: ["preference"],
    memoryKeys: ["noteStyle", "answerLength"],
    deadlineWindowDays: 30,
    limits: { exams: 4, learning: 6, memories: 3 },
  },
};

export function getNotesAgentDefinition(): Agent {
  return copyAgent(definition);
}
