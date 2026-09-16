import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { auth } from "@/server/auth/config";
import { CareerDataService } from "@/server/career";
import { NotFoundError } from "@/server/services/academic";
import { createStudentAgentRegistry, createStudentAgentService } from "@/server/agents/student-service";
import { AgentRouter } from "@/server/agents/router";
import { AgentExecutor } from "@/server/agents/executor";
import { getCareerAgentDefinition } from "@/server/agents/career/definition";
import type { CareerAnalysis, CareerResponse } from "@/server/agents/career/schemas";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import type { AgentRequestInput, AgentRequestResult } from "@/server/agents/core/types";
import * as contextBuilder from "@/server/context/builder";
import * as categories from "@/server/context/categories";
import * as retrieval from "@/server/documents/retrieval";
import { embeddingProvider } from "@/server/documents/embeddings";

type Actor = { id: string; headers: Headers };
const actors: Actor[] = [];
const dataService = new CareerDataService();
let owner: Actor, foreign: Actor, beginner: Actor;
let courseId: string, foreignCourse: string, projectId: string, courseProjectId: string, foreignProject: string, foreignSkill: string;
let documentId: string, emptyDocumentId: string;
const documentExperience = "Developed a student museum exhibit with accessibility guidance and visitor information.";
const experience = "I built a club website using React.";
async function actor(program = "Computer Science"): Promise<Actor> {
  const response = await auth().api.signUpEmail({ body: { name: "Career Student", email: `career-${randomUUID()}@example.test`, password: "Career-fixture-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200);
  const user = await response.json() as { user: { id: string } };
  const result = { id: user.user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") }) };
  actors.push(result);
  await db().profile.create({ data: { userId: result.id, school: "Career University", program, currentYear: 2, semester: "Fall 2026", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return result;
}
function analysis(overrides: Partial<CareerAnalysis> = {}): CareerAnalysis {
  return {
    targetRole: "Software Engineering Intern",
    summary: "Your club website provides concrete frontend experience. Strengthen its testing and explain your contribution before applications.",
    strengths: ["Built a club website using React."],
    gaps: ["Automated testing and backend work are not demonstrated by the supplied project evidence."],
    recommendedProjects: [{ projectId, recommendation: "Add a documented event API with authentication and PostgreSQL to the club site, then deploy it with setup instructions." }],
    recommendedSkills: ["Practice API testing by covering the event creation and validation paths."],
    nextActions: ["Add a deployment link and README setup steps to the club website.", "Describe your personal contribution and gather actual usage evidence."],
    resumeBullets: [{ evidenceId: `project:${projectId}`, original: experience, improved: "Built a React website for a student club.", rationale: "Uses an action verb and the supplied technology without assuming impact." }],
    ...overrides,
  };
}
function boundary(output: unknown = analysis()) {
  const calls: AIStructuredRequest<unknown>[] = [];
  const provider: AIProvider = {
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      expect(request.schemaName).toBe("career_analysis");
      calls.push(request as AIStructuredRequest<unknown>);
      return { id: "career-response", model: "career-fixture", text: JSON.stringify(output), data: output as T };
    },
    generateText() { throw new Error("Structured career execution required."); },
    streamText() { throw new Error("No streaming needed."); },
    generateEmbedding() { throw new Error("No documents needed."); },
  };
  const getProvider = vi.fn(() => provider);
  return { calls, getProvider, service: createStudentAgentService({ executor: { getProvider }, router: { getProvider } }) };
}
function unwrap(result: AgentRequestResult): CareerResponse {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, agent: { id: "career" } });
  if (!result.ok) throw new Error(result.error.message);
  return result.response.structuredData as CareerResponse;
}

beforeAll(async () => {
  owner = await actor(); foreign = await actor(); beginner = await actor("Art History");
  courseId = (await db().course.create({ data: { userId: owner.id, courseCode: "COMP 2140", courseName: "Data Structures", semester: "Fall 2026" } })).id;
  foreignCourse = (await db().course.create({ data: { userId: foreign.id, courseCode: "SECRET COURSE", courseName: "Foreign", semester: "Fall 2026" } })).id;
  await dataService.saveProfile({ careerGoal: "Prepare for a software internship", targetRoles: ["Software Engineering Intern"], targetIndustries: ["Education"], experiences: [experience], portfolioLinks: ["https://example.test/portfolio"], resumeText: "Built a club website using React." }, owner.headers);
  projectId = (await dataService.saveProject({ name: "Club Website", description: experience, technologies: ["React"], role: "Frontend developer", outcomes: ["Serves 120 members."], link: "https://example.test/club" }, owner.headers)).id;
  courseProjectId = (await dataService.saveProject({ name: "Course Queue Simulator", description: "Implemented a queue simulator and compared linked-list and array storage.", technologies: ["Java"], courseId, outcomes: ["Documented algorithm complexity in a course report."] }, owner.headers)).id;
  await dataService.saveSkill({ name: "React", category: "Frontend", proficiency: "Beginner, self-reported", evidence: ["Built the Club Website interface."] }, owner.headers);
  await dataService.saveProfile({ careerGoal: "FOREIGN GOAL", targetRoles: ["FOREIGN ROLE"], resumeText: "FOREIGN PRIVATE RESUME" }, foreign.headers);
  foreignProject = (await dataService.saveProject({ name: "FOREIGN PROJECT", description: "FOREIGN PROJECT CONTENT" }, foreign.headers)).id;
  foreignSkill = (await dataService.saveSkill({ name: "FOREIGN SKILL", evidence: ["FOREIGN EVIDENCE"] }, foreign.headers)).id;
  await db().assignment.create({ data: { userId: owner.id, courseId, title: "UNRELATED DEADLINE", dueDate: new Date() } });
  await db().exam.create({ data: { userId: owner.id, courseId, title: "UNRELATED EXAM", examDate: new Date(), topics: [] } });
  await db().learningTopic.create({ data: {
    userId: owner.id, courseId, name: "Recursion", normalizedName: "recursion",
    progress: { create: {
      masteryScore: 30, confidenceScore: 85, recentAccuracy: 30,
      questionsAttempted: 10, correctAnswers: 3, incorrectAnswers: 7,
      mediumAttempts: 10, scoreTotal: 3, difficultyWeightedScore: 3, difficultyWeightTotal: 10,
      practiceSessions: 3, firstPracticedAt: new Date(Date.now() - 10 * 86400000), lastPracticedAt: new Date(), trend: "DECLINING",
    } },
  } });
  for (const empty of [false, true]) {
    const document = await db().document.create({ data: { userId: owner.id, title: empty ? "Empty resume" : "Exhibit experience", originalFileName: "experience.txt", fileType: "TXT", fileSize: documentExperience.length, storageKey: randomUUID(), processingStatus: "READY", embeddingModel: embeddingProvider.id } });
    if (empty) { emptyDocumentId = document.id; continue; }
    documentId = document.id;
    const vector = JSON.stringify(await embeddingProvider.generateEmbedding(documentExperience));
    await db().$executeRaw`INSERT INTO "DocumentChunk" (id,"documentId","userId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata) VALUES (${randomUUID()},${document.id},${owner.id},0,${documentExperience},1,1,30,${vector}::vector,${embeddingProvider.id},'{}'::jsonb)`;
  }
}, 30000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const item of actors) {
    await db().user.deleteMany({ where: { id: item.id } });
    // Fixtures create metadata/chunks only, without files on disk.
    await db().fileDeletion.deleteMany({ where: { userId: item.id } });
  }
  await db().$disconnect();
});

describe.sequential("Career Agent through real authentication, persistence, context and Executor", () => {
  it("registers career capabilities with focused context", () => {
    const agent = createStudentAgentRegistry().get("career");
    expect(agent).toEqual(getCareerAgentDefinition());
    expect(agent.capabilities).toEqual(expect.arrayContaining(["resume-bullet-generation", "portfolio-guidance", "skill-gap-analysis"]));
    expect(agent.contextRequirements).toMatchObject({ profile: true, career: true, assignments: false, exams: false, documents: false, learning: false });
  });
  it.each([
    "Help improve my resume.", "Help with my resume", "Turn this project into a resume bullet.",
    "What projects should I build?", "What project should I build?", "What skills am I missing for a software internship?",
    "Help me prepare for internship applications.", "How do I get an internship?", "How should I describe this course project?",
    "Improve my portfolio.", "What should I focus on for my career?", "Create bullet points from my experience.",
    "How can I make my profile stronger?", "What skills am I missing?",
  ])("routes %s without an AI routing call", async (request) => {
    const getProvider = vi.fn(() => { throw new Error("No AI routing expected."); });
    const router = new AgentRouter(createStudentAgentRegistry(), { getProvider });
    expect(await router.routeAgent({ request })).toMatchObject({ agentId: "career", method: "rule" });
    expect(getProvider).not.toHaveBeenCalled();
  });
  it("creates bullets in one shared execution with real career references", async () => {
    const ai = boundary();
    const execute = vi.spyOn(AgentExecutor.prototype, "executeStructured");
    const build = vi.spyOn(contextBuilder, "buildUserContext");
    const result = unwrap(await ai.service.handleAgentRequest({ request: "Turn my club project into a resume bullet." }, owner.headers));
    expect(result.resumeBullets[0]).toMatchObject({ original: experience, improved: "Built a React website for a student club." });
    expect(ai.calls).toHaveLength(1); expect(execute).toHaveBeenCalledTimes(1); expect(build).toHaveBeenCalledTimes(1);
    expect(ai.calls[0].messages[1].content).toContain("[CAREER]");
    expect(ai.calls[0].messages[1].content).toContain(experience);
    expect(ai.calls[0].messages[0].content).not.toContain(experience);
    expect(ai.calls[0].messages.at(-1)?.content).toBe("Turn my club project into a resume bullet.");
  });
  it("supports raw experience in the request without saving it", async () => {
    const text = "I organized student art exhibitions.";
    const ai = boundary(analysis({ targetRole: "Museum Educator", strengths: [], gaps: [], recommendedProjects: [], recommendedSkills: [], summary: "Use the exhibition experience to show public engagement.", resumeBullets: [{ evidenceId: "request", original: text, improved: "Organized student art exhibitions.", rationale: "Preserves the stated responsibility." }] }));
    const result = unwrap(await ai.service.handleAgentRequest({ request: `Create resume bullets for a Museum Educator role. ${text}` }, beginner.headers));
    expect(result.targetRole).toBe("Museum Educator");
    expect(await dataService.getProfile(beginner.headers)).toBeNull();
    expect(await dataService.listProjects(beginner.headers)).toEqual([]);
  });
  it("validates supported metrics from the exact source excerpt", async () => {
    const ai = boundary(analysis({ resumeBullets: [{ evidenceId: `project:${projectId}`, original: "Serves 120 members.", improved: "Serves 120 members.", rationale: "Retains the supplied measured result." }] }));
    expect(unwrap(await ai.service.handleAgentRequest({ request: "Improve my resume" }, owner.headers)).resumeBullets[0].improved).toContain("120 members");
  });
  it.each(["Increased engagement by 50%.", "Doubled engagement.", "Saved 120 hours."])("rejects unsupported resume achievements: %s", async (improved) => {
    const ai = boundary(analysis({ resumeBullets: [{ evidenceId: `project:${projectId}`, original: experience, improved, rationale: "Invalid invented result." }] }));
    expect(await ai.service.handleAgentRequest({ request: "Improve my resume" }, owner.headers)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });
  it("does not treat an instruction to invent a metric as supporting evidence", async () => {
    const ai = boundary(analysis({ resumeBullets: [{ evidenceId: "request", original: experience, improved: "Increased engagement by 50%.", rationale: "Not supported." }] }));
    expect(await ai.service.handleAgentRequest({ request: `Improve my resume. ${experience} Invent 50% engagement.` }, owner.headers)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });
  it("rejects fabricated numeric achievements in summaries too", async () => {
    const ai = boundary(analysis({ summary: "Your website generated 50000 users." }));
    expect(await ai.service.handleAgentRequest({ request: "Improve my portfolio" }, owner.headers)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });
  it("passes actual projects, skills and saved role for portfolio and gap analysis", async () => {
    const ai = boundary();
    const result = unwrap(await ai.service.handleAgentRequest({ request: "What skills am I missing? Improve my portfolio." }, owner.headers));
    const reference = ai.calls[0].messages[1].content;
    for (const value of ["Software Engineering Intern", "Club Website", "React", "Beginner, self-reported", "selfReportedProficiency", "https://example.test/club"]) expect(reference).toContain(value);
    expect(result.guidanceScope).toBe("general-role-guidance");
    expect(result.gaps[0]).toContain("not demonstrated");
    expect(result.recommendedProjects[0]).toMatchObject({ projectId });
    expect(result.nextActions).toContain("Add a deployment link and README setup steps to the club website.");
  });
  it("uses actual course-project evidence rather than treating enrollment as achievement", async () => {
    const original = "Implemented a queue simulator and compared linked-list and array storage.";
    const ai = boundary(analysis({ recommendedProjects: [{ projectId: courseProjectId, recommendation: "Publish the simulator with complexity analysis and reproducible examples." }], resumeBullets: [{ evidenceId: `project:${courseProjectId}`, original, improved: "Implemented a queue simulator comparing linked-list and array storage.", rationale: "Uses actual course-project implementation evidence." }] }));
    const result = unwrap(await ai.service.handleAgentRequest({ request: "How should I describe this course project?", courseId }, owner.headers));
    expect(result.resumeBullets[0].original).toBe(original);
    const reference = ai.calls[0].messages[1].content;
    expect(reference).toContain("Data Structures"); expect(reference).toContain(original);
    expect(reference).not.toContain(`project:${projectId}`);
    expect(ai.calls[0].messages[0].content).toContain("Course enrollment alone proves no project accomplishment");
  });
  it("supports missing career data without assuming a role or fabricating experience", async () => {
    const ai = boundary({ targetRole: null, summary: "Share your experience and target role so the advice can be personalized.", strengths: [], gaps: [], recommendedProjects: [], recommendedSkills: [], nextActions: ["Choose a target role and describe a project or relevant experience."], resumeBullets: [] });
    const result = unwrap(await ai.service.handleAgentRequest({ request: "Help with my resume" }, beginner.headers));
    expect(result.targetRole).toBeNull(); expect(result.resumeBullets).toEqual([]);
    expect(ai.calls[0].messages[1].content).toContain("Art History");
  });
  it("respects an explicit different target role without modifying saved goals", async () => {
    const ai = boundary(analysis({ targetRole: "Frontend Developer" }));
    expect(unwrap(await ai.service.handleAgentRequest({ request: "Improve my resume for a Frontend Developer role" }, owner.headers)).targetRole).toBe("Frontend Developer");
    expect((await dataService.getProfile(owner.headers))!.targetRoles).toEqual(["Software Engineering Intern"]);
  });
  it("omits deadline, learning and document loaders by default", async () => {
    const assignments = vi.spyOn(categories, "assignmentContext"), exams = vi.spyOn(categories, "examContext"), learning = vi.spyOn(categories, "learningContext"), docs = vi.spyOn(retrieval, "retrieveAcademicContext");
    const ai = boundary();
    unwrap(await ai.service.handleAgentRequest({ request: "Improve my portfolio" }, owner.headers));
    for (const spy of [assignments, exams, learning, docs]) expect(spy).not.toHaveBeenCalled();
    expect(ai.calls[0].messages[1].content).not.toMatch(/UNRELATED|ASSIGNMENTS|UPCOMING EXAMS|RELEVANT COURSE MATERIAL/);
  });
  it("allows requested learning guidance through Context Builder without duplicating learning queries", async () => {
    const learning = vi.spyOn(categories, "learningContext");
    const ai = boundary();
    unwrap(await ai.service.handleAgentRequest({ request: "Use my weak topics to suggest career preparation." }, owner.headers));
    expect(learning).toHaveBeenCalledTimes(1);
    expect(ai.calls[0].messages[1].content).toContain("Recursion");
    expect(ai.calls[0].messages[1].content).toContain('"confidence":85');
    expect(ai.calls[0].messages[0].content).toContain("constructive practice without raw scores");
  });
  it("does not load career data for unrelated context requests", async () => {
    const projects = vi.spyOn(db().project, "findMany");
    await contextBuilder.buildUserContext({ request: "Profile", options: { profile: true } }, owner.headers);
    expect(projects).not.toHaveBeenCalled();
  });
  it("uses explicitly selected document passages through existing RAG and keeps citations", async () => {
    const ai = boundary(analysis({ resumeBullets: [{ evidenceId: `document:${documentId}:0`, original: documentExperience, improved: "Developed a student museum exhibit with accessibility guidance and visitor information.", rationale: "Keeps the documented contribution without inventing an outcome." }] }));
    const result = await ai.service.handleAgentRequest({ request: "Write a resume bullet for my student museum exhibit with accessibility guidance and visitor information.", documentIds: [documentId] }, owner.headers);
    expect(unwrap(result).resumeBullets[0].original).toBe(documentExperience);
    if (!result.ok) throw new Error("Expected career response");
    expect(result.response.sources).toContainEqual(expect.objectContaining({ documentId, pageNumber: 1 }));
    expect(ai.calls[0].messages[1].content).toContain("RELEVANT COURSE MATERIAL");
  });
  it("does not invent selected document contents when RAG has no passages", async () => {
    const ai = boundary();
    expect(await ai.service.handleAgentRequest({ request: "Improve my resume", documentIds: [emptyDocumentId] }, owner.headers)).toMatchObject({ ok: false, error: { code: "SOURCE_CONTEXT_UNAVAILABLE" } });
    expect(ai.calls).toHaveLength(0);
  });
  it("rejects cross-user document selection before retrieval or generation", async () => {
    const ai = boundary();
    expect(await ai.service.handleAgentRequest({ request: "Improve my resume", documentIds: [documentId] }, foreign.headers)).toMatchObject({ ok: false, error: { code: "CONTEXT_FAILURE" } });
    expect(ai.calls).toHaveLength(0);
  });
  it.each(["unknown-source", "foreign-project"])("rejects fabricated or foreign evidence references: %s", async (source) => {
    const ai = boundary(analysis({ resumeBullets: [{ evidenceId: source === "foreign-project" ? `project:${foreignProject}` : source, original: "FOREIGN PROJECT CONTENT", improved: "Built a project.", rationale: "Invalid reference." }] }));
    expect(await ai.service.handleAgentRequest({ request: "Improve my resume" }, owner.headers)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });
  it("rejects fabricated original excerpts even under a real evidence ID", async () => {
    const ai = boundary(analysis({ resumeBullets: [{ evidenceId: `project:${projectId}`, original: "Led a global team.", improved: "Led a global team.", rationale: "Invented experience." }] }));
    expect(await ai.service.handleAgentRequest({ request: "Improve my resume" }, owner.headers)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });
  it("rejects foreign project recommendations, invented roles and malformed structured output", async () => {
    for (const output of [analysis({ recommendedProjects: [{ projectId: foreignProject, recommendation: "Improve it." }] }), analysis({ targetRole: "Invented Role" }), { ...analysis(), unrecognized: true }, analysis({ nextActions: [] })]) {
      const ai = boundary(output);
      expect(await ai.service.handleAgentRequest({ request: "Improve my portfolio" }, owner.headers)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    }
  });
  it("blocks unauthenticated access, frontend userId injection and foreign course scope before AI", async () => {
    const ai = boundary();
    expect(await ai.service.handleAgentRequest({ request: "Career advice" }, new Headers())).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(await ai.service.handleAgentRequest({ request: "Career advice", userId: foreign.id } as AgentRequestInput, owner.headers)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(await ai.service.handleAgentRequest({ request: "Career advice", courseId: foreignCourse }, owner.headers)).toMatchObject({ ok: false, error: { code: "CONTEXT_FAILURE" } });
    expect(ai.calls).toHaveLength(0);
  });
  it("excludes foreign profile, resume, projects and skills from AI context", async () => {
    const ai = boundary();
    unwrap(await ai.service.handleAgentRequest({ request: "Improve my resume and portfolio" }, owner.headers));
    expect(JSON.stringify(ai.calls[0].messages)).not.toContain("FOREIGN");
    expect(await dataService.getProject(foreignProject, foreign.headers)).toMatchObject({ id: foreignProject });
    await expect(dataService.getProject(foreignProject, owner.headers)).rejects.toBeInstanceOf(NotFoundError);
  });
  it("protects project and skill writes and course relationships", async () => {
    await expect(dataService.saveProject({ name: "Hijacked", description: "Denied" }, owner.headers, foreignProject)).rejects.toBeInstanceOf(NotFoundError);
    await expect(dataService.deleteProject(foreignProject, owner.headers)).rejects.toBeInstanceOf(NotFoundError);
    await expect(dataService.saveProject({ name: "Foreign course", description: "Denied", courseId: foreignCourse }, owner.headers)).rejects.toBeInstanceOf(NotFoundError);
    await expect(dataService.saveSkill({ name: "Hijacked" }, owner.headers, foreignSkill)).rejects.toBeInstanceOf(NotFoundError);
    await expect(dataService.deleteSkill(foreignSkill, owner.headers)).rejects.toBeInstanceOf(NotFoundError);
    expect((await dataService.getProject(foreignProject, foreign.headers)).name).toBe("FOREIGN PROJECT");
    await expect(db().project.create({ data: { userId: owner.id, courseId: foreignCourse, name: "Bad link", description: "DB must reject this link" } })).rejects.toMatchObject({ code: "P2003" });
  });
  it("rejects forged fields, invalid links and unauthenticated data access", async () => {
    await expect(dataService.saveProfile({ userId: foreign.id, careerGoal: "Forged" }, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(dataService.saveSkill({ name: "Forged", userId: foreign.id }, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(dataService.saveProject({ name: "Bad URL", description: "Invalid", link: "javascript:alert(1)" }, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    for (const operation of [dataService.getProfile(new Headers()), dataService.listProjects(new Headers()), dataService.listSkills(new Headers())]) await expect(operation).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("persists explicit changes and supports removal without automatically saving analysis", async () => {
    const project = await dataService.saveProject({ name: "Draft", description: "An actual project." }, beginner.headers);
    await dataService.saveProject({ name: "Revised", description: "An actual revised project." }, beginner.headers, project.id);
    expect(await dataService.getProject(project.id, beginner.headers)).toMatchObject({ name: "Revised", userId: beginner.id });
    const skill = await dataService.saveSkill({ name: "Curation" }, beginner.headers);
    await dataService.saveSkill({ name: "Curation", proficiency: "Self-described beginner" }, beginner.headers, skill.id);
    expect(await dataService.listSkills(beginner.headers)).toContainEqual(expect.objectContaining({ id: skill.id, proficiency: "Self-described beginner" }));
    await dataService.saveProfile({ targetRoles: ["Museum Educator"], resumeText: "Organized student exhibits." }, beginner.headers);
    await dataService.saveProfile({ careerGoal: "Work as a Museum Educator" }, beginner.headers);
    expect(await dataService.getProfile(beginner.headers)).toMatchObject({ targetRoles: ["Museum Educator"], resumeText: "Organized student exhibits." });
    const before = await dataService.getProfile(beginner.headers);
    const ai = boundary(analysis({ targetRole: "Museum Educator", recommendedProjects: [], resumeBullets: [], summary: "Develop a curation portfolio.", strengths: [] }));
    unwrap(await ai.service.handleAgentRequest({ request: "Career advice" }, beginner.headers));
    expect(await dataService.getProfile(beginner.headers)).toEqual(before);
    await dataService.deleteProject(project.id, beginner.headers); await dataService.deleteSkill(skill.id, beginner.headers); await dataService.deleteProfile(beginner.headers);
    expect(await dataService.listProjects(beginner.headers)).toEqual([]); expect(await dataService.getProfile(beginner.headers)).toBeNull();
  });
  it("bounds long career references and reports omitted evidence", async () => {
    const ids: string[] = [];
    try {
      for (let i = 0; i < 12; i++) ids.push((await dataService.saveProject({ name: `Large project ${i}`, description: "Description ".repeat(150), outcomes: ["Evidence ".repeat(50)] }, beginner.headers)).id);
      const context = await contextBuilder.buildUserContext({ request: "Improve my portfolio", options: getCareerAgentDefinition().contextRequirements }, beginner.headers);
      expect(context.career!.projects.length).toBeLessThanOrEqual(10);
      expect(context.career!.limitations.join(" ")).toContain("of 12 saved projects");
      expect(context.metadata.estimatedContextSize).toBeLessThanOrEqual(40000);
      expect(context.metadata.truncatedCategories).toContain("career");
    } finally { await db().project.deleteMany({ where: { id: { in: ids }, userId: beginner.id } }); }
  });
  it("can use a role explicitly saved in the career goal alone", async () => {
    await dataService.saveProfile({ careerGoal: "Prepare for a Museum Educator role in 2027." }, beginner.headers);
    try {
      const ai = boundary(analysis({ targetRole: "Museum Educator", resumeBullets: [], recommendedProjects: [], strengths: [], summary: "Prepare for a Museum Educator role in 2027." }));
      expect(unwrap(await ai.service.handleAgentRequest({ request: "Career guidance" }, beginner.headers)).targetRole).toBe("Museum Educator");
    } finally { await dataService.deleteProfile(beginner.headers); }
  });
});
