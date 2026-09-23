import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CareerContext } from "../career/types";
import { buildUserContext } from "../context/builder";
import type { ContextReadCache } from "../context/cache";
import { AgentExecutor } from "../agents/executor";
import { persistCareerPlan } from "../career/plan-service";
import { NotFoundError } from "../services/academic";
import { workflowIdentity } from "./engine";
import { WorkflowError } from "./errors";
import { careerPreparationState } from "./career-preparation";
import { calculateCareerReadiness, careerMissingInputs, careerPreparationAnalysisSchema, resolveCareerTimeline, scheduleCareerActions, validateCareerAnalysis } from "./career-policy";
import type { CareerPreparationState, CareerProvidedData } from "./career-policy";
import type { StepInput, StepOutput, WorkflowContext, WorkflowStep } from "./types";

const id = z.string().min(1).max(100);
const compactText = (max: number) => z.string().trim().min(1).max(max);
export const careerProvidedDataSchema = z.object({
  resumeData: compactText(5000).optional(), experienceSummary: compactText(2000).optional(),
  portfolioLinks: z.array(z.string().url().max(500)).max(8).optional(),
}).strict().refine((value) => Boolean(value.resumeData || value.experienceSummary || value.portfolioLinks?.length), "Supply at least one career evidence field.");
export const careerInputSchema = z.object({
  workflowId: z.literal("career-preparation"), goal: z.string().trim().min(3).max(1000),
  conversationId: id.optional(),
  targetRole: compactText(160).optional(), targetIndustry: compactText(120).optional(), targetCompanies: z.array(compactText(120)).max(10).default([]),
  applicationTimeline: compactText(100).optional(), resumeData: compactText(5000).optional(),
  projectIds: z.array(id).min(1).max(10).transform((ids) => [...new Set(ids)].sort()).optional(),
  availableWeeklyMinutes: z.number().int().min(30).max(2400).optional(), availableWeeklyHours: z.number().min(.5).max(40).optional(),
}).strict();

function fingerprint(career: CareerContext) {
  return createHash("sha256").update(JSON.stringify({
    profile: career.profile?.updatedAt ?? null,
    projects: career.projects.map((item) => [item.id, item.updatedAt]).sort((a, b) => a[0].localeCompare(b[0])),
    skills: career.skills.map((item) => [item.id, item.updatedAt]).sort((a, b) => a[0].localeCompare(b[0])),
    courses: career.academicEvidence.map((item) => [item.courseId, item.updatedAt]).sort((a, b) => a[0].localeCompare(b[0])),
  })).digest("hex");
}
async function loadCareer(state: Pick<CareerPreparationState, "targetRole" | "selectedProjectIds">, headers: Headers, cache?: ContextReadCache) {
  try {
    const context = await buildUserContext({ request: `Career evidence for ${state.targetRole}`, projectIds: state.selectedProjectIds.length ? state.selectedProjectIds : undefined,
      options: { profile: true, career: true, limits: { maxCharacters: 40000 } } }, headers, cache);
    if (!context.career) throw new WorkflowError("CAREER_DATA_REQUIRED");
    return context;
  } catch (error) {
    if (error instanceof NotFoundError) throw new WorkflowError("REFERENCE_NOT_FOUND");
    throw error;
  }
}
export async function validateCareerScope(context: Readonly<WorkflowContext>, headers: Headers) {
  const state = careerPreparationState(context);
  const current = await loadCareer(state, headers);
  if (fingerprint(current.career!) !== state.sourceFingerprint) throw new WorkflowError("CAREER_DATA_CHANGED");
  return current;
}

