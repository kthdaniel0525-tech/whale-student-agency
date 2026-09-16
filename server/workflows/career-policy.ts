import "server-only";
import { z } from "zod";
import type { CareerContext } from "../career/types";
import { hasUnsupportedMetrics } from "../agents/career/grounding";

const text = (max: number) => z.string().trim().min(1).max(max);
const evidenceClaim = z.object({ statement: text(600), evidenceIds: z.array(text(150)).min(1).max(6) }).strict();
const gap = z.object({
  id: text(80), category: z.enum(["technical", "project", "resume", "portfolio", "interview", "experience", "application"]),
  gap: text(600), impact: text(500), evidenceStatus: z.enum(["missing", "uncertain"]), actionId: text(80),
}).strict();
const resumeBullet = z.object({ evidenceId: text(150), original: text(2000), improved: text(900), rationale: text(500) }).strict();
export const careerPreparationAnalysisSchema = z.object({
  targetRole: text(160), marketScope: z.literal("general-role-guidance"), summary: text(1600),
  strengths: z.array(evidenceClaim).max(6), criticalGaps: z.array(gap).max(4), secondaryGaps: z.array(gap).max(4),
  projectPriorities: z.array(z.object({ projectId: text(100), priority: z.enum(["high", "medium", "low"]),
    strengths: z.array(text(500)).max(4), improvements: z.array(text(600)).min(1).max(5), reason: text(500) }).strict()).max(10),
  resume: z.object({ state: z.enum(["missing", "needs-work", "ready"]), improvements: z.array(text(600)).max(6), bullets: z.array(resumeBullet).max(5) }).strict(),
  portfolio: z.object({ state: z.enum(["missing", "needs-work", "ready"]), improvements: z.array(text(600)).max(6) }).strict(),
  interviewPreparation: z.array(text(600)).max(6),
  actions: z.array(z.object({ id: text(80), category: z.enum(["skill", "project", "resume", "portfolio", "interview", "application"]),
    title: text(220), description: text(800), priority: z.enum(["critical", "high", "medium"]),
    estimatedMinutes: z.number().int().min(30).max(1200), projectId: text(100).nullable(), evidenceIds: z.array(text(150)).max(6) }).strict()).min(1).max(10),
}).strict().refine((value) => JSON.stringify(value).length <= 14000, "Keep the reusable career assessment bounded.");
export type CareerPreparationAnalysis = z.infer<typeof careerPreparationAnalysisSchema>;
export type CareerReadinessLevel = "weak" | "developing" | "good" | "strong";
export type CareerReadiness = Record<"technicalFoundation" | "projectStrength" | "resumeQuality" | "portfolioQuality" | "interviewPreparation" | "applicationReadiness", {
  level: CareerReadinessLevel; reason: string;
}>;
export type CareerTimeline = { startDate: string; targetDate: string; weeks: number; assumption: string | null };
export type CareerProvidedData = { resumeData?: string; experienceSummary?: string; portfolioLinks?: string[] };
export type CareerPreparationState = {
  targetRole: string; targetIndustry?: string; targetCompanies: string[]; selectedProjectIds: string[];
  timeline: CareerTimeline; weeklyAvailableMinutes: number; availabilityAssumption: string | null;
  sourceFingerprint: string; readiness: CareerReadiness; missingInputs: string[]; provided: CareerProvidedData;
  stage: "assess-current-state" | "waiting-for-data" | "identify-gaps" | "create-plan";
  analysis: CareerPreparationAnalysis | null; planId: string | null; nextAction: string; limitations: string[];
};
export type CareerPreparationResult = {
  targetRole: string; stage: CareerPreparationState["stage"]; readiness: CareerReadiness;
  criticalGaps: CareerPreparationAnalysis["criticalGaps"]; selectedProjects: CareerPreparationAnalysis["projectPriorities"];
  planId: string | null; missingInputs: string[]; nextAction: string; limitations: string[];
};

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);
export function resolveCareerTimeline(value: string | undefined, now = new Date()): CareerTimeline | null {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let target: Date;
  let assumption: string | null = null;
  if (!value) {
    target = new Date(start.getTime() + 8 * 7 * 86400000);
    assumption = "No application timeline was supplied; the plan uses an eight-week preparation window.";
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    target = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(target.getTime()) || dateOnly(target) !== value) return null;
  }
  else {
    const match = value.trim().toLowerCase().match(/(?:applications?\s+(?:start\s+)?)?(?:in\s+)?(\d{1,2})\s*(week|weeks|month|months)/);
    if (!match) return null;
    const amount = Number(match[1]);
    target = new Date(start.getTime() + amount * (match[2].startsWith("month") ? 30 : 7) * 86400000);
  }
  if (!Number.isFinite(target.getTime()) || target <= start) return null;
  const weeks = Math.ceil((target.getTime() - start.getTime()) / (7 * 86400000));
  if (weeks < 1 || weeks > 52) return null;
  return { startDate: dateOnly(start), targetDate: dateOnly(target), weeks, assumption };
}

