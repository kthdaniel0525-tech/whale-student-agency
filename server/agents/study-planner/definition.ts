import "server-only";
import { copyAgent } from "../metadata";
import type { Agent } from "../types";

const definition: Agent = {
  id: "study-planner",
  name: "Study Planner",
  description: "Creates and rebalances realistic study schedules.",
  capabilities: [
    "create-study-plan",
    "update-study-plan",
    "prioritize-deadlines",
    "prioritize-weak-topics",
    "allocate-study-time",
    "rebalance-study-plan",
    "create-daily-plan",
    "create-weekly-plan",
    "exam-preparation",
  ],
  contextRequirements: {
    profile: true,
    availability: true,
    course: true,
    assignments: true,
    exams: true,
    learning: true,
    memories: true,
    memoryCategories: ["preference", "academic-goal", "successful-strategy"],
    memoryKeys: ["academicGoal", "studySessionMinutes", "planningIntensity", "preferredStudyTime"],
    deadlineWindowDays: 90,
    limits: {
      assignments: 12,
      exams: 8,
      learning: 10,
      memories: 6,
      maxCharacters: 40000,
    },
  },
};

export function getStudyPlannerAgentDefinition(): Agent {
  return copyAgent(definition);
}
