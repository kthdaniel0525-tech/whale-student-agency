import "server-only";
import { auth } from "../auth/config";
import { buildUserContext } from "../context/builder";
import { db } from "../db/client";
import { getTopRecommendations } from "../recommendations";
import {
  calculateCareerReadiness,
  careerPreparationAnalysisSchema,
  type CareerPreparationAnalysis,
} from "../workflows/career-policy";
import type { CareerWorkspace, CareerWorkspaceReadiness } from "./types";

export class CareerWorkspaceError extends Error {
  readonly code = "UNAUTHENTICATED";
  constructor() {
    super("Sign in to view your career workspace.");
    this.name = "CareerWorkspaceError";
  }
}

const readinessLabels: Record<CareerWorkspaceReadiness["id"], string> = {
  technicalFoundation: "Technical foundation",
  projectStrength: "Project strength",
  resumeQuality: "Resume quality",
  portfolioQuality: "Portfolio quality",
  interviewPreparation: "Interview preparation",
  applicationReadiness: "Application readiness",
};

const planStatus = { ACTIVE: "active", COMPLETED: "completed", ARCHIVED: "archived" } as const;
const taskStatus = { PLANNED: "planned", IN_PROGRESS: "in-progress", COMPLETED: "completed", SKIPPED: "skipped" } as const;

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 10);
}

function memoryValue(memories: Awaited<ReturnType<typeof buildUserContext>>["memories"], key: string) {
  return memories?.find((item) => item.key === key && !item.stale)?.value;
}

function evidenceFor(
  id: CareerWorkspaceReadiness["id"],
  career: NonNullable<Awaited<ReturnType<typeof buildUserContext>>["career"]>,
): string[] {
  const polished = career.projects.filter((project) => project.technologies.length && (project.outcomes.length || project.link || project.repositoryUrl));
  const technologies = new Set(career.projects.flatMap((project) => project.technologies.map((item) => item.toLowerCase())));
  const linked = career.projects.filter((project) => project.link || project.repositoryUrl);
  const resume = career.profile?.resumeText;
  const interviewEvidence = [
    ...(career.profile?.experiences.map((item) => item.text) ?? []),
    ...career.skills.flatMap((skill) => skill.evidence),
  ].filter((item) => /interview|algorithm practice|coding practice|behavioral|mock interview/i.test(item));
  const values: Record<CareerWorkspaceReadiness["id"], string[]> = {
    technicalFoundation: [
      `${career.skills.length} saved skill${career.skills.length === 1 ? "" : "s"}`,
      `${technologies.size} distinct project technolog${technologies.size === 1 ? "y" : "ies"}`,
    ],
    projectStrength: [
      `${career.projects.length} saved project${career.projects.length === 1 ? "" : "s"}`,
      `${polished.length} with technology plus outcome or link evidence`,
    ],
    resumeQuality: [resume ? "Resume text is saved" : "No resume text is saved", `${career.profile?.experiences.length ?? 0} saved experience item${career.profile?.experiences.length === 1 ? "" : "s"}`],
    portfolioQuality: [`${career.profile?.portfolioLinks.length ?? 0} portfolio link${career.profile?.portfolioLinks.length === 1 ? "" : "s"}`, `${linked.length} project${linked.length === 1 ? "" : "s"} with a repository or live link`],
    interviewPreparation: [interviewEvidence.length ? `${interviewEvidence.length} saved item${interviewEvidence.length === 1 ? "" : "s"} mention interview practice` : "No interview-practice evidence is saved"],
    applicationReadiness: [resume ? "Resume evidence is available" : "Resume evidence is missing", polished.length ? "At least one supported project is available" : "No supported project is available"],
  };
  return values[id];
}