function level(score: number): CareerReadinessLevel {
  return score >= 3 ? "strong" : score >= 2 ? "good" : score >= 1 ? "developing" : "weak";
}
export function calculateCareerReadiness(career: CareerContext, provided: CareerProvidedData): CareerReadiness {
  const projects = career.projects;
  const technicalSignals = new Set([...career.skills.filter((skill) => skill.evidence.length || skill.selfReportedProficiency).map((skill) => skill.name.toLowerCase()), ...projects.flatMap((project) => project.technologies.map((item) => item.toLowerCase()))]);
  const polished = projects.filter((project) => project.technologies.length && project.description && (project.outcomes.length || project.link || project.repositoryUrl));
  const resume = provided.resumeData ?? career.profile?.resumeText ?? "";
  const portfolioLinks = [...(provided.portfolioLinks ?? []), ...(career.profile?.portfolioLinks ?? [])];
  const interviewEvidence = [...(career.profile?.experiences ?? []).map((item) => item.text), ...(provided.experienceSummary ? [provided.experienceSummary] : []), ...career.skills.flatMap((skill) => skill.evidence)]
    .filter((item) => /interview|algorithm practice|coding practice|behavioral|mock interview/i.test(item));
  const experienceEvidence = (career.profile?.experiences.length ?? 0) + (provided.experienceSummary ? 1 : 0);
  const technicalScore = technicalSignals.size >= 6 ? 3 : technicalSignals.size >= 3 ? 2 : technicalSignals.size ? 1 : 0;
  const projectScore = polished.length >= 3 ? 3 : polished.length >= 1 && projects.length >= 2 ? 2 : projects.length ? 1 : 0;
  const resumeScore = resume.length >= 700 && /\b(?:built|created|developed|implemented|led|designed)\b/i.test(resume) ? 3 : resume.length >= 250 ? 2 : resume.length ? 1 : 0;
  const portfolioScore = polished.filter((project) => project.link || project.repositoryUrl).length >= 2 ? 3 : portfolioLinks.length && polished.length ? 2 : projects.length || portfolioLinks.length ? 1 : 0;
  const interviewScore = interviewEvidence.length >= 3 ? 3 : interviewEvidence.length >= 2 ? 2 : interviewEvidence.length ? 1 : 0;
  const applicationScore = resumeScore >= 2 && projectScore >= 2 && (experienceEvidence || portfolioScore >= 2) ? 3 : resumeScore >= 1 && projectScore >= 1 ? 2 : resumeScore || projectScore || experienceEvidence ? 1 : 0;
  return {
    technicalFoundation: { level: level(technicalScore), reason: technicalSignals.size ? `${technicalSignals.size} supplied skill or project technology signals are available; proficiency remains self-reported unless evidence says otherwise.` : "No technical foundation evidence was supplied; this does not prove inability." },
    projectStrength: { level: level(projectScore), reason: projects.length ? `${projects.length} selected or recent projects are available, including ${polished.length} with technology plus outcome/link evidence.` : "No project evidence was supplied." },
    resumeQuality: { level: level(resumeScore), reason: resume ? "Resume text is available for evidence-based improvement." : "Resume text is missing, so resume quality cannot be demonstrated." },
    portfolioQuality: { level: level(portfolioScore), reason: `${projects.length} projects and ${portfolioLinks.length} portfolio links are available for review.` },
    interviewPreparation: { level: level(interviewScore), reason: interviewEvidence.length ? `${interviewEvidence.length} supplied items mention interview or practice preparation.` : "No interview-practice evidence was supplied; current ability is unknown." },
    applicationReadiness: { level: level(applicationScore), reason: "Level reflects supplied resume, project, portfolio and experience evidence, not hiring probability." },
  };
}

export function careerMissingInputs(career: CareerContext, provided: CareerProvidedData, goal: string): string[] {
  const hasEvidence = Boolean(provided.resumeData || provided.experienceSummary || career.profile?.resumeText || career.profile?.experiences.length || career.projects.length || career.skills.length);
  const missing = hasEvidence ? [] : ["resume, experience, project, or skill evidence"];
  if (/resume|résumé/i.test(goal) && !provided.resumeData && !career.profile?.resumeText) missing.push("resume text");
  if (/portfolio/i.test(goal) && !career.projects.length && !(provided.portfolioLinks?.length || career.profile?.portfolioLinks.length)) missing.push("project or portfolio details");
  return [...new Set(missing)];
}

