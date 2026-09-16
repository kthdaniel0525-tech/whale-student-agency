import "server-only";
import { copyAgent } from "../metadata";
import type { Agent } from "../types";

const definition: Agent = {
  id: "academic-manager",
  name: "Academic Manager",
  description: "Interprets academic readiness, workload and risks, and recommends the next useful action.",
  capabilities: [
    "academic-coordination", "prioritize-deadlines", "prioritize-academic-work",
    "semester-overview", "recommend-next-actions", "identify-risks",
    "route-specialist-work", "academic-readiness-analysis",
  ],
  contextRequirements: {
    profile: true, course: true, assignments: true, exams: true,
    learning: true, memories: true, academicOverview: true,
    memoryCategories: ["preference", "academic-goal", "learning-pattern", "successful-strategy"],
    memoryKeys: ["academicGoal", "targetGrade", "studySessionMinutes", "planningIntensity"],
    deadlineWindowDays: 30,
    limits: { assignments: 20, exams: 10, learning: 10, memories: 6, maxCharacters: 40000 },
  },
};

export function getAcademicManagerAgentDefinition(): Agent {
  return copyAgent(definition);
}