function fallbackGaps(career: NonNullable<Awaited<ReturnType<typeof buildUserContext>>["career"]>, targetRole: string | null) {
  const gaps: CareerWorkspace["gaps"] = [];
  if (!targetRole) gaps.push({ id: "target-role", category: "profile", title: "Choose a target role", detail: "A target role is needed before guidance can be role-focused.", priority: "critical", projectId: null });
  if (!career.projects.length) gaps.push({ id: "projects", category: "project", title: "Add project evidence", detail: "No project is available to demonstrate applied work yet.", priority: "high", projectId: null });
  if (!career.skills.length) gaps.push({ id: "skills", category: "technical", title: "Add skills with evidence", detail: "No saved skill evidence is available for the current profile.", priority: "high", projectId: null });
  if (!career.profile?.resumeText) gaps.push({ id: "resume", category: "resume", title: "Add resume details", detail: "Resume quality cannot be reviewed until resume text is saved.", priority: "high", projectId: null });
  const incomplete = career.projects.find((project) => !project.outcomes.length || (!project.link && !project.repositoryUrl));
  if (incomplete) gaps.push({ id: `project-evidence:${incomplete.id}`, category: "project", title: `Strengthen ${incomplete.name}`, detail: !incomplete.outcomes.length ? "Add a truthful outcome or concrete result." : "Add a repository or live project link.", priority: "medium", projectId: incomplete.id });
  if (!career.profile?.portfolioLinks.length && !career.projects.some((project) => project.link)) gaps.push({ id: "portfolio", category: "portfolio", title: "Add portfolio evidence", detail: "No portfolio or live project link is currently saved.", priority: "medium", projectId: incomplete?.id ?? null });
  return gaps.slice(0, 5);
}