export async function initialCareerContext(input: z.infer<typeof careerInputSchema>, headers: Headers, cache: ContextReadCache): Promise<WorkflowContext> {
  await workflowIdentity(headers);
  if (input.availableWeeklyMinutes !== undefined && input.availableWeeklyHours !== undefined) throw new WorkflowError("INVALID_REQUEST");
  const timeline = resolveCareerTimeline(input.applicationTimeline);
  if (!timeline) throw new WorkflowError("INVALID_REQUEST");
  const shell = { targetRole: input.targetRole ?? input.goal, selectedProjectIds: input.projectIds ?? [] };
  const current = await loadCareer(shell, headers, cache);
  const career = current.career!;
  const targetRole = input.targetRole ?? (career.profile?.targetRoles.length === 1 ? career.profile.targetRoles[0] : undefined);
  if (!targetRole) throw new WorkflowError("TARGET_ROLE_REQUIRED");
  const targetIndustry = input.targetIndustry ?? (career.profile?.targetIndustries.length === 1 ? career.profile.targetIndustries[0] : undefined);
  const provided: CareerProvidedData = { ...(input.resumeData ? { resumeData: input.resumeData } : {}) };
  const weeklyAvailableMinutes = input.availableWeeklyMinutes ?? (input.availableWeeklyHours ? Math.round(input.availableWeeklyHours * 60) : Math.max(120, (current.profile?.studySessionMinutes ?? 45) * 4));
  const missingInputs = careerMissingInputs(career, provided, input.goal);
  const state: CareerPreparationState = {
    targetRole, targetIndustry, targetCompanies: input.targetCompanies,
    selectedProjectIds: input.projectIds ?? [], timeline, weeklyAvailableMinutes,
    availabilityAssumption: input.availableWeeklyMinutes === undefined && input.availableWeeklyHours === undefined ? `No weekly career-work availability was supplied; using ${weeklyAvailableMinutes} minutes from the saved session preference.` : null,
    sourceFingerprint: fingerprint(career), readiness: calculateCareerReadiness(career, provided), missingInputs, provided,
    stage: missingInputs.length ? "waiting-for-data" : "assess-current-state", analysis: null, planId: null,
    nextAction: missingInputs.length ? `Provide ${missingInputs.join(" and ")} to continue.` : `Assess the highest-leverage gaps for ${targetRole}.`,
    limitations: [...career.limitations, "General role guidance only; no live job or company requirements were verified."],
  };
  return { goal: input.goal, conversationId: input.conversationId, courseId: "", careerPreparation: state, priorities: [], topics: [], studyPlanId: null, planCurrent: false,
    quizId: null, quizCurrent: false, quizMode: "practice", tutorTopic: null, targetTopics: [], previousStepSummaries: [] };
}

export async function prepareCareerResume(context: Readonly<WorkflowContext>, supplied: CareerProvidedData, headers: Headers) {
  const state = structuredClone(careerPreparationState(context));
  const current = await validateCareerScope(context, headers);
  state.provided = { ...state.provided, ...supplied,
    ...(supplied.portfolioLinks ? { portfolioLinks: [...new Set([...(state.provided.portfolioLinks ?? []), ...supplied.portfolioLinks])] } : {}) };
  state.missingInputs = careerMissingInputs(current.career!, state.provided, context.goal);
  if (state.missingInputs.length) throw new WorkflowError("CAREER_DATA_REQUIRED");
  state.readiness = calculateCareerReadiness(current.career!, state.provided);
  state.stage = "assess-current-state"; state.nextAction = `Assess the highest-leverage gaps for ${state.targetRole}.`;
  return { careerPreparation: state } as const;
}

