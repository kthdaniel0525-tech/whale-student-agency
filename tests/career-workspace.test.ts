import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { CareerDataService } from "@/server/career/service";
import { CareerPlanService } from "@/server/career/plan-service";
import { getCareerWorkspace } from "@/server/career-workspace";
import { db } from "@/server/db/client";
import * as ai from "@/server/ai";
import type { CareerPreparationAnalysis } from "@/server/workflows/career-policy";

const NOW = new Date("2026-09-17T12:00:00.000Z");
type Actor = { id: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor;
let foreign: Actor;
const career = new CareerDataService();

async function actor(name: string): Promise<Actor> {
  const response = await auth().api.signUpEmail({ body: { name, email: `career-workspace-${randomUUID()}@example.test`, password: "Career-workspace-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const value = { id: body.user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ") }) };
  actors.push(value);
  await db().profile.create({ data: { userId: value.id, school: "Career University", program: "Computer Science", currentYear: 3, semester: "Fall 2026", academicGoal: "Prepare for internships", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return value;
}

async function reset(userId: string) {
  await db().recommendation.deleteMany({ where: { userId } });
  await db().workflowRun.deleteMany({ where: { userId } });
  await db().careerPlan.deleteMany({ where: { userId } });
  await db().skill.deleteMany({ where: { userId } });
  await db().project.deleteMany({ where: { userId } });
  await db().careerProfile.deleteMany({ where: { userId } });
}

async function evidence(user = owner) {
  const course = await db().course.create({ data: { userId: user.id, courseCode: `COMP-${randomUUID().slice(0, 5)}`, courseName: "Software Engineering", semester: "Fall 2026", description: "Testing, databases, APIs, and software design." } });
  await career.saveProfile({ careerGoal: "Prepare for software engineering internships", targetRoles: ["Software Engineering Intern"], targetIndustries: ["Education Technology"], experiences: ["Built a student club portal."], portfolioLinks: ["https://example.test/portfolio"], resumeText: "Built a student club portal using React, Node, and PostgreSQL." }, user.headers);
  const project = await career.saveProject({ courseId: course.id, name: "Student Club Portal", description: "Built a portal for club events and membership information.", technologies: ["React", "Node", "PostgreSQL"], role: "Developer", outcomes: ["Documented the event publishing workflow."], link: "https://example.test/portal", repositoryUrl: "https://example.test/repository" }, user.headers);
  const skill = await career.saveSkill({ name: "React", category: "Frameworks", proficiency: "Developing", evidence: ["Used for the portal interface."] }, user.headers);
  return { course, project, skill };
}

function analysis(projectId: string): CareerPreparationAnalysis {
  const original = "Built a student club portal using React, Node, and PostgreSQL.";
  return {
    targetRole: "Software Engineering Intern", marketScope: "general-role-guidance", summary: "Strengthen testing evidence and resume specificity.",
    strengths: [{ statement: "The portal demonstrates saved React and Node project work.", evidenceIds: [`project:${projectId}`] }],
    criticalGaps: [{ id: "testing", category: "technical", gap: "Automated testing evidence is missing", impact: "Testing evidence would make the project more complete.", evidenceStatus: "missing", actionId: "add-tests" }],
    secondaryGaps: [{ id: "interview", category: "interview", gap: "Interview practice evidence is limited", impact: "Practice can support clearer explanations.", evidenceStatus: "uncertain", actionId: "practice" }],
    projectPriorities: [{ projectId, priority: "high", strengths: ["React, Node, and PostgreSQL are documented."], improvements: ["Add unit and integration testing evidence."], reason: "It is the strongest saved full-stack project evidence." }],
    resume: { state: "needs-work", improvements: ["Clarify the technical contribution without adding metrics."], bullets: [{ evidenceId: "resume", original, improved: "Built a student club portal with React, Node, and PostgreSQL to support event and membership information.", rationale: "Adds purpose while preserving the saved technologies and contribution." }] },
    portfolio: { state: "needs-work", improvements: ["Document testing and setup steps in the repository."] },
    interviewPreparation: ["Practice explaining architecture tradeoffs."],
    actions: [
      { id: "add-tests", category: "project", title: "Add project tests", description: "Add tests for saved project behavior and document how to run them.", priority: "critical", estimatedMinutes: 180, projectId, evidenceIds: [`project:${projectId}`] },
      { id: "practice", category: "interview", title: "Practice project explanation", description: "Explain decisions using only saved project evidence.", priority: "high", estimatedMinutes: 60, projectId, evidenceIds: [`project:${projectId}`] },
    ],
  };
}

async function persistedAnalysis(projectId: string) {
  const value = analysis(projectId);
  return db().workflowRun.create({ data: {
    userId: owner.id, workflowId: "career-preparation", status: "COMPLETED", input: { goal: "Prepare for applications" },
    context: { careerPreparation: { analysis: value } }, completedAt: NOW,
  } });
}

beforeAll(async () => { owner = await actor("Career Workspace Owner"); foreign = await actor("Career Workspace Foreign"); });
beforeEach(async () => { vi.restoreAllMocks(); await reset(owner.id); await reset(foreign.id); });
afterAll(async () => { await db().user.deleteMany({ where: { id: { in: actors.map((item) => item.id) } } }); await db().$disconnect(); });

describe.sequential("Career Workspace", () => {
  it("shows a useful empty state without readiness claims or an AI call", async () => {
    const provider = vi.spyOn(ai, "getAIProvider");
    const result = await getCareerWorkspace(owner.id, owner.headers, { now: NOW });
    expect(result).toMatchObject({ isEmpty: true, readiness: [], projects: [], skillGroups: [], careerPlan: null });
    expect(result.gaps.map((gap) => gap.id)).toEqual(expect.arrayContaining(["target-role", "projects", "skills", "resume"]));
    expect(provider).not.toHaveBeenCalled();
  });

  it("builds target role, qualitative readiness, evidence-backed skills, projects, resume and portfolio", async () => {
    const fixture = await evidence();
    const result = await getCareerWorkspace(owner.id, owner.headers, { now: NOW });
    expect(result.profile).toMatchObject({ targetRole: "Software Engineering Intern", targetIndustry: "Education Technology" });
    expect(result.readiness).toHaveLength(6);
    expect(result.readiness.find((item) => item.id === "projectStrength")).toMatchObject({ level: expect.stringMatching(/weak|developing|good|strong/), evidence: expect.arrayContaining(["1 saved project"]) });
    expect(result.skillGroups[0]).toMatchObject({ category: "Frameworks", skills: [{ name: "React", proficiency: "Developing", projectEvidence: [{ id: fixture.project.id, name: "Student Club Portal" }], courseEvidence: expect.any(Array) }] });
    expect(result.projects[0]).toMatchObject({ id: fixture.project.id, status: "evidence-ready", description: expect.stringContaining("club events"), outcomes: ["Documented the event publishing workflow."], repositoryUrl: expect.any(String) });
    expect(result.resume.checks).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Resume details", met: true })]));
    expect(result.portfolio).toMatchObject({ status: "needs-work", links: ["https://example.test/portfolio"] });
    expect(JSON.stringify(result)).not.toMatch(/ATS|hiring probability: \d|\d+% ready/i);
  });

  it("reuses a current persisted Career Agent analysis for gaps, project priority and truthful bullet comparison", async () => {
    const fixture = await evidence();
    await persistedAnalysis(fixture.project.id);
    const result = await getCareerWorkspace(owner.id, owner.headers, { now: NOW });
    expect(result.analysis).toMatchObject({ source: "persisted-career-workflow", current: true });
    expect(result.gaps[0]).toMatchObject({ title: "Automated testing evidence is missing", priority: "critical" });
    expect(result.projects[0]).toMatchObject({ priority: "high", improvements: ["Add unit and integration testing evidence."] });
    expect(result.resume.bullets[0]).toMatchObject({ original: "Built a student club portal using React, Node, and PostgreSQL.", improved: expect.stringContaining("event and membership information") });
    expect(result.portfolio.improvements[0]).toContain("testing");
  });

  it("renders the active plan, current recommendation, and supports owned task status updates", async () => {
    const fixture = await evidence();
    const plan = await db().careerPlan.create({ data: { userId: owner.id, targetRole: "Software Engineering Intern", startDate: NOW, targetDate: new Date("2026-11-01T00:00:00Z"), weeklyAvailableMinutes: 180, totalPlannedMinutes: 120, summary: "Strengthen the portal and resume.", tasks: { create: { projectId: fixture.project.id, actionId: "add-tests", weekNumber: 1, category: "PROJECT", title: "Add integration tests", description: "Test the main portal flow.", priority: 100, durationMinutes: 120, targetDate: new Date("2026-09-24T00:00:00Z") } } }, include: { tasks: true } });
    await db().recommendation.create({ data: { userId: owner.id, type: "CAREER_PREPARATION", title: "Continue software engineering preparation", message: "Add integration tests next.", priority: "HIGH", priorityScore: 88, status: "ACTIVE", sourceType: "CAREER_PLAN", sourceId: plan.id, recommendedAgentId: "career", actionPayload: { careerPlanId: plan.id, careerTaskId: plan.tasks[0].id }, reasonCode: "career-plan-next-task", reasonData: {}, dedupeKey: `career:${plan.id}`, supersessionKey: `career:${plan.id}`, stateFingerprint: "current", activeKey: `${owner.id}:career:${plan.id}`, expiresAt: new Date("2026-11-01T00:00:00Z") } });
    const before = await getCareerWorkspace(owner.id, owner.headers, { now: NOW });
    expect(before.careerPlan).toMatchObject({ id: plan.id, tasks: [expect.objectContaining({ title: "Add integration tests", status: "planned", projectName: "Student Club Portal" })] });
    expect(before.nextAction).toMatchObject({ kind: "recommendation", title: "Continue software engineering preparation" });
    await new CareerPlanService().updateTaskStatus(plan.tasks[0].id, "completed", owner.headers);
    expect((await getCareerWorkspace(owner.id, owner.headers, { now: NOW })).careerPlan?.tasks[0].status).toBe("completed");
    await expect(new CareerPlanService().updateTaskStatus(plan.tasks[0].id, "skipped", foreign.headers)).rejects.toThrow("This item was not found.");
  });

  it("drops stale Agent gaps after project evidence changes and reads career-goal changes immediately", async () => {
    const fixture = await evidence();
    await persistedAnalysis(fixture.project.id);
    expect((await getCareerWorkspace(owner.id, owner.headers, { now: NOW })).analysis.current).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await career.saveProject({ courseId: fixture.course.id, name: fixture.project.name, description: fixture.project.description, technologies: [...fixture.project.technologies, "Vitest"], role: fixture.project.role, outcomes: [...fixture.project.outcomes, "Added automated test coverage."], link: fixture.project.link, repositoryUrl: fixture.project.repositoryUrl }, owner.headers, fixture.project.id);
    await career.saveProfile({ careerGoal: "Prepare for backend internships", targetRoles: ["Backend Engineering Intern"], targetIndustries: ["Developer Tools"], experiences: ["Built a student club portal."], portfolioLinks: ["https://example.test/portfolio"], resumeText: "Built a student club portal using React, Node, and PostgreSQL." }, owner.headers);
    const result = await getCareerWorkspace(owner.id, owner.headers, { now: NOW });
    expect(result.analysis).toMatchObject({ source: "current-data", current: false });
    expect(result.profile).toMatchObject({ targetRole: "Backend Engineering Intern", targetIndustry: "Developer Tools" });
    expect(result.gaps.some((gap) => gap.id === "testing")).toBe(false);
    expect(result.projects[0].technologies).toContain("Vitest");
  });

  it("enforces profile, project, skill, plan and workspace ownership", async () => {
    const fixture = await evidence();
    await expect(getCareerWorkspace(owner.id, foreign.headers, { now: NOW })).rejects.toThrow("Sign in to view your career workspace.");
    await expect(career.getProject(fixture.project.id, foreign.headers)).rejects.toThrow("This item was not found.");
    await expect(career.saveProject({ courseId: fixture.course.id, name: "Foreign edit", description: "Should fail", technologies: [], outcomes: [] }, foreign.headers, fixture.project.id)).rejects.toThrow("This item was not found.");
    await expect(career.saveProject({ courseId: fixture.course.id, name: "Foreign relation", description: "Should fail", technologies: [], outcomes: [] }, foreign.headers)).rejects.toThrow("This item was not found.");
  });
});
