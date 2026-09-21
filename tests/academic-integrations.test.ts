import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendOptions } from "pg-boss";
import { z } from "zod";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import * as ai from "@/server/ai";
import { AcademicProviderRegistry, academicProviderRegistry } from "@/server/academic-integrations/registry";
import { TestAcademicProvider } from "@/server/academic-integrations/test-provider";
import { AcademicIntegrationError } from "@/server/academic-integrations/errors";
import { academicAccess } from "@/server/academic-integrations/access";
import { collectAcademic, courseMatches, examImportReason, fileImportReason, previewToken, verifyPreview, safeAcademicUrl } from "@/server/academic-integrations/normalize";
import { createAcademicIntegrationService, type AcademicEnqueue } from "@/server/academic-integrations/service";
import { createAcademicHttp } from "@/server/academic-integrations/http";
import { academicSyncConfig } from "@/server/academic-integrations/config";
import { externalCourseSchema, externalAssignmentSchema, externalAssessmentSchema, externalCourseFileSchema, type AcademicImportOptions, type ConfirmedCourseImport } from "@/lib/student/academic-integrations/types";
import { enqueueExternalCourseSync, createExternalCourseSyncJob, createAcademicSyncSweep } from "@/server/jobs/sync-external-course";
import { executeBackgroundJob } from "@/server/jobs/executor";
import { normalizeBackgroundJobError } from "@/server/jobs/errors";
import { getBackgroundJob } from "@/server/jobs/registry";
import { createBackgroundJobBoss } from "@/server/jobs/client";
import { ensureBackgroundJobQueues } from "@/server/jobs/queue";
import { getTokenEncryptionService, credentialContext } from "@/server/integrations/encryption";
import { listConnectedAccounts } from "@/server/integrations/service";
import { cleanupFiles } from "@/server/documents/cleanup";
import { fullDocumentText, retrieveAcademicContext } from "@/server/documents/retrieval";
import { getDocument } from "@/server/documents/service";
import { storage } from "@/server/documents/storage/local";
import { embeddingProvider } from "@/server/documents/embeddings";
import { buildUserContext } from "@/server/context/builder";
import { getTutorAgentDefinition } from "@/server/agents/tutor/definition";
import { getNotesAgentDefinition } from "@/server/agents/notes/definition";
import { getQuizAgentDefinition } from "@/server/agents/quiz/definition";
import { getStudyPlannerAgentDefinition } from "@/server/agents/study-planner/definition";
import { WorkflowService } from "@/server/workflows";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import { createPlanningBrief } from "@/server/agents/study-planner/priority";
import { inductionPages, textPdf } from "./fixtures/documents";
type Actor = {
    id: string;
    headers: Headers;
};
let owner: Actor, other: Actor, accountId: string, provider: TestAcademicProvider;
let registry: AcademicProviderRegistry, service: ReturnType<typeof createAcademicIntegrationService>;
let queued: {
    name: string;
    data: object | null;
    options: SendOptions | null;
}[];
const resources: string[] = [];
const all: AcademicImportOptions = { assignments: true, assessments: true, files: true };
const academicOnly = { ...all, files: false };
const filesOnly = { assignments: false, assessments: false, files: true };
const due = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
const signal = () => new AbortController().signal;
const publisher = { async send(name: string, data?: object | null, options?: SendOptions) { queued.push({ name, data: data ?? null, options: options ?? null }); return options?.id ?? randomUUID(); } };
const enqueue: AcademicEnqueue = async (tx, link) => { resources.push(link.id); await enqueueExternalCourseSync(tx, link, publisher); };
const input = (options = all) => ({ connectedAccountId: accountId, externalCourseId: "math", options });
const sync = () => service.syncExternalCourse(owner.id, accountId, "math");
async function confirmation(options = all, targetCourseId?: string): Promise<ConfirmedCourseImport> {
    const preview = await service.preview(owner.id, input(options));
    return { ...input(options), previewToken: preview.previewToken, courseCode: "MATH 1240 A01", semester: "Fall 2026", confirmed: true, ...(targetCourseId ? { targetCourseId } : {}) };
}
async function imported(options = all, targetCourseId?: string) {
    const status = await service.importExternalCourse(owner.id, await confirmation(options, targetCourseId));
    expect(status).toBeTruthy();
    return status!;
}
async function localCourse(userId = owner.id) {
    return db().course.create({ data: { userId, courseName: "Discrete Mathematics", courseCode: "MATH 1240 A01", semester: "Fall 2026", description: "Personal description" } });
}
async function actor(): Promise<Actor> {
    const response = await auth().api.signUpEmail({ body: { name: "LMS Student", email: `lms-${randomUUID()}@example.test`, password: "Lms-test-passphrase-2026!" }, asResponse: true });
    expect(response.status).toBe(200);
    const { user } = await response.json() as {
        user: {
            id: string;
        };
    };
    await db().profile.create({ data: { userId: user.id, school: "Test", program: "Math", currentYear: 1, semester: "Fall 2026", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
    return { id: user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map(x => x.split(";")[0]).join("; "), origin: "http://localhost:3000", "content-type": "application/json" }) };
}
async function cleanup() {
    const users = [owner.id, other.id];
    await db().document.deleteMany({ where: { userId: { in: users } } });
    for (const userId of users)
        await cleanupFiles(userId);
    await db().course.deleteMany({ where: { userId: { in: users } } });
    await db().connectedAccount.deleteMany({ where: { userId: { in: users } } });
}
beforeAll(async () => { owner = await actor(); other = await actor(); });
beforeEach(async () => {
    await cleanup();
    vi.stubEnv("INTEGRATION_TOKEN_KEYS", JSON.stringify({ v1: randomBytes(32).toString("base64") }));
    provider = new TestAcademicProvider();
    registry = new AcademicProviderRegistry(true).register(provider);
    queued = [];
    service = createAcademicIntegrationService({ registry, enqueue });
    accountId = (await db().connectedAccount.create({ data: { userId: owner.id, provider: provider.id, providerAccountId: randomUUID(), displayName: "Institution fixture", scopes: [...provider.capabilities], connectionConfig: { institution: "Test University" } } })).id;
    provider.courses.set("math", { externalId: "math", name: "Discrete Mathematics", code: "MATH 1240 A01", term: "Fall 2026", instructor: "Professor Test", endDate: due(90) });
    provider.assignments.set("math", [
        { externalId: "a1", courseExternalId: "math", title: "Induction assignment", description: "Prove the induction step", dueAt: due(1), externalUrl: "https://institution.example/assignments/1" },
        { externalId: "undated", courseExternalId: "math", title: "Optional exercises", dueAt: null },
    ]);
    provider.assessments.set("math", [
        { externalId: "midterm", courseExternalId: "math", title: "Induction midterm", dueAt: due(2), topics: ["Induction"], assessmentType: "midterm" },
        { externalId: "quiz", courseExternalId: "math", title: "Quick check", dueAt: due(1), topics: [], assessmentType: "quiz" },
        { externalId: "no-date", courseExternalId: "math", title: "Future final", dueAt: null, topics: [], assessmentType: "final" },
    ]);
    const bytes = textPdf(inductionPages);
    provider.files.set("math", [{ externalId: "pdf", courseExternalId: "math", name: "Lecture.pdf", mimeType: "application/pdf", size: bytes.length, modifiedAt: "2026-09-19T12:00:00.000Z", downloadReference: "pdf-content", externalUrl: "https://institution.example/files/pdf" }]);
    provider.contents.set("pdf-content", bytes);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => { throw Error("No external network or LLM calls during LMS import"); }));
    vi.spyOn(ai, "getAIProvider").mockImplementation(() => { throw Error("No generative AI during synchronization"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await cleanup(); await db().jobRun.deleteMany({ where: { resourceId: { in: resources } } }); await db().user.deleteMany({ where: { id: { in: [owner.id, other.id] } } }); await db().$disconnect(); });
describe.sequential("Provider-independent academic import", () => {
    it("rejects an oversized LMS file batch before downloads or embedding fan-out", async () => {
        const sample = provider.files.get("math")![0];
        provider.files.set("math", Array.from({ length: academicSyncConfig().maxFiles + 1 }, (_, i) => ({ ...sample, externalId: `batch-${i}` })));
        await expect(service.preview(owner.id, input(filesOnly))).rejects.toMatchObject({ code: "LIMIT" });
        expect(provider.calls.some(call => call.startsWith("download:"))).toBe(false);
        expect(queued).toHaveLength(0);
        expect(await db().document.count({ where: { userId: owner.id } })).toBe(0);
    });
    it("coalesces throttled course requests through a shared cooldown and recovers afterwards", async () => {
        const list = vi.spyOn(provider, "listCourses").mockRejectedValueOnce(new AcademicIntegrationError("PROVIDER_RATE_LIMITED"));
        await expect(service.listCourses(owner.id, accountId)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", status: 429 });
        await Promise.all(Array.from({ length: 10 }, () => expect(service.listCourses(owner.id, accountId)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" })));
        expect(list).toHaveBeenCalledTimes(1); expect((await service.settings(owner.id)).accounts[0].health?.state).toBe("delayed");
        await db().integrationSyncState.updateMany({ where: { connectedAccountId: accountId }, data: { retryAfter: new Date(0) } });
        expect((await service.listCourses(owner.id, accountId)).items).toHaveLength(1);
        expect((await service.settings(owner.id)).accounts[0].health?.state).toBe("available");
    });
    it.each(["DISCONNECTED", "AUTHORIZATION_REQUIRED"] as const)("persists provider auth failure %s without repeating API calls", async code => {
        const list = vi.spyOn(provider, "listCourses").mockRejectedValueOnce(new AcademicIntegrationError(code));
        await expect(service.listCourses(owner.id, accountId)).rejects.toMatchObject({ code });
        await expect(service.listCourses(owner.id, accountId)).rejects.toMatchObject({ code }); expect(list).toHaveBeenCalledTimes(1);
        expect((await service.settings(owner.id)).accounts[0].health?.state).toBe(code === "DISCONNECTED" ? "needs-reconnect" : "missing-permission");
    });
    it("restores corrupt incremental checkpoints using stable mappings and a fresh snapshot", async () => {
        const linked = await imported(academicOnly); Object.assign(provider, { incremental: "updated-since" }); await sync();
        await db().integrationSyncState.updateMany({ where: { connectedAccountId: accountId }, data: { cursorEncrypted: "v1.retired.invalid" } });
        const assignments = vi.spyOn(provider, "listAssignments"); await sync();
        expect(assignments.mock.calls[0][1].updatedSince).toBeUndefined();
        expect(await db().assignment.count({ where: { courseId: linked.courseId } })).toBe(1);
        expect((await service.status(owner.id, linked.courseId))?.health?.state).toBe("available");
    });
    it("paginates 100 assignments and preserves mappings across repeated large syncs", async () => {
        provider.assignments.set("math", Array.from({ length: 100 }, (_, i) => ({ externalId: `a-${i}`, courseExternalId: "math", title: `Assignment ${i}`, dueAt: due(2) })));
        const linked = await imported(academicOnly); provider.calls.length = 0;
        await sync(); expect(provider.calls.filter(c => c === "assignments")).toHaveLength(4);
        expect(await db().assignment.count({ where: { courseId: linked.courseId } })).toBe(100);
        await sync(); expect(await db().externalAssignmentLink.count({ where: { externalCourseLinkId: linked.id } })).toBe(100);
    });
    it("retains academic data and planning context during provider outage and reconnect", async () => {
        const linked = await imported(academicOnly); await sync(); const assignment = await db().assignment.findFirstOrThrow({ where: { courseId: linked.courseId } });
        await db().assignment.update({ where: { id: assignment.id }, data: { priority: "HIGH", estimatedHours: 7 } });
        provider.failures.add("course"); await expect(sync()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
        const context = () => buildUserContext({ request: "Plan my week", courseId: linked.courseId, options: getStudyPlannerAgentDefinition().contextRequirements }, owner.headers);
        expect(JSON.stringify(await context())).toContain(assignment.title);
        provider.failures.clear(); const next = due(4); provider.assignments.get("math")![0].dueAt = next; await sync();
        expect(await db().assignment.findUnique({ where: { id: assignment.id } })).toMatchObject({ dueDate: new Date(next), priority: "HIGH", estimatedHours: 7 });
        expect(JSON.stringify(await context())).toContain(next);
        expect(await db().recommendation.count({ where: { userId: owner.id, sourceId: assignment.id } })).toBeGreaterThan(0);
        await service.disconnect(owner.id, accountId); expect(JSON.stringify(await context())).toContain(assignment.title);
        // Test provider reconnect restores the same account and source link.
        await db().connectedAccount.update({ where: { id: accountId }, data: { status: "ACTIVE", deniedCapabilities: [], credentialVersion: { increment: 1 } } });
        await db().externalCourseLink.update({ where: { id: linked.id }, data: { active: true } }); await sync();
        expect(await db().assignment.count({ where: { courseId: linked.courseId } })).toBe(1);
    });
    it("recovers an abandoned worker lease through the same manual sync path", async () => {
        const status = await imported(academicOnly); await sync();
        await db().integrationSyncState.updateMany({ where: { connectedAccountId: accountId }, data: { status: "SYNCING", leaseToken: "dead-worker", leaseUntil: new Date(0) } });
        await db().externalCourseLink.update({ where: { id: status.id }, data: { requestQueuedAt: new Date() } });
        expect(await service.status(owner.id, status.courseId)).toMatchObject({ status: "failed", pending: false });
        expect(await service.requestSync(owner.id, status.courseId)).toMatchObject({ status: "queued", pending: true });
        await sync();
        expect(await service.status(owner.id, status.courseId)).toMatchObject({ status: "synced", pending: false });
    });
    it("cancels before provider access and checks revocation after an in-flight read", async () => {
        await imported(academicOnly);
        const controller = new AbortController(); controller.abort(); provider.calls.length = 0;
        await expect(service.syncExternalCourse(owner.id, accountId, "math", controller.signal)).rejects.toThrow();
        expect(provider.calls).toHaveLength(0);
        provider.beforeCall = async kind => { if (kind === "assignments") await db().connectedAccount.update({ where: { id: accountId }, data: { scopes: ["courses-read", "assessments-read"] } }); };
        await sync();
        expect(await db().assignment.count({ where: { userId: owner.id } })).toBe(0);
        expect(await db().exam.count({ where: { userId: owner.id } })).toBe(1);
    });
    it("requires no OAuth credentials or encryption key for snapshot-only test imports", async () => {
        vi.stubEnv("INTEGRATION_TOKEN_KEYS", "");
        const status = await imported(academicOnly); await sync();
        expect((await service.status(owner.id, status.courseId))?.status).toBe("synced");
    });
    it("registers capabilities while keeping test providers out of production", async () => {
        expect(registry.get(provider.id)).toBe(provider);
        expect(registry.supports(provider.id, "files-read")).toBe(true);
        expect(registry.supports(provider.id, "announcements-read")).toBe(false);
        expect(() => registry.register(provider)).toThrow();
        expect(() => new AcademicProviderRegistry().register(provider)).toThrow();
        expect(academicProviderRegistry.list()).toEqual([]);
        expect((await createAcademicIntegrationService().settings(owner.id))).toEqual({ providers: [], accounts: [] });
        expect(await listConnectedAccounts(owner.id)).toEqual([]);
    });
    it("rejects advertised capabilities with no implementation", () => {
        const incomplete = Object.assign(new TestAcademicProvider(), { downloadFile: undefined });
        expect(() => new AcademicProviderRegistry(true).register(incomplete)).toThrow();
    });
    it("normalizes timezone offsets and rejects local or credential-bearing provider shapes", () => {
        expect(externalAssignmentSchema.parse({ ...provider.assignments.get("math")![0], dueAt: "2026-11-01T01:30:00-05:00" }).dueAt).toBe("2026-11-01T06:30:00.000Z");
        expect(externalAssignmentSchema.safeParse({ ...provider.assignments.get("math")![0], dueAt: "2026-11-01T01:30:00" }).success).toBe(false);
        expect(externalCourseSchema.parse({ ...provider.courses.get("math"), provider: provider.id, connectedAccountId: accountId }).code).toBe("MATH 1240 A01");
        expect(externalAssessmentSchema.parse(provider.assessments.get("math")![0]).assessmentType).toBe("midterm");
        expect(externalCourseFileSchema.safeParse({ ...provider.files.get("math")![0], accessToken: "secret" }).success).toBe(false);
        expect(safeAcademicUrl("javascript:alert(1)")).toBeNull();
        expect(safeAcademicUrl("https://secret:password@institution.example/")).toBeNull();
    });
    it("applies explicit major-assessment and supported-file mapping policies", () => {
        expect(examImportReason(provider.assessments.get("math")![0])).toBeNull();
        expect(examImportReason(provider.assessments.get("math")![1])).toMatch(/Small quizzes/);
        expect(examImportReason(provider.assessments.get("math")![2])).toMatch(/date/);
        const file = provider.files.get("math")![0];
        expect(fileImportReason(file)).toBeNull();
        expect(fileImportReason({ ...file, size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
        expect(fileImportReason({ ...file, name: "../lecture.pdf" })).toMatch(/Filename/);
        expect(fileImportReason({ ...file, name: "archive.zip", mimeType: "application/zip" })).toMatch(/Supported/);
    });
    it("lists bounded courses only from the authenticated account", async () => {
        for (let i = 0; i < 30; i++)
            provider.courses.set(`c${i}`, { externalId: `c${i}`, name: `Course ${i}` });
        const first = await service.listCourses(owner.id, accountId);
        expect(first.items).toHaveLength(25);
        expect((await service.listCourses(owner.id, accountId, first.nextCursor)).items).toHaveLength(6);
        expect(JSON.stringify(first)).not.toMatch(/secret|scopes|connectionConfig/);
        await expect(service.listCourses(other.id, accountId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it("checks granted capabilities before reading selected categories", async () => {
        await db().connectedAccount.update({ where: { id: accountId }, data: { scopes: ["courses-read", "assignments-read"] } });
        await expect(service.preview(owner.id, input())).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
        expect(provider.calls).not.toContain("assessments");
        expect((await service.preview(owner.id, input({ assignments: true, assessments: false, files: false }))).counts.assignments).toBe(1);
    });
    it("shows selected preview counts and skipped reasons without writes or downloads", async () => {
        const preview = await service.preview(owner.id, input());
        expect(preview.counts).toEqual({ assignments: 1, assessments: 1, files: 1, skipped: 3 });
        expect(preview.skippedReasons).toHaveLength(3);
        expect(provider.calls.some(c => c.startsWith("download:"))).toBe(false);
        expect(await db().course.count({ where: { userId: owner.id } })).toBe(0);
    });
    it("requires an explicit choice for ambiguous matches and never merges sections", async () => {
        const one = await localCourse(), two = await localCourse();
        const preview = await service.preview(owner.id, input(academicOnly));
        expect(preview.ambiguous).toBe(true);
        expect(preview.suggestions.map(c => c.courseId)).toEqual(expect.arrayContaining([one.id, two.id]));
        const different = courseMatches({ ...preview.course, name: "Another subject", code: "MATH 1240 A02" }, [one]);
        expect(different).toEqual([]);
        const status = await imported(academicOnly, two.id);
        expect(status.courseId).toBe(two.id);
        expect(await db().course.count({ where: { userId: owner.id } })).toBe(2);
        expect((await db().course.findUniqueOrThrow({ where: { id: two.id } })).description).toBe("Personal description");
    });
    it("binds confirmation to user, course, options and fresh provider data", async () => {
        const confirmed = await confirmation();
        await expect(service.importExternalCourse(owner.id, { ...confirmed, options: academicOnly })).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
        provider.assignments.get("math")![0].title = "Changed after preview";
        await expect(service.importExternalCourse(owner.id, confirmed)).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
        expect(() => verifyPreview(previewToken({ user: owner.id }, Date.now() - 700000), { user: owner.id })).toThrow();
        expect(() => verifyPreview(previewToken({ user: owner.id }), { user: other.id })).toThrow();
        expect(() => verifyPreview(`${confirmed.previewToken}tampered`, {})).toThrow();
        expect(await db().course.count({ where: { userId: owner.id } })).toBe(0);
    });
    it("atomically creates a course and one job; concurrent confirmation is idempotent", async () => {
        const confirmed = await confirmation(academicOnly);
        const [first, second] = await Promise.all([service.importExternalCourse(owner.id, confirmed), service.importExternalCourse(owner.id, confirmed)]);
        expect(first?.courseId).toBe(second?.courseId);
        expect(queued).toHaveLength(1);
        expect(first?.status).toBe("queued");
        const course = await db().course.findUniqueOrThrow({ where: { id: first!.courseId } });
        expect(course).toMatchObject({ courseCode: "MATH 1240 A01", professor: "Professor Test" });
        expect(queued[0].data).not.toHaveProperty("userId");
        expect(queued[0].options).toMatchObject({ retryLimit: 2, expireInSeconds: 600, group: { id: first!.id } });
    });
    it("rolls back course and source mapping if job publication fails", async () => {
        const failed = createAcademicIntegrationService({ registry, enqueue: async () => { throw Error("Queue unavailable"); } });
        await expect(failed.importExternalCourse(owner.id, await confirmation(academicOnly))).rejects.toThrow();
        expect(await db().course.count({ where: { userId: owner.id } })).toBe(0);
        expect(await db().externalCourseLink.count({ where: { userId: owner.id } })).toBe(0);
    });
    it("imports assignments and major exams into existing domain models", async () => {
        const status = await imported(academicOnly);
        await sync();
        const assignments = await db().assignment.findMany({ where: { courseId: status.courseId } });
        expect(assignments).toHaveLength(1);
        expect(assignments[0]).toMatchObject({ title: "Induction assignment", description: "Prove the induction step", status: "TODO", priority: "MEDIUM" });
        expect(await db().exam.findMany({ where: { courseId: status.courseId } })).toMatchObject([{ title: "Induction midterm", topics: ["Induction"] }]);
        expect((await service.status(owner.id, status.courseId))).toMatchObject({ status: "synced", pending: false, lastSuccessAt: expect.any(String), result: { created: { assignments: 1, assessments: 1, files: 0, skipped: 3 } } });
        expect(provider.calls).not.toContain("files");
    });
    it("preserves personal fields while external titles, descriptions and due dates change", async () => {
        const status = await imported(academicOnly);
        await sync();
        const assignment = await db().assignment.findFirstOrThrow({ where: { courseId: status.courseId } });
        const exam = await db().exam.findFirstOrThrow({ where: { courseId: status.courseId } });
        const completedAt = new Date();
        await db().assignment.update({ where: { id: assignment.id }, data: { priority: "HIGH", estimatedHours: 3, status: "COMPLETED", completedAt } });
        await db().exam.update({ where: { id: exam.id }, data: { notes: "My study notes", topics: ["Personal focus"] } });
        const newDue = "2026-10-04T23:59:00-05:00";
        Object.assign(provider.assignments.get("math")![0], { title: "Revised assignment", description: "Revised instructions", dueAt: newDue });
        Object.assign(provider.assessments.get("math")![0], { title: "Rescheduled midterm", dueAt: newDue, topics: ["Provider change"] });
        await sync();
        expect(await db().assignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ title: "Revised assignment", description: "Revised instructions", priority: "HIGH", estimatedHours: 3, status: "COMPLETED", completedAt, dueDate: new Date(newDue) });
        expect(await db().exam.findUniqueOrThrow({ where: { id: exam.id } })).toMatchObject({ title: "Rescheduled midterm", notes: "My study notes", topics: ["Personal focus"], examDate: new Date(newDue) });
        expect((await service.status(owner.id, status.courseId))?.result?.updated).toMatchObject({ assignments: 1, assessments: 1 });
    });
    it("deduplicates repeated sync including documents without another download", async () => {
        const status = await imported();
        await sync();
        provider.calls.length = 0;
        await sync();
        expect(await db().assignment.count({ where: { courseId: status.courseId } })).toBe(1);
        expect(await db().exam.count({ where: { courseId: status.courseId } })).toBe(1);
        expect(await db().document.count({ where: { courseId: status.courseId } })).toBe(1);
        expect(provider.calls).not.toContain("download:pdf");
        expect((await service.status(owner.id, status.courseId))?.result?.unchanged).toBe(2);
    });
    it("keeps local records when external sources disappear, then restores source status on reappearance", async () => {
        const status = await imported();
        await sync();
        const assignments = provider.assignments.get("math")!;
        provider.assignments.set("math", []);
        provider.assessments.set("math", []);
        provider.files.set("math", []);
        await service.requestSync(owner.id, status.courseId);
        await sync();
        expect((await service.status(owner.id, status.courseId))?.result?.missing).toBe(3);
        expect(await db().assignment.count({ where: { courseId: status.courseId } })).toBe(1);
        expect(await db().exam.count({ where: { courseId: status.courseId } })).toBe(1);
        const doc = await db().document.findFirstOrThrow({ where: { courseId: status.courseId } });
        expect((await fullDocumentText(owner.id, doc.id)).content).toContain("inductive hypothesis");
        provider.assignments.set("math", assignments);
        await sync();
        expect((await db().externalAssignmentLink.findFirstOrThrow({ where: { userId: owner.id } })).syncStatus).toBe("SYNCED");
    });
    it("does not invent a replacement date when a provider removes the original date", async () => {
        const status = await imported(academicOnly);
        await sync();
        const assignment = await db().assignment.findFirstOrThrow({ where: { courseId: status.courseId } });
        provider.assignments.get("math")![0].dueAt = null;
        provider.assessments.get("math")![0].assessmentType = "practice";
        await sync();
        expect((await db().assignment.findUniqueOrThrow({ where: { id: assignment.id } })).dueDate).toEqual(assignment.dueDate);
        expect((await db().externalAssignmentLink.findFirstOrThrow({ where: { userId: owner.id } })).syncStatus).toBe("UNSCHEDULED");
        expect((await db().externalExamLink.findFirstOrThrow({ where: { userId: owner.id } })).syncStatus).toBe("UNMAPPED");
        expect((await service.status(owner.id, status.courseId))?.result?.created.skipped).toBe(5);
    });
    it("isolates download failure and retries successfully without duplicating academic data", async () => {
        const status = await imported();
        provider.failures.add("download:pdf");
        await expect(sync()).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
        expect((await service.status(owner.id, status.courseId))).toMatchObject({ status: "partial", result: { failed: 1, created: { assignments: 1, assessments: 1 } } });
        provider.failures.clear();
        await sync();
        expect((await service.status(owner.id, status.courseId))?.status).toBe("synced");
        expect(await db().assignment.count({ where: { courseId: status.courseId } })).toBe(1);
        expect(await db().document.count({ where: { courseId: status.courseId } })).toBe(1);
    });
    it("does not mark missing objects when a category cannot be fully read", async () => {
        await imported(academicOnly);
        await sync();
        provider.failures.add("assignments");
        await expect(sync()).rejects.toThrow();
        expect((await db().externalAssignmentLink.findFirstOrThrow({ where: { userId: owner.id } })).syncStatus).toBe("SYNCED");
    });
    it("preserves the internal course during a whole-provider outage", async () => {
        const status = await imported(academicOnly);
        await sync();
        provider.failures.add("course");
        await expect(sync()).rejects.toThrow();
        expect((await service.status(owner.id, status.courseId))).toMatchObject({ status: "failed", result: { failed: 1 } });
        expect(await db().assignment.count({ where: { courseId: status.courseId } })).toBe(1);
    });
    it("serializes workers with an expiring per-course lease", async () => {
        await imported(academicOnly);
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
        provider.beforeCall = async (kind) => { if (kind === "assignments") {
            entered();
            await gate;
        } };
        const first = sync();
        await started;
        try {
            expect(await sync()).toMatchObject({ skipped: true });
        }
        finally {
            release();
        }
        await first;
        expect(await db().assignment.count({ where: { userId: owner.id } })).toBe(1);
    });
    it("uses encrypted updated-since checkpoints and does not treat deltas as snapshots", async () => {
        const status = await imported(academicOnly);
        Object.assign(provider, { incremental: "updated-since" });
        await sync();
        const state = await db().integrationSyncState.findFirstOrThrow({ where: { connectedAccountId: accountId } });
        const cursor = JSON.parse(getTokenEncryptionService().decrypt(state.cursorEncrypted!, credentialContext(owner.id, provider.id, state.id, "sync-cursor")));
        expect(cursor["assignments:since"]).toBe(state.lastSyncStartedAt?.toISOString());
        vi.spyOn(provider, "listAssignments").mockImplementation(async (_call, args) => { expect(args.updatedSince).toBe(cursor["assignments:since"]); return { items: [], mode: "delta" }; });
        await sync();
        expect((await db().externalAssignmentLink.findFirstOrThrow({ where: { externalCourseLinkId: status.id } })).syncStatus).toBe("SYNCED");
        vi.mocked(provider.listAssignments).mockResolvedValue({ items: [], mode: "delta", deletedIds: ["a1"] });
        await sync();
        expect((await db().externalAssignmentLink.findFirstOrThrow({ where: { externalCourseLinkId: status.id } })).syncStatus).toBe("MISSING");
    });
    it("supports opaque sync tokens without requiring them for snapshot-only adapters", async () => {
        await imported(academicOnly);
        Object.assign(provider, { incremental: "sync-token" });
        vi.spyOn(provider, "listAssignments").mockResolvedValue({ items: provider.assignments.get("math")!, mode: "snapshot", checkpoint: "private-cursor-token" });
        await sync();
        vi.mocked(provider.listAssignments).mockImplementation(async (_call, args) => { expect(args.syncToken).toBe("private-cursor-token"); return { items: [], mode: "delta", checkpoint: "next-cursor" }; });
        await sync();
        const state = await db().integrationSyncState.findFirstOrThrow({ where: { connectedAccountId: accountId } });
        expect(state.cursorEncrypted).not.toContain("private-cursor-token");
    });
    it("falls back once to a bounded snapshot when an incremental checkpoint expires", async () => {
        await imported(academicOnly);
        Object.assign(provider, { incremental: "sync-token" });
        vi.spyOn(provider, "listAssignments").mockResolvedValue({ items: provider.assignments.get("math")!, mode: "snapshot", checkpoint: "expired" });
        await sync();
        const requests: (string | undefined)[] = [];
        vi.mocked(provider.listAssignments).mockImplementation(async (_call, args) => {
            requests.push(args.syncToken);
            if (args.syncToken)
                throw new AcademicIntegrationError("SYNC_CHECKPOINT_EXPIRED");
            return { items: provider.assignments.get("math")!, mode: "snapshot", checkpoint: "fresh" };
        });
        await sync();
        expect(requests).toEqual(["expired", undefined]);
        expect(await db().assignment.count({ where: { userId: owner.id } })).toBe(1);
    });
    it("bounds pagination and rejects repeated cursors, duplicate IDs and conflicting deltas", async () => {
        const schema = z.object({ externalId: z.string() });
        await expect(collectAcademic(schema, async () => ({ items: [{ externalId: randomUUID() }], mode: "snapshot", nextCursor: "again" }))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
        await expect(collectAcademic(schema, async () => ({ items: [{ externalId: "same" }, { externalId: "same" }], mode: "snapshot" }))).rejects.toThrow();
        await expect(collectAcademic(schema, async () => ({ items: [{ externalId: "both" }], deletedIds: ["both"], mode: "delta" }))).rejects.toThrow();
        await expect(collectAcademic(schema, async () => ({ items: [{ externalId: "1" }, { externalId: "2" }], mode: "snapshot" }), 1)).rejects.toMatchObject({ code: "LIMIT" });
        let page = 0;
        await expect(collectAcademic(schema, async () => ({ items: [], mode: "snapshot", nextCursor: String(++page) }))).rejects.toMatchObject({ code: "LIMIT" });
    });
    it("rejects mismatched course identities before internal writes", async () => {
        await imported(academicOnly);
        vi.spyOn(provider, "listAssignments").mockResolvedValue({ items: [{ ...provider.assignments.get("math")![0], courseExternalId: "unselected-course" }], mode: "snapshot" });
        await sync();
        expect(await db().assignment.count({ where: { userId: owner.id } })).toBe(0);
        expect(await db().exam.count({ where: { userId: owner.id } })).toBe(1);
    });
    it.each(["pdf", "txt", "md"])("imports %s through real extraction, chunking, embeddings and owned RAG", async (extension) => {
        const file = provider.files.get("math")![0];
        if (extension !== "pdf") {
            file.name = `Lecture.${extension}`;
            file.mimeType = extension === "md" ? "text/markdown" : "text/plain";
            provider.contents.set("pdf-content", new TextEncoder().encode(inductionPages.flat().join("\n")));
        }
        const status = await imported(filesOnly);
        await sync();
        const doc = await db().document.findFirstOrThrow({ where: { courseId: status.courseId } });
        expect(doc.processingStatus).toBe("READY");
        expect(await db().documentChunk.count({ where: { documentId: doc.id } })).toBeGreaterThan(0);
        const sources = await retrieveAcademicContext(owner.id, { query: "mathematical induction base case", courseId: status.courseId, documentIds: [doc.id] });
        expect(sources[0]).toMatchObject({ documentId: doc.id, documentTitle: file.name, pageNumber: expect.any(Number) });
        expect((await getDocument(owner.id, doc.id)).externalFileLink?.provider).toBe(provider.id);
        await expect(retrieveAcademicContext(other.id, { query: "mathematical induction", documentIds: [doc.id] })).rejects.toThrow();
        expect(ai.getAIProvider).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each([getTutorAgentDefinition(), getNotesAgentDefinition(), getQuizAgentDefinition()])("feeds imported sources to $id using its unchanged Context Builder", async (agent) => {
        const status = await imported(filesOnly);
        await sync();
        const doc = await db().document.findFirstOrThrow({ where: { courseId: status.courseId } });
        const context = await buildUserContext({ request: "Explain the mathematical induction base case", courseId: status.courseId, documentIds: [doc.id], options: agent.contextRequirements }, owner.headers);
        expect(JSON.stringify(context.documents)).toContain("Lecture.pdf");
        expect(context.documents?.length).toBeGreaterThan(0);
        expect(ai.getAIProvider).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it("atomically replaces changed files while keeping document identity and personal title", async () => {
        const status = await imported(filesOnly);
        await sync();
        const doc = await db().document.findFirstOrThrow({ where: { courseId: status.courseId } });
        await db().document.update({ where: { id: doc.id }, data: { title: "My lecture notes" } });
        const oldChunks = await db().documentChunk.findMany({ where: { documentId: doc.id }, select: { id: true } });
        provider.files.get("math")![0].modifiedAt = "2026-09-19T13:00:00.000Z";
        provider.contents.set("pdf-content", textPdf([["Updated induction proof requires a base case, an inductive hypothesis and the successor step."]]));
        await service.requestSync(owner.id, status.courseId);
        await sync();
        expect((await getDocument(owner.id, doc.id))).toMatchObject({ title: "My lecture notes", processingStatus: "READY" });
        expect((await fullDocumentText(owner.id, doc.id)).content).toContain("Updated induction");
        expect(await db().documentChunk.count({ where: { id: { in: oldChunks.map(c => c.id) } } })).toBe(0);
        await expect(storage.get(doc.storageKey)).rejects.toThrow();
        expect(await db().document.count({ where: { courseId: status.courseId } })).toBe(1);
    });
    it("keeps the usable previous document if a changed PDF is invalid", async () => {
        const status = await imported(filesOnly);
        await sync();
        const doc = await db().document.findFirstOrThrow({ where: { courseId: status.courseId } });
        provider.files.get("math")![0].modifiedAt = "2026-09-19T14:00:00.000Z";
        provider.contents.set("pdf-content", new TextEncoder().encode("%PDF-broken"));
        await service.requestSync(owner.id, status.courseId);
        await sync();
        expect((await getDocument(owner.id, doc.id)).processingStatus).toBe("READY");
        expect((await fullDocumentText(owner.id, doc.id)).content).toContain("inductive hypothesis");
        expect((await db().document.findUniqueOrThrow({ where: { id: doc.id } })).storageKey).toBe(doc.storageKey);
        expect((await db().externalFileLink.findUniqueOrThrow({ where: { documentId: doc.id } })).syncStatus).toBe("FAILED");
    });
    it("recovers a failed initial processing run even when source modification time is unchanged", async () => {
        const status = await imported(filesOnly);
        const embed = vi.spyOn(embeddingProvider, "generateEmbedding").mockRejectedValueOnce(Error("Embedding unavailable"));
        await sync();
        embed.mockRestore();
        const doc = await db().document.findFirstOrThrow({ where: { courseId: status.courseId } });
        expect(doc.processingStatus).toBe("FAILED");
        await sync();
        expect((await getDocument(owner.id, doc.id)).processingStatus).toBe("READY");
        expect(await db().document.count({ where: { courseId: status.courseId } })).toBe(1);
    });
    it("rejects a source version that changes during download", async () => {
        await imported(filesOnly);
        provider.beforeCall = async (kind) => { if (kind === "download:pdf")
            provider.files.get("math")![0].modifiedAt = "2026-09-19T15:00:00.000Z"; };
        await sync();
        expect(await db().document.count({ where: { userId: owner.id } })).toBe(0);
    });
    it("stops in-flight downloads on disconnect and preserves already imported assignments", async () => {
        const status = await imported();
        provider.beforeCall = async (kind) => { if (kind === "download:pdf")
            await service.disconnect(owner.id, accountId); };
        await expect(sync()).rejects.toMatchObject({ code: "DISCONNECTED" });
        expect(await db().document.count({ where: { courseId: status.courseId } })).toBe(0);
        expect(await db().assignment.count({ where: { courseId: status.courseId } })).toBe(1);
        expect((await service.status(owner.id, status.courseId))?.status).toBe("paused");
        const count = provider.calls.length;
        await expect(sync()).rejects.toMatchObject({ code: "DISCONNECTED" });
        expect(provider.calls).toHaveLength(count);
    });
    it("preserves imported course, deadlines and searchable documents after disconnect", async () => {
        const status = await imported();
        await sync();
        const doc = await db().document.findFirstOrThrow({ where: { courseId: status.courseId } });
        await service.disconnect(owner.id, accountId);
        expect((await fullDocumentText(owner.id, doc.id)).content).toContain("inductive hypothesis");
        await expect(service.requestSync(owner.id, status.courseId)).rejects.toMatchObject({ code: "DISCONNECTED" });
        const account = await db().connectedAccount.findUniqueOrThrow({ where: { id: accountId } });
        expect(account).toMatchObject({ status: "REVOKED", accessTokenEncrypted: null, refreshTokenEncrypted: null });
    });
    it("rejects cross-user account, course, import, status, sync and disconnect requests", async () => {
        const foreignCourse = await localCourse(other.id), status = await imported(academicOnly);
        await expect(service.preview(other.id, input())).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(service.importExternalCourse(owner.id, await confirmation(all, foreignCourse.id))).rejects.toThrow();
        await expect(service.status(other.id, status.courseId)).rejects.toThrow();
        await expect(service.requestSync(other.id, status.courseId)).rejects.toThrow();
        await expect(service.syncExternalCourse(other.id, accountId, "math")).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(service.disconnect(other.id, accountId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it("enforces user-owned mapping foreign keys in the database", async () => {
        const status = await imported(academicOnly), foreignCourse = await localCourse(other.id);
        const foreignAssignment = await db().assignment.create({ data: { userId: other.id, courseId: foreignCourse.id, title: "Private", dueDate: new Date(due(1)) } });
        const foreignExam = await db().exam.create({ data: { userId: other.id, courseId: foreignCourse.id, title: "Private", examDate: new Date(due(1)) } });
        await expect(db().externalAssignmentLink.create({ data: { userId: owner.id, externalCourseLinkId: status.id, externalId: "stolen", assignmentId: foreignAssignment.id } })).rejects.toThrow();
        await expect(db().externalExamLink.create({ data: { userId: owner.id, externalCourseLinkId: status.id, externalId: "stolen", examId: foreignExam.id } })).rejects.toThrow();
        await expect(db().externalCourseLink.create({ data: { userId: owner.id, connectedAccountId: accountId, provider: provider.id, externalId: "foreign", courseId: foreignCourse.id, options: all } })).rejects.toThrow();
    });
    it("cleans source mappings on local course deletion without resurrecting it", async () => {
        const status = await imported();
        await sync();
        const doc = await db().document.findFirstOrThrow({ where: { courseId: status.courseId } });
        await db().course.delete({ where: { id: status.courseId } });
        await cleanupFiles(owner.id);
        expect(await db().externalCourseLink.count({ where: { id: status.id } })).toBe(0);
        expect(await db().externalFileLink.count({ where: { documentId: doc.id } })).toBe(0);
        await expect(sync()).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(storage.get(doc.storageKey)).rejects.toThrow();
    });
    it("reuses the manual job path and respects slower scheduled file polling", async () => {
        const status = await imported();
        await sync();
        queued.length = 0;
        provider.calls.length = 0;
        await service.requestSync(owner.id, status.courseId, true);
        await sync();
        expect(provider.calls).toContain("assignments");
        expect(provider.calls).not.toContain("files");
        provider.calls.length = 0;
        await service.requestSync(owner.id, status.courseId);
        await service.requestSync(owner.id, status.courseId);
        await sync();
        expect(provider.calls).toContain("files");
        expect(queued).toHaveLength(2);
        expect(academicSyncConfig().intervalMs).toBeGreaterThanOrEqual(30 * 60000);
    });
    it("schedules only active, due courses and excludes historical terms", async () => {
        const status = await imported(academicOnly);
        await sync();
        queued.length = 0;
        const sweep = createAcademicSyncSweep(service, registry), args = { payload: { version: 1 as const }, signal: signal(), attempt: 1, jobRunId: "sweep" };
        expect(await sweep.handler(args)).toMatchObject({ enqueued: 0 });
        await db().externalCourseLink.update({ where: { id: status.id }, data: { nextSyncAt: new Date(0), externalEndsAt: new Date(0) } });
        expect(await sweep.handler(args)).toMatchObject({ enqueued: 0 });
        await db().externalCourseLink.update({ where: { id: status.id }, data: { externalEndsAt: null } });
        expect(await sweep.handler(args)).toMatchObject({ enqueued: 1 });
        await service.disconnect(owner.id, accountId);
        expect(await sweep.handler(args)).toMatchObject({ enqueued: 0 });
        expect(queued).toHaveLength(1);
    });
    it("executes the owned job through the existing executor and retries transient failures", async () => {
        const status = await imported(academicOnly), job = createExternalCourseSyncJob(service);
        expect(getBackgroundJob(job.name)?.name).toBe("sync-external-course");
        expect(job.payloadSchema.safeParse({ ...queued[0].data, userId: other.id }).success).toBe(false);
        provider.failures.add("assignments");
        const run = { id: queued[0].options!.id!, name: job.name, data: queued[0].data, retryCount: 0, retryLimit: 2, signal: signal() };
        expect(await executeBackgroundJob(job, run)).toMatchObject({ status: "failed", output: { retryable: true, errorCode: "TRANSIENT_PROVIDER_ERROR" } });
        provider.failures.clear();
        expect((await executeBackgroundJob(job, { ...run, retryCount: 1 })).status).toBe("completed");
        expect((await service.status(owner.id, status.courseId))?.status).toBe("synced");
        expect(await db().exam.count({ where: { courseId: status.courseId } })).toBe(1);
    });
    it.each([["PROVIDER_UNAVAILABLE", true], ["STORAGE_FAILURE", true], ["AUTHORIZATION_REQUIRED", false], ["DISCONNECTED", false], ["INVALID_RESPONSE", false], ["NOT_FOUND", false], ["LIMIT", false]] as const)("classifies %s retries without leaking upstream content", (code, retryable) => {
        expect(normalizeBackgroundJobError(new AcademicIntegrationError(code)).retryable).toBe(retryable);
    });
    it("commits and fetches a real pg-boss course sync in the same import transaction", async () => {
        const schema = `lms_jobs_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        vi.stubEnv("BACKGROUND_JOB_SCHEMA", schema);
        vi.stubEnv("BACKGROUND_JOB_SCHEDULE_ENABLED", "false");
        const boss = await createBackgroundJobBoss("worker", { schema }).start();
        try {
            await ensureBackgroundJobQueues(boss);
            service = createAcademicIntegrationService({ registry, enqueue: async (tx, link) => { resources.push(link.id); await enqueueExternalCourseSync(tx, link, boss); } });
            const status = await imported(academicOnly), job = createExternalCourseSyncJob(service);
            const jobs = await boss.fetch<Parameters<typeof job.handler>[0]["payload"]>(job.name, { includeMetadata: true });
            expect(jobs).toHaveLength(1);
            expect(jobs[0].data).not.toHaveProperty("userId");
            expect((await executeBackgroundJob(job, { ...jobs[0], signal: signal() })).status).toBe("completed");
            expect((await service.status(owner.id, status.courseId))?.status).toBe("synced");
        }
        finally {
            await boss.stop({ graceful: true, timeout: 5000 });
            await db().$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
        }
    });
    it("feeds imported deadlines to Planner, recommendations and reminders without LMS-specific logic", async () => {
        const status = await imported(academicOnly);
        await sync();
        const assignment = await db().assignment.findFirstOrThrow({ where: { courseId: status.courseId } });
        const exam = await db().exam.findFirstOrThrow({ where: { courseId: status.courseId } });
        const context = await buildUserContext({ request: "Plan my exam preparation", courseId: status.courseId, options: getStudyPlannerAgentDefinition().contextRequirements }, owner.headers);
        expect(context.assignments?.some(item => item.id === assignment.id)).toBe(true);
        expect(context.exams?.some(item => item.id === exam.id)).toBe(true);
        const brief = createPlanningBrief(context, { request: "Plan my week", mode: "create" });
        expect(JSON.stringify(brief)).toContain(assignment.id);
        expect(JSON.stringify(brief)).toContain(exam.id);
        expect(await db().recommendation.count({ where: { userId: owner.id, sourceId: { in: [assignment.id, exam.id] } } })).toBeGreaterThan(0);
        expect(await db().reminder.count({ where: { userId: owner.id, sourceId: { in: [assignment.id, exam.id] } } })).toBeGreaterThan(0);
        expect(ai.getAIProvider).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it("uses authenticated HTTP handlers, origin checks and safe error responses", async () => {
        const routes = createAcademicHttp(service);
        const request = (body?: unknown, actor = owner, method = "POST") => new Request("http://localhost:3000/api/student/academic-integrations/preview", { method, headers: actor.headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        expect((await routes.preview(request(input()))).status).toBe(200);
        const unlinked = await localCourse();
        expect(await (await routes.status(request(undefined, owner, "GET"), unlinked.id)).json()).toBeNull();
        expect((await routes.preview(request({ ...input(), userId: other.id }))).status).toBe(400);
        expect((await routes.preview(request(input(), other))).status).toBe(404);
        const evil = request(input());
        evil.headers.set("origin", "https://evil.example");
        expect((await routes.preview(evil)).status).toBe(403);
        expect((await routes.settings(new Request("http://localhost:3000/api/student/academic-integrations"))).status).toBe(401);
        vi.spyOn(provider, "getCourse").mockRejectedValue(Error("private upstream credential and body"));
        const response = await routes.preview(request(input()));
        expect(response.status).toBe(503);
        expect(await response.text()).not.toMatch(/credential|private upstream/);
    });
    it("validates provider configuration and permits injected non-OAuth credentials only server-side", async () => {
        const use = vi.fn(async (operation: (credential: string) => Promise<string>) => operation("server-secret"));
        const access = academicAccess(registry, () => ({ use } as never));
        const output = await access.call(owner.id, accountId, "courses-read", signal(), call => call.credentials.use(async (secret) => secret === "server-secret" ? "authorized" : "denied"));
        expect(output).toBe("authorized");
        expect(use).toHaveBeenCalledOnce();
        await db().connectedAccount.update({ where: { id: accountId }, data: { connectionConfig: { apiToken: "not-allowed" } } });
        await expect(service.listCourses(owner.id, accountId)).rejects.toMatchObject({ code: "CONFIGURATION" });
    });
    it("runs Lecture Study through existing Notes, Tutor and Quiz with imported PDF citations", async () => {
        const status = await imported(filesOnly);
        await sync();
        const document = await db().document.findFirstOrThrow({ where: { courseId: status.courseId } });
        const calls: string[] = [], prompts: string[] = [];
        const boundary: AIProvider = {
            async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
                calls.push(request.schemaName);
                prompts.push(JSON.stringify(request.messages));
                const params = JSON.parse(request.messages[0].content.split("Execution parameters: ")[1] ?? "{}");
                let data: unknown;
                if (request.schemaName === "study_notes")
                    data = { title: "Induction notes", focusCovered: true, topics: ["Mathematical Induction"], concepts: [{ topic: "Mathematical Induction", complexity: "advanced", keyIdea: "Prove the base case and inductive step.", definitions: ["Assume the inductive hypothesis P(k)."], formulasOrProcedures: ["P(1); P(k) implies P(k+1)."], notes: "The base case starts the chain of implications.", sourceIndices: [0] }] };
                else if (request.schemaName === "lecture_explanation")
                    data = { explanations: params.targets.map((topic: string) => ({ topic, explanation: "Establish a base case then prove the successor step.", workedExample: "Prove a sum formula by adding its next term.", understandingCheck: "Where is the hypothesis used?", sourceIndices: [0] })) };
                else if (request.schemaName === "quiz_generation")
                    data = { quizTitle: "Induction practice", topic: "Mathematical Induction", difficulty: params.difficulty, questions: Array.from({ length: params.count }, (_, i) => ({ type: i % 2 ? "short-answer" : "true-false", prompt: `Question ${i + 1}: Explain the base case in mathematical induction.`, choices: i % 2 ? null : ["True", "False"], correctAnswer: "true", explanation: "The base case starts the chain of implications.", topics: ["Mathematical Induction"] })) };
                else
                    throw Error("Unexpected generation");
                return { id: "lms-fixture", model: "test", text: JSON.stringify(data), data: request.schema.parse(data) };
            }, generateText() { throw Error("Unexpected text generation"); }, streamText() { throw Error("Unexpected stream"); }, generateEmbedding() { throw Error("Use the existing local RAG"); },
        };
        const run = await new WorkflowService({ getProvider: () => boundary, conversationEmbeddingProvider: null }).runWorkflow({ workflowId: "lecture-study", goal: "Help me study mathematical induction in this lecture", courseId: status.courseId, documentIds: [document.id], mode: "deep-study" }, owner.headers);
        expect(run, JSON.stringify(run)).toMatchObject({ status: "waiting-for-input", completedSteps: ["notes", "tutor", "quiz"] });
        expect(calls).toEqual(["study_notes", "lecture_explanation", "quiz_generation"]);
        expect(prompts.every(p => p.includes("Lecture.pdf"))).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
    });
    it("runs Assignment Support on imported official instructions and selected course files", async () => {
        provider.assignments.get("math")![0].description = "Prove the sum formula using mathematical induction. Include a base case. Explain the inductive step. Submit one PDF.";
        const status = await imported();
        await sync();
        const document = await db().document.findFirstOrThrow({ where: { courseId: status.courseId } });
        const assignment = await db().assignment.findFirstOrThrow({ where: { courseId: status.courseId } });
        const requests: AIStructuredRequest<unknown>[] = [];
        const boundary: AIProvider = {
            async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
                requests.push(request as AIStructuredRequest<unknown>);
                const params = JSON.parse(request.messages[0].content.split("Execution parameters: ")[1]);
                const data = request.schemaName === "assignment_analysis" ? {
                    objective: "Prove the sum formula by induction.", objectiveQuote: "Prove the sum formula using mathematical induction.",
                    deliverables: [{ text: "Provide the base case.", instructionQuote: "Include a base case." }, { text: "Explain the inductive step.", instructionQuote: "Explain the inductive step." }],
                    constraints: [{ text: "Submit one PDF.", instructionQuote: "Submit one PDF." }],
                    requiredConcepts: ["Mathematical Induction"], subtasks: [{ title: "Establish the base case", deliverableIndices: [0], estimatedMinutes: 40 }, { title: "Derive the inductive step", deliverableIndices: [1], estimatedMinutes: 50 }], nextAction: "Write the base case before the inductive step.",
                } : { explanation: "Induction starts with a base case, then derives P(k+1) from P(k). Add the next term and simplify.", nextAction: "Write the base case and show where your inductive hypothesis applies.", sourceIndices: params.sourceCatalog?.length ? [0] : [] };
                return { id: "lms-assignment", model: "test", text: JSON.stringify(data), data: request.schema.parse(data) };
            }, generateText() { throw Error("Unexpected text generation"); }, streamText() { throw Error("Unexpected stream"); }, generateEmbedding() { throw Error("Use existing RAG"); },
        };
        const run = await new WorkflowService({ getProvider: () => boundary, conversationEmbeddingProvider: null }).runWorkflow({ workflowId: "assignment-support", assignmentId: assignment.id, documentIds: [document.id], goal: "Explain mathematical induction for this problem." }, owner.headers);
        expect(run, JSON.stringify(run)).toMatchObject({ status: "waiting-for-input" });
        expect(run.outputs["assignment-help"]).toMatchObject({ sources: [expect.objectContaining({ documentId: document.id, pageNumber: expect.any(Number) })] });
        expect(JSON.stringify(requests)).toContain(assignment.description);
        expect(JSON.stringify(requests)).toContain("Lecture.pdf");
        expect(fetch).not.toHaveBeenCalled();
    });
});
