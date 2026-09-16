import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { WorkflowService, WorkflowRegistry, assignmentSupport } from "@/server/workflows";
import type { WorkflowInput, WorkflowContext } from "@/server/workflows/types";
import type { AssignmentAnalysis } from "@/server/workflows/assignment-policy";
import { assignmentPath, assignmentSignals, assignmentWorkPlan } from "@/server/workflows/assignment-policy";
import type { AssignmentContext } from "@/server/context/types";
import { ContextReadCache } from "@/server/context/cache";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import { AIError } from "@/server/ai/errors";
import { AgentExecutor } from "@/server/agents/executor";
import { createStudentAgentRegistry, createStudentAgentService } from "@/server/agents/student-service";
import { embeddingProvider } from "@/server/documents/embeddings";
import * as retrieval from "@/server/documents/retrieval";
import { buildUserContext } from "@/server/context/builder";
const instructions = "Prove the sum formula using mathematical induction. Include a base case. Explain the inductive step. Submit one PDF. Do not assume the conclusion in your hypothesis.";
const passage = "Mathematical Induction proves a formula using a base case and an inductive step. The inductive hypothesis assumes P(k), then derive P(k+1). The sum formula follows by adding the next term. Recursion uses a base case and a smaller instance.";
const analysis: AssignmentAnalysis = {
  objective: "Prove the sum formula by induction.", objectiveQuote: "Prove the sum formula using mathematical induction.",
  deliverables: [{ text: "Provide the base case.", instructionQuote: "Include a base case." }, { text: "Explain the inductive step.", instructionQuote: "Explain the inductive step." }],
  constraints: [{ text: "Submit one PDF.", instructionQuote: "Submit one PDF." }, { text: "Do not assume the conclusion.", instructionQuote: "Do not assume the conclusion in your hypothesis." }],
  requiredConcepts: ["Mathematical Induction"], subtasks: [{ title: "Establish the base case", deliverableIndices: [0], estimatedMinutes: 40 }, { title: "Derive the inductive step", deliverableIndices: [1], estimatedMinutes: 50 }],
  nextAction: "Write the base case before the inductive step.",
};
type Actor = { id: string; headers: Headers };
const actors: Actor[] = []; let owner: Actor, other: Actor, vector: string;
async function actor() {
  const response = await auth().api.signUpEmail({ body: { name: "Assignment Student", email: `assignment-${randomUUID()}@example.test`, password: "Assignment-fixture-passphrase!" }, asResponse: true });
  expect(response.status).toBe(200); const body = await response.json() as { user: { id: string } };
  const value = { id: body.user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) }; actors.push(value); return value;
}
async function fixture(user = owner, hours = 14 * 24) {
  const course = await db().course.create({ data: { userId: user.id, courseCode: `ASSIGN-${randomUUID().slice(0, 6)}`, courseName: "Mathematical Induction", semester: "Fall 2026" } });
  const assignment = await db().assignment.create({ data: { userId: user.id, courseId: course.id, title: "Induction Assignment 2", description: instructions, dueDate: new Date(Date.now() + hours * 3600000), priority: "HIGH", estimatedHours: 4 } });
  const input: WorkflowInput = { workflowId: "assignment-support", assignmentId: assignment.id, goal: "I don't understand what this assignment is asking." };
  return { course, assignment, input, user };
}
async function document(f: Awaited<ReturnType<typeof fixture>>, marker = "SELECTED_MATERIAL") {
  const doc = await db().document.create({ data: { userId: f.user.id, courseId: f.course.id, title: "Induction Lecture", originalFileName: "lecture.pdf", fileType: "PDF", fileSize: passage.length, storageKey: randomUUID(), processingStatus: "READY", embeddingModel: embeddingProvider.id, pageCount: 12 } });
  await db().$executeRaw`INSERT INTO "DocumentChunk" (id,"documentId","userId","courseId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata) VALUES (${randomUUID()},${doc.id},${f.user.id},${f.course.id},0,${passage + " " + marker},5,6,80,${vector}::vector,${embeddingProvider.id},'{}'::jsonb)`;
  return doc;
}
function boundary(options: { fail?: string; analysis?: AssignmentAnalysis; invalidSource?: boolean; invalidRequirement?: boolean; invalidOutput?: boolean; gate?: (name: string) => Promise<void> } = {}) {
  const calls: string[] = [], requests: AIStructuredRequest<unknown>[] = [];
  const provider: AIProvider = {
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      calls.push(request.schemaName); requests.push(request as AIStructuredRequest<unknown>); await options.gate?.(request.schemaName);
      if (options.fail === request.schemaName) throw new AIError("PROVIDER_FAILURE");
      const params = JSON.parse(request.messages[0].content.split("Execution parameters: ")[1]);
      const sourceIndices = options.invalidSource ? [99] : params.sourceCatalog?.length ? [0] : [];
      let data: unknown;
      if (request.schemaName === "assignment_analysis") data = structuredClone(options.analysis ?? analysis);
      else if (request.schemaName === "assignment_guidance" || request.schemaName === "assignment_reference_notes") data = { explanation: "Induction starts with a base case, then derives P(k+1) from P(k). On an analogous sum, add the next term and simplify.", nextAction: "Write the base case and show where your inductive hypothesis applies.", sourceIndices };
      else if (request.schemaName === "assignment_feedback") data = { strengths: ["Your hypothesis is stated clearly."], issues: ["The base case has not been demonstrated."], missingRequirements: [{ deliverableIndex: options.invalidRequirement ? 50 : 0, feedback: "Show the base case calculation." }], conceptualErrors: ["The hypothesis does not automatically establish the next case."], suggestedImprovements: ["Substitute the starting value, then show the successor algebra."], nextAction: "Calculate the first case explicitly before revising the successor step.", sourceIndices };
      else throw new Error(`Unexpected generation: ${request.schemaName}`);
      if (options.invalidOutput) data = { prose: "Looks good" };
      return { id: "assignment-fixture", model: "fixture", text: JSON.stringify(data), data: data as T };
    }, generateText() { throw new Error("Structured existing-agent execution expected."); }, streamText() { throw new Error("No new stream pipeline."); }, generateEmbedding() { throw new Error("Use existing local RAG."); },
  };
  return { calls, requests, provider, service: new WorkflowService({ getProvider: () => provider }) };
}
async function saved(id: string) { return (await db().workflowRun.findUniqueOrThrow({ where: { id } })).context as unknown as WorkflowContext; }
beforeAll(async () => { owner = await actor(); other = await actor(); vector = JSON.stringify(await embeddingProvider.generateEmbedding(passage)); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { for (const user of actors) { await db().user.deleteMany({ where: { id: user.id } }); await db().fileDeletion.deleteMany({ where: { userId: user.id } }); } await db().$disconnect(); });

describe.sequential("Assignment Support through real auth, database, context and RAG", () => {
  it("registers bounded stages using existing Tutor, Notes and code steps", () => {
    const registry = new WorkflowRegistry(createStudentAgentRegistry()); registry.register(assignmentSupport);
    expect(registry.get("assignment-support").steps.map((s) => s.id)).toEqual(["understand", "plan", "notes", "help", "draft", "review"]);
    expect(assignmentSupport.maxRetries).toBe(0); expect(assignmentSupport.maxAgentCalls).toBe(3);
  });
  it("analyzes an understand-only request once with exact requirements and traceability", async () => {
    const f = await fixture(), ai = boundary(); const search = vi.spyOn(retrieval, "retrieveAcademicContext");
    const run = await ai.service.runWorkflow(f.input, owner.headers);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "completed", completedSteps: ["understand"], assignmentSupport: { assignmentId: f.assignment.id, stage: "understand", nextAction: analysis.nextAction } });
    expect(run.outputs["assignment-analysis"]).toMatchObject({ ...analysis, assignmentSource: { assignmentId: f.assignment.id, updatedAt: f.assignment.updatedAt.toISOString() } });
    expect(ai.calls).toEqual(["assignment_analysis"]); expect(search).not.toHaveBeenCalled();
    expect(ai.requests[0].messages.map((m) => m.content).join("\n")).toContain(instructions);
  });
  it("plans how to start without unnecessarily invoking conceptual help or waiting", async () => {
    const f = await fixture(), ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, goal: "Help me start Assignment 2.", availableMinutes: 90 }, owner.headers);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "completed", completedSteps: ["understand", "plan"], assignmentSupport: { stage: "plan" } });
    const plan = run.outputs["assignment-plan"] as ReturnType<typeof assignmentWorkPlan>;
    expect(plan.totalMinutes).toBeLessThanOrEqual(90); expect(plan.deferredSubtasks.length).toBeGreaterThan(0); expect(plan.nextAction).toContain("base case"); expect(ai.calls).toEqual(["assignment_analysis"]);
    expect(await db().studyPlan.count({ where: { userId: owner.id, tasks: { some: { courseId: f.course.id } } } })).toBe(0);
  });
  it.each([1, 20, 90])("respects %s minutes including preparation and review", async (availableMinutes) => {
    const f = await fixture(), ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, goal: "Break this assignment into steps.", availableMinutes }, owner.headers);
    const plan = run.outputs["assignment-plan"] as ReturnType<typeof assignmentWorkPlan>;
    expect(plan.totalMinutes).toBeLessThanOrEqual(availableMinutes); expect(plan.totalMinutes).toBe(plan.blocks.reduce((sum, b) => sum + b.minutes, 0) + plan.reviewMinutes + plan.preparationMinutes);
    expect(plan.blocks.every((b) => b.minutes <= 60)).toBe(true); expect(plan.deferredSubtasks.length).toBeGreaterThan(0);
  });
  it("uses existing priority signals and distinguishes six hours from fourteen days", async () => {
    const urgent = await fixture(owner, 6), later = await fixture(owner, 336), overdue = await fixture(owner, -48), ai = boundary();
    const states = [];
    for (const f of [urgent, later, overdue]) states.push((await saved((await ai.service.runWorkflow({ ...f.input, goal: "Help me start Assignment 2.", availableMinutes: 90 }, owner.headers)).runId)).assignment!);
    expect(states[0].signals).toMatchObject({ dueSoon: true, notStarted: true, strategy: "essentials-first" });
    expect(states[1].signals.strategy).toBe("steady-progress"); expect(states[2].signals.overdue).toBe(true);
    expect(states[0].signals.priorityScore).toBeGreaterThan(states[1].signals.priorityScore);
    expect(ai.requests[0].messages[0].content).toContain('"hoursRemaining":6');
  });
  it("states the availability assumption and retains partial dependencies", async () => {
    const f = await fixture(), ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, goal: "Plan only the assignment work." }, owner.headers);
    const plan = run.outputs["assignment-plan"] as ReturnType<typeof assignmentWorkPlan>;
    expect(plan.assumption).toContain("Assume 60 minutes"); expect((await saved(run.runId)).assignment?.signals.availabilityAssumed).toBe(true);
    const long = { ...analysis, subtasks: analysis.subtasks.map((t) => ({ ...t, estimatedMinutes: 120 })) };
    const blocks = assignmentWorkPlan(long, (await saved(run.runId)).assignment!.signals).blocks;
    expect(blocks).toHaveLength(1); expect(blocks[0].partial).toBe(true);
  });
  it("uses targeted Tutor help and pauses until the student writes a draft", async () => {
    const f = await fixture(), ai = boundary(); const execute = vi.spyOn(AgentExecutor.prototype, "executeStructured");
    const run = await ai.service.runWorkflow({ ...f.input, goal: "Explain how to do Question 3.", specificQuestion: "How does mathematical induction prove the sum formula?" }, owner.headers);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "waiting-for-input", completedSteps: ["understand", "help", "draft"], waitingFor: { kind: "student-work", referenceId: f.assignment.id } });
    expect(ai.calls).toEqual(["assignment_analysis", "assignment_guidance"]); expect(execute.mock.calls.map(([r]) => r.agentId)).toEqual(["tutor", "tutor"]);
    const help = ai.requests[1].messages.map((m) => m.content).join("\n"); expect(help).toContain("analogous example"); expect(help).toContain('"assignmentAnalysis"'); expect(help).toContain(instructions);
  });
  it("uses Notes only when formula or condensed concept review is requested", async () => {
    const f = await fixture(), ai = boundary(); const execute = vi.spyOn(AgentExecutor.prototype, "executeStructured");
    const run = await ai.service.runWorkflow({ ...f.input, goal: "Give me condensed formula notes before this assignment." }, owner.headers);
    expect(run.status).toBe("waiting-for-input"); expect(ai.calls).toEqual(["assignment_analysis", "assignment_reference_notes"]);
    expect(execute.mock.calls.map(([r]) => r.agentId)).toEqual(["tutor", "notes"]);
  });
  it("reuses analysis for general concept help without resending full instructions", async () => {
    const f = await fixture(), ai = boundary();
    const run = await ai.service.runWorkflow({ ...f.input, goal: "Explain the concepts I need for this assignment." }, owner.headers);
    expect(run.status).toBe("waiting-for-input");
    const help = ai.requests.find((r) => r.schemaName === "assignment_guidance")!;
    expect(JSON.stringify(help.messages)).toContain("assignmentAnalysis"); expect(JSON.stringify(help.messages)).not.toContain(instructions);
    expect(ai.calls).toEqual(["assignment_analysis", "assignment_guidance"]);
  });
  it("fits a longer guided session and review within the cumulative existing-agent limits", async () => {
    const f = await fixture(), ai = boundary();
    const run = await ai.service.runWorkflow({ ...f.input, goal: "Help me with this assignment.", availableMinutes: 90 }, owner.headers);
    expect(run.completedSteps).toEqual(["understand", "plan", "help", "draft"]);
    const plan = run.outputs["assignment-plan"] as ReturnType<typeof assignmentWorkPlan>;
    expect(plan.preparationMinutes).toBe(15); expect(plan.totalMinutes).toBeLessThanOrEqual(90);
    const done = await ai.service.resumeWorkflow({ runId: run.runId, userWork: "I established the base case and assumed P(k)." }, owner.headers);
    expect(done.status).toBe("completed"); expect(ai.calls).toEqual(["assignment_analysis", "assignment_guidance", "assignment_feedback"]);
  });
  it("retrieves only selected documents and preserves real page sources", async () => {
    const f = await fixture(), selected = await document(f), unused = await document(f, "UNSELECTED_SECRET"), ai = boundary();
    const search = vi.spyOn(retrieval, "retrieveAcademicContext");
    const run = await ai.service.runWorkflow({ ...f.input, documentIds: [selected.id], goal: "Explain mathematical induction for this problem." }, owner.headers);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "waiting-for-input" });
    for (const [userId, args] of search.mock.calls) { expect(userId).toBe(owner.id); expect(args).toMatchObject({ courseId: f.course.id, documentIds: [selected.id] }); }
    expect(run.outputs["assignment-help"]).toMatchObject({ sources: [expect.objectContaining({ documentId: selected.id, pageNumber: 5, pageEnd: 6 })] });
    expect(JSON.stringify(ai.requests)).not.toContain(unused.id); expect(JSON.stringify(ai.requests)).not.toContain("UNSELECTED_SECRET");
  });
  it("keeps student work separate from official instructions and returns actionable structured feedback", async () => {
    const f = await fixture(), ai = boundary(); const userWork = "STUDENT_DRAFT: I assume P(k), hence P(k+1). This is not a teacher rubric.";
    const run = await ai.service.runWorkflow({ ...f.input, goal: "Check my answer.", userWork }, owner.headers);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "completed", completedSteps: ["understand", "review"], assignmentSupport: { stage: "review", feedback: { strengths: [expect.any(String)], missingRequirements: [{ deliverableIndex: 0, feedback: expect.any(String) }], conceptualErrors: [expect.any(String)], suggestedImprovements: [expect.any(String)] } } });
    const review = ai.requests.find((r) => r.schemaName === "assignment_feedback")!;
    const reference = review.messages.find((m) => m.content.startsWith("Additional reference data"))!;
    expect(reference.role).toBe("user"); expect(reference.content).toContain('"studentWork":"STUDENT_DRAFT');
    const officialMessage = review.messages.find((m) => m.content.includes("[ASSIGNMENTS]"))!;
    expect(officialMessage.content).toContain(instructions); expect(officialMessage.content).not.toContain("STUDENT_DRAFT");
    expect(ai.calls).toEqual(["assignment_analysis", "assignment_feedback"]); expect(run.assignmentSupport?.nextAction).toContain("first case");
    expect(await db().assignment.findUnique({ where: { id: f.assignment.id } })).toMatchObject({ status: "TODO", completedAt: null });
  });
  it("pauses a review request without work rather than fabricating feedback", async () => {
    const f = await fixture(), ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, goal: "Review my answer." }, owner.headers);
    expect(run.status).toBe("waiting-for-input"); expect(run.outputs["assignment-feedback"]).toBeUndefined(); expect(ai.calls).toEqual(["assignment_analysis"]);
  });
  it("resumes in a new service, preserves analysis and handles duplicate concurrent resumes once", async () => {
    const f = await fixture(), ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, goal: "Help me solve this induction problem." }, owner.headers);
    const before = run.outputs["assignment-analysis"];
    const service = new WorkflowService({ getProvider: () => ai.provider });
    const input = { runId: run.runId, userWork: "My induction hypothesis is P(k). I need help with the base case." };
    await Promise.all([service.resumeWorkflow(input, owner.headers), service.resumeWorkflow(input, owner.headers)]);
    const done = await service.resumeWorkflow(input, owner.headers);
    expect(done.status).toBe("completed"); expect(done.outputs["assignment-analysis"]).toEqual(before); expect(done.assignmentSupport?.stage).toBe("review");
    expect(ai.calls).toEqual(["assignment_analysis", "assignment_guidance", "assignment_feedback"]);
    expect((await saved(run.runId)).assignment?.userWork).toBe(input.userWork);
  });
  it("rejects invalid drafts before claiming the run and permits a subsequent valid resume", async () => {
    const f = await fixture(), ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, goal: "Check my answer." }, owner.headers);
    for (const userWork of ["", " ", "x".repeat(6001)]) await expect(ai.service.resumeWorkflow({ runId: run.runId, userWork }, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(ai.service.resumeWorkflow({ runId: run.runId, quizAttemptId: "wrong-kind" }, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect((await ai.service.getRun(run.runId, owner.headers)).status).toBe("waiting-for-input");
    expect((await ai.service.resumeWorkflow({ runId: run.runId, userWork: "Draft proof" }, owner.headers)).status).toBe("completed");
  });
  it("preserves completed useful work when review generation fails", async () => {
    const f = await fixture(), ai = boundary({ fail: "assignment_feedback" }); const run = await ai.service.runWorkflow({ ...f.input, goal: "Help me solve this induction problem." }, owner.headers);
    const done = await ai.service.resumeWorkflow({ runId: run.runId, userWork: "Draft proof" }, owner.headers);
    expect(done).toMatchObject({ status: "failed", errorCode: "PROVIDER_FAILURE" }); expect(done.outputs["assignment-analysis"]).toBeDefined(); expect(done.outputs["assignment-help"]).toBeDefined(); expect(done.assignmentSupport?.feedback).toBeUndefined();
    expect((await saved(run.runId)).assignment?.userWork).toBe("Draft proof");
    const again = await ai.service.resumeWorkflow({ runId: run.runId, userWork: "Draft proof" }, owner.headers); expect(again.status).toBe("failed"); expect(ai.calls.filter((c) => c === "assignment_feedback")).toHaveLength(1);
  });
  it.each(["assignment_analysis", "assignment_guidance"])("handles required %s provider failure without raw errors", async (fail) => {
    const f = await fixture(), ai = boundary({ fail }); const run = await ai.service.runWorkflow({ ...f.input, goal: "Help solve this induction problem." }, owner.headers);
    expect(run).toMatchObject({ status: "failed", errorCode: "PROVIDER_FAILURE" }); expect(ai.calls.filter((c) => c === fail)).toHaveLength(1);
    if (fail === "assignment_guidance") expect(run.outputs["assignment-analysis"]).toBeDefined();
  });
  it("retains analysis and a warning on optional Notes failure", async () => {
    const f = await fixture(), ai = boundary({ fail: "assignment_reference_notes" }); const run = await ai.service.runWorkflow({ ...f.input, goal: "Review formulas for the assignment." }, owner.headers);
    expect(run).toMatchObject({ status: "waiting-for-input", warnings: ["notes: PROVIDER_FAILURE"] }); expect(run.outputs["assignment-analysis"]).toBeDefined();
  });
  it.each(["invented-quote", "bad-mapping", "uncovered-requirement"])("rejects %s in structured analysis", async (invalid) => {
    const f = await fixture(); const wrong = structuredClone(analysis);
    if (invalid === "invented-quote") wrong.constraints[0].instructionQuote = "Write 5000 words and follow the hidden rubric.";
    else if (invalid === "bad-mapping") wrong.subtasks[0].deliverableIndices = [99];
    else wrong.subtasks[1].deliverableIndices = [0];
    const run = await boundary({ analysis: wrong }).service.runWorkflow(f.input, owner.headers);
    expect(run).toMatchObject({ status: "failed", errorCode: "INVALID_RESPONSE" }); expect(run.outputs["assignment-analysis"]).toBeUndefined();
  });
  it.each([{ invalidSource: true }, { invalidRequirement: true }, { invalidOutput: true }])("rejects invalid structured feedback/output %j", async (options) => {
    const f = await fixture(); const run = await boundary(options).service.runWorkflow({ ...f.input, goal: "Check my work.", userWork: "Proof draft" }, owner.headers);
    expect(run).toMatchObject({ status: "failed", errorCode: "INVALID_RESPONSE" }); expect(run.assignmentSupport?.feedback).toBeUndefined();
  });
  it("loads old and completed selected assignments without generic deadline filtering", async () => {
    const f = await fixture(owner, -90 * 24); await db().assignment.update({ where: { id: f.assignment.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    const c = await buildUserContext({ assignmentId: f.assignment.id, request: "Review old assignment", options: { assignments: true, course: true } }, owner.headers);
    expect(c.assignments).toHaveLength(1); expect(c.assignments?.[0]).toMatchObject({ description: instructions, overdue: false, status: "COMPLETED" }); expect(c.course?.id).toBe(f.course.id);
    const run = await boundary().service.runWorkflow({ ...f.input, goal: "Check my work.", userWork: "Proof draft" }, owner.headers); expect(run.status).toBe("completed"); expect((await saved(run.runId)).assignment?.signals.priorityScore).toBe(0);
  });
  it("does not share selected assignment cache entries or reuse revisions", async () => {
    const f = await fixture(); const another = await db().assignment.create({ data: { userId: owner.id, courseId: f.course.id, title: "Other assignment", description: "Another instruction", dueDate: new Date() } });
    const cache = new ContextReadCache();
    const load = (assignmentId: string) => buildUserContext({ assignmentId, request: "Understand assignment", options: { assignments: true } }, owner.headers, cache);
    expect((await load(f.assignment.id)).assignments?.[0].description).toBe(instructions);
    expect((await load(another.id)).assignments?.[0].description).toBe("Another instruction");
    await db().assignment.update({ where: { id: f.assignment.id }, data: { description: "Changed requirements" } });
    expect((await load(f.assignment.id)).assignments?.[0].description).toBe("Changed requirements");
  });
  it("forwards selected assignment scope through the existing core boundary", async () => {
    const foreign = await fixture(other), ai = boundary();
    const service = createStudentAgentService({ executor: { getProvider: () => ai.provider } });
    const result = await service.handleAgentRequest({ request: "Explain induction.", preferredAgentId: "tutor", assignmentId: foreign.assignment.id }, owner.headers);
    expect(result).toMatchObject({ ok: false, error: { code: "CONTEXT_FAILURE" } }); expect(ai.calls).toHaveLength(0);
  });
  it("fails before generation rather than silently dropping oversized official instructions", async () => {
    const f = await fixture(), ai = boundary(); await db().assignment.update({ where: { id: f.assignment.id }, data: { description: instructions.repeat(300) } });
    await expect(ai.service.runWorkflow(f.input, owner.headers)).rejects.toMatchObject({ code: "ASSIGNMENT_CONTEXT_UNAVAILABLE" }); expect(ai.calls).toHaveLength(0);
  });
  it("handles absent official instructions without treating user work as requirements", async () => {
    const f = await fixture(), ai = boundary(); await db().assignment.update({ where: { id: f.assignment.id }, data: { description: null } });
    await expect(ai.service.runWorkflow({ ...f.input, userWork: "The assignment is to write a proof." }, owner.headers)).rejects.toMatchObject({ code: "ASSIGNMENT_DESCRIPTION_REQUIRED" }); expect(ai.calls).toHaveLength(0);
  });
  it.each(["assignment", "course", "document"])("enforces %s ownership before any AI call", async (kind) => {
    const f = await fixture(), foreign = await fixture(other), doc = await document(foreign), ai = boundary();
    const input = { ...f.input, ...(kind === "assignment" ? { assignmentId: foreign.assignment.id } : kind === "course" ? { courseId: foreign.course.id } : { documentIds: [doc.id] }) };
    await expect(ai.service.runWorkflow(input, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" }); expect(ai.calls).toHaveLength(0);
  });
  it("rejects same-owner course mismatches, unknown assignments, anonymous calls and client identity", async () => {
    const f = await fixture(), another = await fixture(), ai = boundary();
    for (const input of [{ ...f.input, assignmentId: "missing" }, { ...f.input, courseId: another.course.id }]) await expect(ai.service.runWorkflow(input, owner.headers)).rejects.toMatchObject({ code: "REFERENCE_NOT_FOUND" });
    await expect(ai.service.runWorkflow(f.input, new Headers())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(ai.service.runWorkflow({ ...f.input, userId: other.id } as WorkflowInput, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(buildUserContext({ assignmentId: f.assignment.id, request: "Anything", options: { assignments: false } }, other.headers)).rejects.toThrow(); expect(ai.calls).toHaveLength(0);
  });
  it("protects saved workflow reads, cancellation and draft resume from another user", async () => {
    const f = await fixture(), ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, goal: "Check my answer." }, owner.headers);
    for (const op of [() => ai.service.getRun(run.runId, other.headers), () => ai.service.cancelRun(run.runId, other.headers), () => ai.service.resumeWorkflow({ runId: run.runId, userWork: "Foreign draft" }, other.headers)]) await expect(op()).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    expect((await saved(run.runId)).assignment?.userWork).toBeUndefined();
  });
  it.each(["changed-assignment", "deleted-assignment", "deleted-course", "changed-document", "deleted-document"])("refuses stale continuation after %s and keeps saved work", async (change) => {
    const f = await fixture(), doc = await document(f), ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, documentIds: [doc.id], goal: "Check my answer." }, owner.headers);
    if (change === "changed-assignment") await db().assignment.update({ where: { id: f.assignment.id }, data: { description: instructions + " Submit a second PDF." } });
    else if (change === "deleted-assignment") await db().assignment.delete({ where: { id: f.assignment.id } });
    else if (change === "deleted-course") await db().course.delete({ where: { id: f.course.id } });
    else if (change === "changed-document") await db().document.update({ where: { id: doc.id }, data: { title: "New material" } });
    else await db().document.delete({ where: { id: doc.id } });
    await expect(ai.service.resumeWorkflow({ runId: run.runId, userWork: "Proof draft" }, owner.headers)).rejects.toMatchObject({ code: change === "changed-assignment" ? "ASSIGNMENT_CHANGED" : change === "changed-document" ? "DOCUMENT_CHANGED" : "REFERENCE_NOT_FOUND" });
    expect((await ai.service.getRun(run.runId, owner.headers)).outputs["assignment-analysis"]).toBeDefined(); expect(ai.calls).toEqual(["assignment_analysis"]);
  });
  it("checks for assignment changes during generation before publishing analysis", async () => {
    const f = await fixture(), ai = boundary({ gate: async () => { await db().assignment.update({ where: { id: f.assignment.id }, data: { description: "Replaced instructions" } }); } });
    const run = await ai.service.runWorkflow(f.input, owner.headers); expect(run).toMatchObject({ status: "failed", errorCode: "ASSIGNMENT_CHANGED" }); expect(run.outputs["assignment-analysis"]).toBeUndefined();
  });
  it("does not publish stale review feedback if requirements change during resumed generation", async () => {
    const f = await fixture(), ai = boundary({ gate: async (name) => {
      if (name === "assignment_feedback") await db().assignment.update({ where: { id: f.assignment.id }, data: { description: instructions + " Include a second proof." } });
    } });
    const run = await ai.service.runWorkflow({ ...f.input, goal: "Check my work." }, owner.headers);
    const done = await ai.service.resumeWorkflow({ runId: run.runId, userWork: "Draft proof" }, owner.headers);
    expect(done).toMatchObject({ status: "failed", errorCode: "ASSIGNMENT_CHANGED" }); expect(done.assignmentSupport?.feedback).toBeUndefined(); expect(done.outputs["assignment-analysis"]).toBeDefined();
  });
  it.each(["PROCESSING", "FAILED"] as const)("rejects selected %s material before generation", async (processingStatus) => {
    const f = await fixture(), doc = await document(f), ai = boundary(); await db().document.update({ where: { id: doc.id }, data: { processingStatus } });
    await expect(ai.service.runWorkflow({ ...f.input, documentIds: [doc.id] }, owner.headers)).rejects.toMatchObject({ code: "DOCUMENT_NOT_READY" }); expect(ai.calls).toHaveLength(0);
  });
  it("does not silently omit a selected document with no retrievable passage", async () => {
    const f = await fixture(), first = await document(f), empty = await document(f), ai = boundary(); await db().documentChunk.deleteMany({ where: { documentId: empty.id } });
    const run = await ai.service.runWorkflow({ ...f.input, documentIds: [first.id, empty.id], goal: "Explain mathematical induction." }, owner.headers);
    expect(run).toMatchObject({ status: "failed", errorCode: "SOURCE_CONTEXT_UNAVAILABLE" }); expect(ai.calls).toEqual(["assignment_analysis"]); expect(run.outputs["assignment-analysis"]).toBeDefined();
  });
  it("deduplicates identical active starts but distinguishes goals, drafts and current revisions", async () => {
    const f = await fixture(), ai = boundary(); const input = { ...f.input, goal: "Check my answer." };
    const first = await ai.service.runWorkflow(input, owner.headers), duplicate = await ai.service.runWorkflow(input, owner.headers);
    expect(duplicate.runId).toBe(first.runId); expect(ai.calls).toEqual(["assignment_analysis"]);
    const otherGoal = await ai.service.runWorkflow({ ...input, goal: "Review my work." }, owner.headers); expect(otherGoal.runId).not.toBe(first.runId);
    await db().assignment.update({ where: { id: f.assignment.id }, data: { dueDate: new Date(Date.now() + 86400000) } });
    const revision = await ai.service.runWorkflow(input, owner.headers); expect(revision.runId).not.toBe(first.runId);
  });
  it("cancels a waiting run without generating feedback or updating the assignment", async () => {
    const f = await fixture(), ai = boundary(); const run = await ai.service.runWorkflow({ ...f.input, goal: "Check my answer." }, owner.headers);
    const cancelled = await ai.service.cancelRun(run.runId, owner.headers); expect(cancelled.status).toBe("cancelled");
    expect((await ai.service.resumeWorkflow({ runId: run.runId, userWork: "Draft" }, owner.headers)).status).toBe("cancelled");
    expect(ai.calls).toEqual(["assignment_analysis"]); expect((await db().workflowRun.findUniqueOrThrow({ where: { id: run.runId } })).activeKey).toBeNull();
    expect((await db().assignment.findUniqueOrThrow({ where: { id: f.assignment.id } })).status).toBe("TODO");
  });
});

describe("Deterministic assignment decisions", () => {
  it("keeps short generic help focused while allowing targeted learning and review", () => {
    expect(assignmentPath({ goal: "Help me with this assignment", availableMinutes: 20 })).toMatchObject({ plan: true, help: false });
    expect(assignmentPath({ goal: "Help me with this assignment", availableMinutes: 90 })).toMatchObject({ plan: true, help: true });
    expect(assignmentPath({ goal: "I don't understand this assignment" })).toMatchObject({ understandOnly: true, help: false, notes: false });
    expect(assignmentPath({ goal: "Check my code" })).toMatchObject({ review: true, help: false });
  });
  it("uses exact deadline hours plus existing shared academic priority", () => {
    const base: AssignmentContext = { id: "a", title: "Proof", dueDate: "2026-09-14T18:00:00Z", status: "TODO", priority: "HIGH", estimatedHours: 10, overdue: false, course: { id: "c", courseCode: "MATH", courseName: "Math" } };
    const signals = assignmentSignals(base, 20, new Date("2026-09-14T12:00:00Z"));
    expect(signals).toMatchObject({ hoursRemaining: 6, highEstimatedEffort: true, notStarted: true, estimatedMinutes: 600, dueSoon: true });
    const plan = assignmentWorkPlan(analysis, { ...signals, availableMinutes: 90 });
    expect(plan.blocks.every((b) => b.minutes <= 30)).toBe(true);
    expect(plan.totalMinutes).toBe(90); expect(plan.deferredSubtasks).toEqual([{ title: "Derive the inductive step", subtaskIndex: 1, remainingMinutes: 15 }]);
  });
});
