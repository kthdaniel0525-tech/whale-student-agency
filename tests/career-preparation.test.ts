import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import { AIError } from "@/server/ai/errors";
import { createStudentAgentRegistry } from "@/server/agents/student-service";
import { CareerDataService, CareerPlanService } from "@/server/career";
import { WorkflowRegistry, WorkflowService, careerPreparation } from "@/server/workflows";
import { WorkflowError } from "@/server/workflows/errors";
import {
  calculateCareerReadiness,
  careerPreparationAnalysisSchema,
  resolveCareerTimeline,
  scheduleCareerActions,
  type CareerPreparationAnalysis,
} from "@/server/workflows/career-policy";

type Actor = { id: string; headers: Headers };
const actors: Actor[] = [];
const careerData = new CareerDataService();
let owner: Actor;
let other: Actor;

async function actor(name: string): Promise<Actor> {
  const response = await auth().api.signUpEmail({
    body: { name, email: `career-workflow-${randomUUID()}@example.test`, password: "Career-workflow-passphrase!" },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const result = { id: body.user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ") }) };
  actors.push(result);
  await db().profile.create({ data: {
    userId: result.id, school: "Career University", program: "Computer Science", currentYear: 3,
    semester: "Fall 2026", academicGoal: "Prepare for internships", studySessionMinutes: 45,
    explanationDifficulty: "INTERMEDIATE", timezone: "UTC",
  } });
  return result;
}

const projectDescription = "Built a student club portal using React, Node, and PostgreSQL.";
async function evidenceFixture(user = owner) {
  const course = await db().course.create({ data: {
    userId: user.id, courseCode: `COMP ${randomUUID().slice(0, 4)}`, courseName: "Data Structures",
    semester: "Fall 2026", description: "Algorithms, linked structures, trees, and complexity analysis.",
  } });
  await careerData.saveProfile({
    careerGoal: "Prepare for software engineering internships", targetRoles: ["Software Engineering Intern"],
    targetIndustries: ["Education Technology"], experiences: ["Practiced behavioral interview stories with a peer."],
    portfolioLinks: ["https://example.test/portfolio"], resumeText: projectDescription,
  }, user.headers);
  const project = await careerData.saveProject({
    courseId: course.id, name: "Student Club Portal", description: projectDescription,
    technologies: ["React", "Node", "PostgreSQL"], role: "Developer",
    outcomes: ["Documented the event publishing workflow."], repositoryUrl: "https://example.test/repository",
  }, user.headers);
  await careerData.saveSkill({ name: "React", category: "Frontend", proficiency: "Developing, self-reported", evidence: ["Used in Student Club Portal."] }, user.headers);
  return { course, project };
}

function analysis(projectId: string | null, targetRole = "Software Engineering Intern", source = projectId ? `project:${projectId}` : "provided-resume"): CareerPreparationAnalysis {
  return {
    targetRole, marketScope: "general-role-guidance",
    summary: "Use the supplied project as the main portfolio example, strengthen its tests, and improve the resume evidence before applications.",
    strengths: [{ statement: projectId ? "The supplied portal demonstrates React and Node project work." : "The supplied resume describes a TypeScript API project.", evidenceIds: [source] }],
    criticalGaps: [
      { id: "gap-resume", category: "resume", gap: "The resume needs clearer technical contribution details.", impact: "Clear evidence helps reviewers understand the work.", evidenceStatus: "uncertain", actionId: "resume-rewrite" },
      ...(projectId ? [{ id: "gap-testing", category: "technical" as const, gap: "Automated testing evidence is missing.", impact: "Tests can demonstrate engineering completeness.", evidenceStatus: "missing" as const, actionId: "add-tests" }] : []),
    ],
    secondaryGaps: [{ id: "gap-interview", category: "interview", gap: "Continued interview practice would strengthen preparation.", impact: "Practice supports clearer technical explanations.", evidenceStatus: "uncertain", actionId: "interview-practice" }],
    projectPriorities: projectId ? [{ projectId, priority: "high", strengths: ["Uses React, Node, and PostgreSQL."], improvements: ["Add backend tests and deployment documentation."], reason: "It is the strongest supplied full-stack evidence for the target role." }] : [],
    resume: { state: "needs-work", improvements: ["Describe the technical contribution and leave unknown outcomes unquantified."], bullets: [{ evidenceId: source, original: projectId ? projectDescription : "Built a course API using TypeScript.", improved: projectId ? "Built a student club portal using React, Node, and PostgreSQL." : "Built a course API using TypeScript.", rationale: "Uses only the supplied technology and contribution evidence." }] },
    portfolio: { state: projectId ? "needs-work" : "missing", improvements: projectId ? ["Add setup steps, screenshots, a demo, and testing notes to the repository."] : ["Add a project with a repository and concise technical explanation."] },
    interviewPreparation: ["Practice explaining project decisions and data structure tradeoffs."],
    actions: [
      { id: "resume-rewrite", category: "resume", title: "Rewrite the strongest project resume entry", description: "Clarify the contribution, technologies, and known outcome without invented metrics.", priority: "critical", estimatedMinutes: 60, projectId, evidenceIds: [source] },
      ...(projectId ? [{ id: "add-tests", category: "project" as const, title: "Add backend tests to the selected project", description: "Cover the main event creation and validation paths and document how to run the tests.", priority: "critical" as const, estimatedMinutes: 180, projectId, evidenceIds: [source] }] : []),
      { id: "interview-practice", category: "interview", title: "Practice the project explanation", description: "Explain architecture choices and tradeoffs using only actual project evidence.", priority: "high", estimatedMinutes: 90, projectId, evidenceIds: [source] },
    ],
  };
}

function boundary(output: unknown, failure?: "PROVIDER_FAILURE") {
  const requests: AIStructuredRequest<unknown>[] = [];
  const provider: AIProvider = {
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      requests.push(request as AIStructuredRequest<unknown>);
      if (failure) throw new AIError(failure);
      return { id: "career-preparation-fixture", model: "fixture", text: JSON.stringify(output), data: output as T };
    },
    generateText() { throw new Error("Career preparation uses structured output."); },
    streamText() { throw new Error("Streaming is not used."); },
    generateEmbedding() { throw new Error("Embeddings are not used."); },
  };
  return { requests, provider, service: new WorkflowService({ getProvider: () => provider }) };
}

beforeAll(async () => { owner = await actor("Career Owner"); other = await actor("Career Other"); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const item of actors) await db().user.deleteMany({ where: { id: item.id } });
  await db().$disconnect();
});

describe.sequential("Career Preparation workflow", () => {
  it("registers a bounded workflow that reuses Career Agent once", () => {
    const registry = new WorkflowRegistry(createStudentAgentRegistry());
    registry.register(careerPreparation);
    expect(registry.get("career-preparation")).toMatchObject({ maxSteps: 3, maxAgentCalls: 1, maxRetries: 0 });
    expect(registry.get("career-preparation").steps.map((step) => [step.id, step.agentId])).toEqual([
      ["assess-current-state", "deterministic"], ["identify-gaps", "career"], ["create-plan", "deterministic"],
    ]);
    expect(() => registry.register(careerPreparation)).toThrow(WorkflowError);
  });

  it("requires an unresolved target role but reuses one saved role and industry", async () => {
    const emptyAI = boundary({});
    await expect(emptyAI.service.runWorkflow({ workflowId: "career-preparation", goal: "Make a career plan." }, other.headers)).rejects.toMatchObject({ code: "TARGET_ROLE_REQUIRED" });
    const fixture = await evidenceFixture();
    const ai = boundary(analysis(fixture.project.id));
    const result = await ai.service.runWorkflow({ workflowId: "career-preparation", goal: "Make a career preparation plan.", projectIds: [fixture.project.id], applicationTimeline: "in 2 weeks", availableWeeklyMinutes: 120 }, owner.headers);
    expect(result).toMatchObject({ status: "completed", careerPreparation: { targetRole: "Software Engineering Intern", planId: expect.any(String) } });
    const state = (await db().workflowRun.findUniqueOrThrow({ where: { id: result.runId } })).context as Record<string, unknown>;
    expect(state).toMatchObject({ careerPreparation: { targetRole: "Software Engineering Intern", targetIndustry: "Education Technology" } });
  });

  it("creates one grounded gap analysis, project/resume/portfolio advice, and an owned plan", async () => {
    const fixture = await evidenceFixture();
    const output = analysis(fixture.project.id, "AI Engineer");
    const ai = boundary(output);
    const studyPlansBefore = await db().studyPlan.count({ where: { userId: owner.id } });
    const result = await ai.service.runWorkflow({
      workflowId: "career-preparation", goal: "Strengthen my resume and portfolio for AI engineering.", targetRole: "AI Engineer",
      targetCompanies: ["Example Company"], projectIds: [fixture.project.id], applicationTimeline: "in 2 weeks", availableWeeklyHours: 2,
    }, owner.headers);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed", errorCode: null,
      careerPreparation: { targetRole: "AI Engineer", stage: "create-plan", nextAction: "Rewrite the strongest project resume entry", criticalGaps: [{ id: "gap-resume" }, { id: "gap-testing" }] },
    });
    expect(ai.requests).toHaveLength(1);
    expect(ai.requests[0]).toMatchObject({ schemaName: "career_preparation", maxOutputTokens: 7000 });
    const prompt = ai.requests[0].messages.map((message) => message.content).join("\n");
    for (const value of ["AI Engineer", "Student Club Portal", "React", "Data Structures", "general guidance", "Example Company"]) expect(prompt).toContain(value);
    expect(prompt).not.toContain("FOREIGN");
    const gap = result.outputs["career-gap-analysis"] as CareerPreparationAnalysis;
    expect(gap.projectPriorities[0]).toMatchObject({ projectId: fixture.project.id, priority: "high" });
    expect(gap.resume.bullets[0].original).toBe(projectDescription);
    expect(gap.portfolio.improvements[0]).toContain("screenshots");
    const planId = result.careerPreparation!.planId!;
    const plan = await new CareerPlanService().getPlan(planId, owner.headers);
    expect(plan).toMatchObject({ userId: owner.id, targetRole: "AI Engineer", weeklyAvailableMinutes: 120, totalPlannedMinutes: 240 });
    expect(plan.tasks.every((task) => task.userId === owner.id && (!task.project || task.project.userId === owner.id))).toBe(true);
    const weeklyTotals = plan.tasks.reduce((totals, task) => totals.set(task.weekNumber, (totals.get(task.weekNumber) ?? 0) + task.durationMinutes), new Map<number, number>());
    expect([...weeklyTotals.values()].every((minutes) => minutes <= 120)).toBe(true);
    expect(await db().studyPlan.count({ where: { userId: owner.id } })).toBe(studyPlansBefore);
  });

  it("builds evidence-based readiness without converting missing proof into fake precision", async () => {
    const fixture = await evidenceFixture();
    const context = await import("@/server/context/builder").then(({ buildUserContext }) => buildUserContext({ request: "Prepare for software engineering internships", projectIds: [fixture.project.id], options: { career: true } }, owner.headers));
    const readiness = calculateCareerReadiness(context.career!, {});
    expect(readiness.technicalFoundation.level).toBe("good");
    expect(readiness.technicalFoundation.reason).toContain("supplied skill or project technology signals");
    expect(readiness.applicationReadiness.reason).toContain("not hiring probability");
    expect(JSON.stringify(readiness)).not.toMatch(/\d+\.\d+%/);
  });

  it("changes deterministic priorities with the timeline and never exceeds weekly time", () => {
    const output = analysis("project-one");
    const short = resolveCareerTimeline("in 2 weeks", new Date("2026-09-14T00:00:00Z"))!;
    const long = resolveCareerTimeline("in 4 months", new Date("2026-09-14T00:00:00Z"))!;
    const shortPlan = scheduleCareerActions(output, short, 120);
    const longPlan = scheduleCareerActions(output, long, 120);
    expect(shortPlan.tasks[0]).toMatchObject({ actionId: "resume-rewrite", weekNumber: 1 });
    expect(longPlan.tasks[0]).toMatchObject({ actionId: "add-tests", weekNumber: 1 });
    for (const plan of [shortPlan, longPlan]) for (const week of plan.weeklyTotals) expect(week.plannedMinutes).toBeLessThanOrEqual(week.availableMinutes);
    expect(shortPlan.totalPlannedMinutes).toBe(240);
    expect(shortPlan.deferredActions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "interview-practice" })]));
  });

  it("pauses for missing resume evidence and resumes through the shared checkpoint", async () => {
    const fresh = await actor("Career Resume Student");
    const ai = boundary(analysis(null));
    const waiting = await ai.service.runWorkflow({ workflowId: "career-preparation", goal: "Improve my resume before applications.", targetRole: "Software Engineering Intern", applicationTimeline: "in 4 weeks", availableWeeklyMinutes: 90 }, fresh.headers);
    expect(waiting).toMatchObject({ status: "waiting-for-input", waitingFor: { kind: "career-data" }, careerPreparation: { stage: "waiting-for-data", planId: null } });
    expect(waiting.careerPreparation!.missingInputs).toEqual(expect.arrayContaining(["resume text"]));
    expect(ai.requests).toHaveLength(0);
    const resumed = await ai.service.resumeWorkflow({ runId: waiting.runId, careerData: { resumeData: "Built a course API using TypeScript." } }, fresh.headers);
    expect(resumed).toMatchObject({ status: "completed", careerPreparation: { stage: "create-plan", planId: expect.any(String), nextAction: "Rewrite the strongest project resume entry" } });
    expect(ai.requests).toHaveLength(1);
    expect((resumed.outputs["career-gap-analysis"] as CareerPreparationAnalysis).resume.bullets[0]).toMatchObject({ evidenceId: "provided-resume", original: "Built a course API using TypeScript." });
  });

  it("rejects stale evidence before resume and leaves the checkpoint retry-safe", async () => {
    const fresh = await actor("Career Stale Student");
    const ai = boundary(analysis(null));
    const waiting = await ai.service.runWorkflow({ workflowId: "career-preparation", goal: "Improve my resume.", targetRole: "Software Engineering Intern" }, fresh.headers);
    await careerData.saveSkill({ name: "TypeScript", evidence: ["Built a typed API."] }, fresh.headers);
    await expect(ai.service.resumeWorkflow({ runId: waiting.runId, careerData: { resumeData: "Built a course API using TypeScript." } }, fresh.headers)).rejects.toMatchObject({ code: "CAREER_DATA_CHANGED" });
    expect((await ai.service.getRun(waiting.runId, fresh.headers)).status).toBe("waiting-for-input");
    expect(ai.requests).toHaveLength(0);
  });

  it("enforces project, plan, and workflow ownership", async () => {
    const foreignFixture = await evidenceFixture(other);
    const ai = boundary(analysis(foreignFixture.project.id));
    await expect(ai.service.runWorkflow({ workflowId: "career-preparation", goal: "Prepare my profile.", targetRole: "Software Engineer", projectIds: [foreignFixture.project.id] }, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
    const ownAI = boundary(analysis(foreignFixture.project.id, "Software Engineer"));
    const completed = await ownAI.service.runWorkflow({ workflowId: "career-preparation", goal: "Prepare my profile.", targetRole: "Software Engineer", projectIds: [foreignFixture.project.id], availableWeeklyMinutes: 120 }, other.headers);
    await expect(new CareerPlanService().getPlan(completed.careerPreparation!.planId!, owner.headers)).rejects.toThrow("This item was not found.");
    await expect(ownAI.service.getRun(completed.runId, owner.headers)).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it("fails cleanly once when Career Agent fails", async () => {
    const fixture = await evidenceFixture();
    const ai = boundary(analysis(fixture.project.id), "PROVIDER_FAILURE");
    const result = await ai.service.runWorkflow({ workflowId: "career-preparation", goal: "Prepare my applications.", targetRole: "Software Engineering Intern", projectIds: [fixture.project.id] }, owner.headers);
    expect(result).toMatchObject({ status: "failed", errorCode: "PROVIDER_FAILURE", careerPreparation: { planId: null } });
    expect(result.steps.find((step) => step.stepId === "identify-gaps")).toMatchObject({ status: "failed", attempts: 1 });
    expect(ai.requests).toHaveLength(1);
  });

  it("rejects invalid structured output and unsupported fabricated metrics", async () => {
    const fixture = await evidenceFixture();
    const invalid = boundary({ targetRole: "Software Engineering Intern", summary: "Incomplete" });
    expect((await invalid.service.runWorkflow({ workflowId: "career-preparation", goal: "Prepare applications.", targetRole: "Software Engineering Intern", projectIds: [fixture.project.id] }, owner.headers))).toMatchObject({ status: "failed", errorCode: "INVALID_RESPONSE" });
    const fabricated = analysis(fixture.project.id);
    fabricated.summary = "The project already serves 50000 users.";
    const grounded = boundary(fabricated);
    expect((await grounded.service.runWorkflow({ workflowId: "career-preparation", goal: "Prepare applications carefully.", targetRole: "Software Engineering Intern", projectIds: [fixture.project.id] }, owner.headers))).toMatchObject({ status: "failed", errorCode: "INVALID_RESPONSE" });
    expect(careerPreparationAnalysisSchema.safeParse({ summary: "Incomplete" }).success).toBe(false);
  });
});
