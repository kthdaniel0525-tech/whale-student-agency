import "server-only";
import { copyAgent } from "../metadata";
import type { Agent } from "../types";

const definition: Agent = {
  id: "career", name: "Career",
  description: "Connects actual projects, skills and experience to resumes, portfolios and career development.",
  capabilities: ["career-guidance", "resume-improvement", "resume-bullet-generation", "portfolio-guidance", "project-positioning", "internship-preparation", "skill-gap-analysis"],
  contextRequirements: {
    profile: true, career: true, course: true, memories: true,
    memoryCategories: ["career-goal", "preference"],
    memoryKeys: ["targetRole", "targetIndustry", "targetCompanies", "internshipTimeline", "portfolioGoal", "answerLength"],
    assignments: false, exams: false, documents: false, learning: false,
    limits: { memories: 6, maxCharacters: 40000 },
  },
};
export function getCareerAgentDefinition(): Agent { return copyAgent(definition); }