function analysisFrom(value: unknown): CareerPreparationAnalysis | null {
  const parsed = careerPreparationAnalysisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Read-only aggregation. It uses current structured data and a persisted Career
 * Preparation result; normal page loads never initialize an AI provider. */
export async function getCareerWorkspace(
  userId: string,
  requestHeaders: Headers,
  options: {
    now?: Date;
    buildContext?: typeof buildUserContext;
    loadRecommendations?: typeof getTopRecommendations;
  } = {},
): Promise<CareerWorkspace> {
  const headers = new Headers(requestHeaders);
  const session = await auth().api.getSession({ headers, query: { disableRefresh: true } });
  if (!session?.user.id || session.user.id !== userId) throw new CareerWorkspaceError();
  const now = options.now ?? new Date();
  const buildContext = options.buildContext ?? buildUserContext;
  const loadRecommendations = options.loadRecommendations ?? getTopRecommendations;
  const context = await buildContext({
    request: "Build the current career workspace from saved evidence.",
    options: {
      career: true,
      memories: true,
      memoryCategories: ["career-goal"],
      memoryKeys: ["targetRole", "targetIndustry", "targetCompanies", "internshipTimeline", "portfolioGoal"],
      limits: { memories: 10, maxCharacters: 32_000 },
    },
  }, headers);
  const career = context.career ?? { profile: null, projects: [], skills: [], academicEvidence: [], limitations: [] };
  const [run, plan, recommendations] = await Promise.all([
    db().workflowRun.findFirst({ where: { userId, workflowId: "career-preparation", status: "COMPLETED" }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], select: { context: true, updatedAt: true } }),
    db().careerPlan.findFirst({ where: { userId, status: "ACTIVE" }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], include: { tasks: { where: { userId }, orderBy: [{ status: "asc" }, { weekNumber: "asc" }, { priority: "desc" }, { id: "asc" }], include: { project: { select: { id: true, userId: true, name: true } } } } } }),
    loadRecommendations({ userId, limit: 10, now, refresh: false }).catch(() => []),
  ]);
  const targetRoleMemory = memoryValue(context.memories, "targetRole");
  const targetIndustryMemory = memoryValue(context.memories, "targetIndustry");
  const targetCompaniesMemory = memoryValue(context.memories, "targetCompanies");
  const timelineMemory = memoryValue(context.memories, "internshipTimeline");
  const targetRole = career.profile?.targetRoles[0] ?? (typeof targetRoleMemory === "string" ? targetRoleMemory : null);
  const targetIndustry = career.profile?.targetIndustries[0] ?? (typeof targetIndustryMemory === "string" ? targetIndustryMemory : null);
  const targetCompanies = strings(targetCompaniesMemory);
  const applicationTimeline = typeof timelineMemory === "string" ? timelineMemory : plan?.targetDate?.toISOString().slice(0, 10) ?? null;

  const dates = [career.profile?.updatedAt, ...career.projects.map((item) => item.updatedAt), ...career.skills.map((item) => item.updatedAt), ...(context.memories?.map((item) => item.lastUpdated) ?? [])]
    .filter((value): value is string => Boolean(value)).map((value) => new Date(value).getTime()).filter(Number.isFinite);
  const evidenceUpdatedAt = dates.length ? new Date(Math.max(...dates)) : null;
  const rawState = run?.context && typeof run.context === "object" ? (run.context as { careerPreparation?: { analysis?: unknown } }).careerPreparation : undefined;
  const persisted = analysisFrom(rawState?.analysis);
  const analysisCurrent = Boolean(persisted && run && (!evidenceUpdatedAt || run.updatedAt.getTime() >= evidenceUpdatedAt.getTime()));
  const analysis = analysisCurrent ? persisted : null;
  const calculated = calculateCareerReadiness(career, {});
  const readiness = (Object.keys(readinessLabels) as CareerWorkspaceReadiness["id"][]).map((id) => ({ id, label: readinessLabels[id], ...calculated[id], evidence: evidenceFor(id, career) }));

  const projectEvidence = new Map(career.projects.map((project) => [project.id, analysis?.projectPriorities.find((item) => item.projectId === project.id)]));
  const priorityRank = { high: 3, medium: 2, low: 1 } as const;
  const projects: CareerWorkspace["projects"] = career.projects.map((project) => {
    const saved = projectEvidence.get(project.id);
    const missing: string[] = [];
    if (!project.outcomes.length) missing.push("Add a truthful outcome or result.");
    if (!project.repositoryUrl) missing.push("Add the repository when it is available.");
    if (!project.link) missing.push("Add a live demo or deployment when it exists.");
    const status = project.technologies.length && project.outcomes.length && (project.link || project.repositoryUrl) ? "evidence-ready" as const : "developing" as const;
    const fallbackPriority = status === "developing" ? "high" as const : "medium" as const;
    return {
      id: project.id, name: project.name, description: project.description, technologies: project.technologies,
      role: project.role, outcomes: project.outcomes, link: project.link, repositoryUrl: project.repositoryUrl,
      course: project.course ? { id: project.course.id, label: `${project.course.courseCode} ${project.course.courseName}` } : null,
      status,
      priority: saved?.priority ?? fallbackPriority,
      priorityReason: saved?.reason ?? (status === "developing" ? "Important project evidence is incomplete." : `This project has enough saved evidence for ${targetRole ?? "career"} review.`),
      strengths: saved?.strengths ?? [project.technologies.length ? `${project.technologies.length} technologies are documented.` : "A project description is saved."],
      improvements: saved?.improvements ?? (missing.length ? missing : ["Keep outcomes and links current."]),
    };
  }).sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || a.name.localeCompare(b.name));

  const skillGroupsMap = new Map<string, CareerWorkspace["skillGroups"][number]["skills"]>();
  for (const skill of career.skills) {
    const category = skill.category || "Other";
    const lower = skill.name.toLowerCase();
    const projectsForSkill = career.projects.filter((project) => project.technologies.some((technology) => technology.toLowerCase() === lower)).map((project) => ({ id: project.id, name: project.name }));
    const coursesForSkill = career.academicEvidence.filter((course) => [course.courseCode, course.courseName, course.description ?? ""].some((text) => text.toLowerCase().includes(lower))).map((course) => ({ id: course.courseId, label: `${course.courseCode} ${course.courseName}` }));
    const items = skillGroupsMap.get(category) ?? [];
    items.push({ id: skill.id, name: skill.name, proficiency: skill.selfReportedProficiency, evidence: skill.evidence, projectEvidence: projectsForSkill, courseEvidence: coursesForSkill });
    skillGroupsMap.set(category, items);
  }
  const skillGroups = [...skillGroupsMap].sort(([a], [b]) => a.localeCompare(b)).map(([category, skills]) => ({ category, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) }));
  const gaps: CareerWorkspace["gaps"] = analysis ? [...analysis.criticalGaps.map((gap) => ({ id: gap.id, category: gap.category, title: gap.gap, detail: gap.impact, priority: "critical" as const, projectId: null })), ...analysis.secondaryGaps.map((gap) => ({ id: gap.id, category: gap.category, title: gap.gap, detail: gap.impact, priority: "medium" as const, projectId: null }))].slice(0, 6) : fallbackGaps(career, targetRole);

  const resumeText = career.profile?.resumeText ?? null;
  const resumeStatus = analysis?.resume.state ?? (resumeText ? (resumeText.length >= 250 ? "needs-work" : "needs-work") : "missing");
  const resumeImprovements = analysis?.resume.improvements ?? (resumeText ? ["Run an evidence-based review when you want role-specific improvements."] : ["Add resume text before requesting a review."]);
  const portfolioStatus = analysis?.portfolio.state ?? (career.profile?.portfolioLinks.length || career.projects.some((project) => project.link) ? "needs-work" : "missing");
  const portfolioGaps = projects.filter((project) => project.status === "developing").slice(0, 3).map((project) => `${project.name}: ${project.improvements[0]}`);

  const careerRecommendations = recommendations.filter((item) => item.type === "career-preparation" || item.sourceType === "career-plan").slice(0, 5);
  const nextTask = plan?.tasks.find((task) => task.status !== "COMPLETED" && task.status !== "SKIPPED");
  const topGap = gaps[0] ?? null;
  const nextAction: CareerWorkspace["nextAction"] = careerRecommendations[0] ? {
    title: careerRecommendations[0].title, message: careerRecommendations[0].message, kind: "recommendation", recommendationId: careerRecommendations[0].id,
  } : nextTask ? {
    title: nextTask.title, message: nextTask.description, kind: "career-task", ...(nextTask.projectId ? { projectId: nextTask.projectId } : {}),
  } : topGap ? {
    title: topGap.title, message: topGap.detail, kind: targetRole ? "gap" : "setup", ...(topGap.projectId ? { projectId: topGap.projectId } : {}),
  } : null;

  return {
    isEmpty: !career.profile && !career.projects.length && !career.skills.length && !plan,
    generatedAt: now.toISOString(), evidenceUpdatedAt: evidenceUpdatedAt?.toISOString() ?? null,
    analysis: { source: analysis ? "persisted-career-workflow" : "current-data", current: analysisCurrent, updatedAt: run?.updatedAt.toISOString() ?? null },
    profile: {
      careerGoal: career.profile?.careerGoal ?? null, targetRole, targetIndustry,
      targetRoles: career.profile?.targetRoles ?? [], targetIndustries: career.profile?.targetIndustries ?? [],
      targetCompanies, applicationTimeline,
      experiences: career.profile?.experiences.map((item) => item.text) ?? [], portfolioLinks: career.profile?.portfolioLinks ?? [], resumeText,
    },
    overview: { targetRole, currentFocus: nextTask?.title ?? projects[0]?.name ?? null, topGap: topGap?.title ?? null, nextAction: nextAction?.title ?? null },
    readiness: career.profile || career.projects.length || career.skills.length ? readiness : [],
    skillGroups, gaps, projects,
    resume: {
      status: resumeStatus, text: resumeText, improvements: resumeImprovements, bullets: analysis?.resume.bullets ?? [],
      checks: [
        { label: "Resume details", met: Boolean(resumeText), detail: resumeText ? "Resume text is saved." : "Add resume text." },
        { label: "Project evidence", met: career.projects.some((project) => project.outcomes.length > 0), detail: career.projects.some((project) => project.outcomes.length > 0) ? "At least one project has an outcome." : "Add truthful project outcomes." },
        { label: "Target role", met: Boolean(targetRole), detail: targetRole ? `Guidance can use ${targetRole}.` : "Choose a target role." },
      ],
    },
    portfolio: { status: portfolioStatus, links: career.profile?.portfolioLinks ?? [], improvements: analysis?.portfolio.improvements ?? (portfolioGaps.length ? portfolioGaps : ["Add a portfolio or live project link when available."]), gaps: portfolioGaps },
    careerPlan: plan ? {
      id: plan.id, targetRole: plan.targetRole, targetIndustry: plan.targetIndustry, startDate: plan.startDate.toISOString(), targetDate: plan.targetDate?.toISOString() ?? null,
      weeklyAvailableMinutes: plan.weeklyAvailableMinutes, totalPlannedMinutes: plan.totalPlannedMinutes, summary: plan.summary, status: planStatus[plan.status],
      tasks: plan.tasks.filter((task) => !task.project || task.project.userId === userId).map((task) => ({
        id: task.id, projectId: task.projectId, projectName: task.project?.name ?? null, weekNumber: task.weekNumber, category: task.category.toLowerCase(),
        title: task.title, description: task.description, priority: task.priority, durationMinutes: task.durationMinutes, status: taskStatus[task.status], targetDate: task.targetDate?.toISOString() ?? null,
      })),
    } : null,
    recommendations: careerRecommendations.map(({ id, title, message, priority }) => ({ id, title, message, priority })),
    nextAction, limitations: [...career.limitations, ...(persisted && !analysisCurrent ? ["Saved Career Agent analysis is older than current profile evidence, so current deterministic guidance is shown."] : [])],
  };
}