export class CareerPreparationWorkflowAdapter {
  constructor(private readonly executor: AgentExecutor) {}
  async execute(step: WorkflowStep, input: StepInput, context: Readonly<WorkflowContext>, headers: Headers): Promise<StepOutput> {
    const state = structuredClone(careerPreparationState(context));
    const current = await validateCareerScope(context, headers);
    const career = current.career!;
    if (step.id === "assess-current-state") {
      if (state.missingInputs.length) {
        state.stage = "waiting-for-data"; state.nextAction = `Provide ${state.missingInputs.join(" and ")} to continue.`;
        return { summary: "Career preparation needs additional user evidence before making role-specific claims.", patch: { careerPreparation: state },
          waitForInput: { kind: "career-data", referenceId: state.sourceFingerprint.slice(0, 64) },
          data: { targetRole: state.targetRole, readiness: state.readiness, missingInputs: state.missingInputs, nextAction: state.nextAction } };
      }
      state.stage = "assess-current-state";
      return { summary: "Created a compact readiness state from supplied profile, project, skill, resume and academic evidence.", patch: { careerPreparation: state },
        data: { targetRole: state.targetRole, readiness: state.readiness, evidenceCounts: { projects: career.projects.length, skills: career.skills.length, courses: career.academicEvidence.length, experiences: career.profile?.experiences.length ?? 0 }, limitations: career.limitations } };
    }
    if (step.id === "create-plan") {
      if (!state.analysis) throw new WorkflowError("INVALID_RESPONSE");
      const schedule = scheduleCareerActions(state.analysis, state.timeline, state.weeklyAvailableMinutes);
      if (!schedule.tasks.length) throw new WorkflowError("INVALID_RESPONSE");
      const { userId } = await workflowIdentity(headers);
      let plan;
      try { plan = await persistCareerPlan(userId, state, state.analysis.summary, schedule.tasks); }
      catch { throw new WorkflowError("CAREER_PLAN_FAILURE"); }
      state.planId = plan.id; state.stage = "create-plan"; state.nextAction = schedule.tasks[0].title;
      return { summary: `Created a ${state.timeline.weeks}-week career plan within ${state.weeklyAvailableMinutes} available minutes per week.`, patch: { careerPreparation: state },
        data: { planId: plan.id, targetRole: state.targetRole, timeline: state.timeline, weeklyAvailableMinutes: state.weeklyAvailableMinutes,
          weeklyTotals: schedule.weeklyTotals, tasks: plan.tasks.map((task) => ({ id: task.id, actionId: task.actionId, projectId: task.projectId, week: task.weekNumber, category: task.category.toLowerCase(), title: task.title, description: task.description, priority: task.priority, durationMinutes: task.durationMinutes, targetDate: task.targetDate?.toISOString().slice(0, 10) })),
          deferredActions: schedule.deferredActions.map((action) => ({ id: action.id, title: action.title, remainingMinutes: action.estimatedMinutes })), assumption: state.availabilityAssumption, nextAction: state.nextAction } };
    }
    if (step.id !== "identify-gaps") throw new WorkflowError("INVALID_DEFINITION");
    const providedEvidence = { ...state.provided, targetCompanies: state.targetCompanies,
      timeline: state.timeline, weeklyAvailableMinutes: state.weeklyAvailableMinutes, readiness: state.readiness };
    const execution = await this.executor.executeStructured({ agentId: "career", request: input.request,
      ...(context.conversationId ? { conversation: { id: context.conversationId } } : {}),
      ...(state.selectedProjectIds.length ? { projectIds: state.selectedProjectIds } : {}) }, headers, {
      schemaName: "career_preparation", schema: careerPreparationAnalysisSchema, maxOutputTokens: 7000,
      referenceData: JSON.stringify(providedEvidence),
      contextOverrides: { profile: true, career: true, course: false, assignments: false, exams: false, documents: false, learning: false, academicOverview: false, limits: { maxCharacters: 40000 } },
      buildDirective: (prepared) => {
        const preparedCareer = prepared.career;
        if (!preparedCareer || fingerprint(preparedCareer) !== state.sourceFingerprint) throw new WorkflowError("CAREER_DATA_CHANGED");
        const evidenceIds = [
          ...(preparedCareer.profile?.resumeText ? ["resume"] : []), ...(preparedCareer.profile?.experiences.map((item) => item.evidenceId) ?? []),
          ...preparedCareer.projects.map((item) => item.evidenceId), ...preparedCareer.skills.map((item) => item.evidenceId), ...preparedCareer.academicEvidence.map((item) => item.evidenceId),
          ...(state.provided.resumeData ? ["provided-resume"] : []), ...(state.provided.experienceSummary ? ["provided-experience"] : []),
          ...(state.provided.portfolioLinks ?? []).map((_, index) => `provided-portfolio:${index}`),
        ];
        return JSON.stringify({ targetRole: state.targetRole, targetIndustry: state.targetIndustry, targetCompanies: state.targetCompanies,
          timeline: state.timeline, weeklyAvailableMinutes: state.weeklyAvailableMinutes, readiness: state.readiness, evidenceIds,
          guidance: "Produce one integrated role-specific assessment and action set. Treat readiness as evidence readiness, not ability or hiring odds. Strengths must cite supplied evidenceIds. Gaps describe missing or uncertain evidence, never inability or verified employer requirements. Rank no more than four critical gaps and connect every gap to an actionId. Prioritize selected projects by relevance, depth, completeness and portfolio potential; improve existing projects before proposing rewrites. Resume bullets require exact source excerpts and no invented metrics. Portfolio advice covers project choice, explanation, demo/screenshots, repository/README, deployment and outcomes only where relevant. Use courses only as academic foundation, never as proof of project achievement or proficiency. Recommend learn/practice/build/demonstrate/review efficiently. Include interview preparation when generally appropriate for the role. Target companies are user interests; do not claim their current requirements. No live job data was verified. Make tasks concrete, estimate effort honestly, and fit priorities to the supplied timeline and weekly capacity." });
      },
    });
    if (!execution.structuredData || !validateCareerAnalysis(execution.structuredData, state.targetRole, career, state.provided, state.selectedProjectIds)) throw new WorkflowError("INVALID_RESPONSE");
    await validateCareerScope(context, headers);
    state.analysis = execution.structuredData; state.stage = "identify-gaps"; state.nextAction = execution.structuredData.actions.slice().sort((a, b) => ({ critical: 3, high: 2, medium: 1 }[b.priority] - { critical: 3, high: 2, medium: 1 }[a.priority]))[0].title;
    return { summary: `Career Agent identified ${state.analysis.criticalGaps.length} high-leverage evidence gaps for ${state.targetRole}.`, patch: { careerPreparation: state },
      data: { ...state.analysis, readiness: state.readiness, limitations: [...career.limitations, "General role guidance only; no live job or company requirements were verified."], nextAction: state.nextAction } };
  }
}
