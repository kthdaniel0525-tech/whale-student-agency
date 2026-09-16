import "server-only";
import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
export const careerAnalysisSchema = z.object({
  targetRole: text(160).nullable().describe("Exact requested target role or saved role, otherwise null; do not assume a program's role."),
  summary: text(1600),
  strengths: z.array(text(500)).max(8),
  gaps: z.array(text(600)).max(8).describe("Gaps in the supplied evidence, not claims of inability or universal hiring requirements."),
  recommendedProjects: z.array(z.object({
    projectId: text(100).nullable().describe("An ID from supplied projects, or null for a proposed new project."),
    recommendation: text(800),
  }).strict()).max(6),
  recommendedSkills: z.array(text(500)).max(8),
  nextActions: z.array(text(600)).min(1).max(8),
  resumeBullets: z.array(z.object({
    evidenceId: text(150).describe("Supplied project/skill/experience evidenceId, resume, or request for experience explicitly provided in this turn."),
    original: text(2000).describe("An exact excerpt from the cited source describing actual experience, never an instruction to invent experience."),
    improved: text(900),
    rationale: text(500),
  }).strict()).max(8),
}).strict();
export type CareerAnalysis = z.infer<typeof careerAnalysisSchema>;
export type CareerResponse = CareerAnalysis & {
  guidanceScope: "general-role-guidance";
  limitations: string[];
};