export function validateCareerAnalysis(value: CareerPreparationAnalysis, targetRole: string, career: CareerContext, provided: CareerProvidedData, requiredProjectIds: readonly string[] = []) {
  if (value.targetRole.toLowerCase() !== targetRole.toLowerCase()) return false;
  const evidence = new Map<string, string>();
  if (career.profile?.resumeText) evidence.set("resume", career.profile.resumeText);
  for (const item of career.profile?.experiences ?? []) evidence.set(item.evidenceId, item.text);
  for (const project of career.projects) evidence.set(project.evidenceId, [project.name, project.description, project.role, ...project.technologies, ...project.outcomes].filter(Boolean).join("\n"));
  for (const skill of career.skills) evidence.set(skill.evidenceId, [skill.name, skill.selfReportedProficiency, ...skill.evidence].filter(Boolean).join("\n"));
  for (const course of career.academicEvidence) evidence.set(course.evidenceId, [course.courseCode, course.courseName, course.description].filter(Boolean).join("\n"));
  if (provided.resumeData) evidence.set("provided-resume", provided.resumeData);
  if (provided.experienceSummary) evidence.set("provided-experience", provided.experienceSummary);
  for (const [index, link] of (provided.portfolioLinks ?? []).entries()) evidence.set(`provided-portfolio:${index}`, link);
  const allEvidence = [...evidence.values(), targetRole].join("\n");
  const projects = new Set(career.projects.map((project) => project.id));
  const prioritizedProjects = new Set(value.projectPriorities.map((project) => project.projectId));
  const actions = new Map(value.actions.map((action) => [action.id, action]));
  if (actions.size !== value.actions.length || prioritizedProjects.size !== value.projectPriorities.length || [...value.criticalGaps, ...value.secondaryGaps].some((item) => !actions.has(item.actionId))) return false;
  if (requiredProjectIds.some((id) => !prioritizedProjects.has(id))) return false;
  if (value.criticalGaps.some((item) => actions.get(item.actionId)?.priority === "medium")) return false;
  const projectRank = { high: 3, medium: 2, low: 1 } as const;
  if (value.projectPriorities.some((item, index) => index > 0 && projectRank[value.projectPriorities[index - 1].priority] < projectRank[item.priority])) return false;
  if (value.projectPriorities.some((project) => !projects.has(project.projectId)) || value.actions.some((action) => action.projectId && !projects.has(action.projectId))) return false;
  for (const claim of value.strengths) {
    const sources = claim.evidenceIds.map((id) => evidence.get(id));
    if (sources.some((source) => !source) || hasUnsupportedMetrics(claim.statement, sources.join("\n"))) return false;
  }
  if (hasUnsupportedMetrics(value.summary, allEvidence)) return false;
  for (const project of value.projectPriorities) {
    const source = evidence.get(`project:${project.projectId}`) ?? "";
    if (project.strengths.some((statement) => hasUnsupportedMetrics(statement, source))) return false;
  }
  for (const bullet of value.resume.bullets) {
    const source = evidence.get(bullet.evidenceId);
    if (!source || !source.includes(bullet.original) || hasUnsupportedMetrics(bullet.improved, bullet.original)) return false;
  }
  return !value.actions.some((action) => action.evidenceIds.some((id) => !evidence.has(id)));
}

export type ScheduledCareerTask = { actionId: string; projectId: string | null; weekNumber: number; category: CareerPreparationAnalysis["actions"][number]["category"]; title: string; description: string; priority: number; durationMinutes: number; targetDate: string };
export function scheduleCareerActions(analysis: CareerPreparationAnalysis, timeline: CareerTimeline, weeklyAvailableMinutes: number) {
  const rank = { critical: 3, high: 2, medium: 1 } as const;
  const shortOrder = { resume: 6, portfolio: 5, application: 4, interview: 3, project: 2, skill: 1 } as const;
  const longOrder = { project: 6, skill: 5, interview: 4, resume: 3, portfolio: 2, application: 1 } as const;
  const category = timeline.weeks <= 3 ? shortOrder : longOrder;
  const actions = analysis.actions.slice().sort((a, b) => rank[b.priority] - rank[a.priority] || category[b.category] - category[a.category] || a.id.localeCompare(b.id));
  const remainingByWeek = Array.from({ length: timeline.weeks }, () => weeklyAvailableMinutes);
  const tasks: ScheduledCareerTask[] = [], deferredActions: CareerPreparationAnalysis["actions"] = [];
  for (const action of actions) {
    let minutes = action.estimatedMinutes;
    for (let week = 0; week < timeline.weeks && minutes > 0; week++) {
      const allocation = Math.min(minutes, remainingByWeek[week]);
      if (!allocation) continue;
      remainingByWeek[week] -= allocation; minutes -= allocation;
      const date = new Date(`${timeline.startDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + week * 7 + 6);
      const targetDate = dateOnly(new Date(Math.min(date.getTime(), new Date(`${timeline.targetDate}T00:00:00Z`).getTime())));
      tasks.push({ actionId: action.id, projectId: action.projectId, weekNumber: week + 1, category: action.category,
        title: action.title, description: action.description, priority: rank[action.priority] === 3 ? 100 : rank[action.priority] === 2 ? 75 : 50,
        durationMinutes: allocation, targetDate });
    }
    if (minutes > 0) deferredActions.push({ ...action, estimatedMinutes: minutes });
  }
  return { tasks, deferredActions, totalPlannedMinutes: tasks.reduce((sum, task) => sum + task.durationMinutes, 0),
    weeklyTotals: remainingByWeek.map((remaining, index) => ({ week: index + 1, plannedMinutes: weeklyAvailableMinutes - remaining, availableMinutes: weeklyAvailableMinutes })) };
}
