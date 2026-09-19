import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendOptions } from "pg-boss";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { GOOGLE_SCOPES, GoogleIntegrationProvider } from "@/server/integrations/google";
import { getTokenEncryptionService, credentialContext } from "@/server/integrations/encryption";
import { disconnectConnectedAccount, startIntegrationConnection } from "@/server/integrations/service";
import { IntegrationError } from "@/server/integrations/errors";
import { googleDriveService as drive, safeDriveLink } from "@/server/drive/google";
import { requestDriveImport, importDriveFile, requestDriveRefresh, checkExternalFileFreshness, listDriveImports, getDriveSettings, type DriveEnqueue } from "@/server/drive/service";
import { createDriveHttp } from "@/server/drive/http";
import { MAX_FILE_BYTES } from "@/server/documents/config";
import { processNextDocument } from "@/server/documents/processor";
import { embeddingProvider } from "@/server/documents/embeddings";
import { storage } from "@/server/documents/storage/local";
import { cleanupFiles } from "@/server/documents/cleanup";
import { getDocument, deleteDocument } from "@/server/documents/service";
import { fullDocumentText, retrieveAcademicContext } from "@/server/documents/retrieval";
import { buildUserContext } from "@/server/context/builder";
import { getTutorAgentDefinition } from "@/server/agents/tutor/definition";
import { getNotesAgentDefinition } from "@/server/agents/notes/definition";
import { getQuizAgentDefinition } from "@/server/agents/quiz/definition";
import { WorkflowService } from "@/server/workflows";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import { importGoogleDriveFileJob, enqueueDriveImport } from "@/server/jobs/import-google-drive-file";
import { normalizeBackgroundJobError } from "@/server/jobs/errors";
import { executeBackgroundJob } from "@/server/jobs/executor";
import { createBackgroundJobBoss } from "@/server/jobs/client";
import { ensureBackgroundJobQueues } from "@/server/jobs/queue";
import { getBackgroundJob } from "@/server/jobs/registry";
import { inductionPages, textPdf } from "./fixtures/documents";
import type { DriveResource } from "@/lib/student/drive/types";
type Actor = {
    id: string;
    headers: Headers;
};
let owner: Actor, other: Actor, courseId: string, secondCourse: string, foreignCourse: string, accountId: string;
let http: ReturnType<typeof vi.fn<typeof fetch>>;
type WireFile = {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    size?: string;
    webViewLink?: string;
    parents?: string[];
    trashed?: boolean;
    capabilities?: {
        canDownload: boolean;
    };
};
let files: Map<string, WireFile>, bytes: Map<string, Uint8Array>, failure: number, listPage: number;
let downloadHook: (() => Promise<void>) | undefined;
const jobIds: string[] = [];
let queued: {
    name: string;
    data: object | null;
    options: SendOptions | null;
}[];
const publisher = { async send(name: string, data?: object | null, options?: SendOptions) { queued.push({ name, data: data ?? null, options: options ?? null }); return options?.id ?? randomUUID(); } };
const publish: DriveEnqueue = async (tx, link) => { jobIds.push(link.id); await enqueueDriveImport(tx, link, publisher); };
const routes = createDriveHttp(publish);
async function actor(): Promise<Actor> {
    const response = await auth().api.signUpEmail({ body: { name: "Drive Student", email: `drive-${randomUUID()}@example.test`, password: "Drive-test-passphrase-2026!" }, asResponse: true });
    expect(response.status).toBe(200);
    const { user } = await response.json() as {
        user: {
            id: string;
        };
    };
    await db().profile.create({ data: { userId: user.id, school: "Test", program: "Math", currentYear: 1, semester: "Fall 2026", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
    return { id: user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map(x => x.split(";")[0]).join("; "), origin: "http://localhost:3000", "content-type": "application/json" }) };
}
async function account(userId = owner.id, scopes = [...GOOGLE_SCOPES["account-profile"], ...GOOGLE_SCOPES["drive-read"]]) {
    const id = randomUUID();
    return db().connectedAccount.create({ data: { id, userId, provider: "google", providerAccountId: randomUUID(), scopes, accessTokenEncrypted: getTokenEncryptionService().encrypt("drive-test-secret-access", credentialContext(userId, "google", id, "access")), accessTokenExpiresAt: new Date(Date.now() + 3600000) } });
}
function resource(fileId = "pdf", course = courseId): DriveResource { return { connectedAccountId: accountId, externalFileId: fileId, courseId: course }; }
async function requested(fileId = "pdf", course = courseId) { return requestDriveImport(owner.id, resource(fileId, course), publish); }
async function imported(fileId = "pdf", course = courseId, process = true) {
    await requested(fileId, course);
    const result = await importDriveFile({ userId: owner.id, ...resource(fileId, course) });
    expect(result.documentId).toBeTruthy();
    if (process)
        await processNextDocument(undefined, result.documentId!);
    return result.documentId!;
}
const request = (user = owner, body?: unknown, method = "POST") => new Request("http://localhost:3000/api/student/drive/imports", { method, headers: user.headers, ...(body ? { body: JSON.stringify(body) } : {}) });
function change(fileId = "pdf", text = "Updated mathematical induction requires a valid base case and an inductive hypothesis.") { files.get(fileId)!.modifiedTime = "2026-09-19T13:00:00.000Z"; bytes.set(fileId, textPdf([[text]])); }
const downloads = () => http.mock.calls.filter(([url]) => /alt=media|\/export\?/.test(String(url)));
async function cleanup() { await db().document.deleteMany({ where: { userId: { in: [owner.id, other.id] } } }); for (const user of [owner, other])
    await cleanupFiles(user.id); }
beforeAll(async () => {
    owner = await actor();
    other = await actor();
    const makeCourse = async (userId: string, code: string) => (await db().course.create({ data: { userId, courseCode: code, courseName: "Mathematical Induction", semester: "Fall 2026" } })).id;
    courseId = await makeCourse(owner.id, "MATH1240");
    secondCourse = await makeCourse(owner.id, "MATH2000");
    foreignCourse = await makeCourse(other.id, "OTHER");
});
beforeEach(async () => {
    vi.stubEnv("INTEGRATION_TOKEN_KEYS", JSON.stringify({ v1: randomBytes(32).toString("base64") }));
    vi.stubEnv("GOOGLE_INTEGRATION_CLIENT_ID", "drive-test-client");
    vi.stubEnv("GOOGLE_INTEGRATION_CLIENT_SECRET", "drive-test-secret");
    await cleanup();
    await db().connectedAccount.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    accountId = (await account()).id;
    queued = [];
    failure = 0;
    listPage = 0;
    downloadHook = undefined;
    files = new Map();
    bytes = new Map();
    for (const [id, name, mime] of [["pdf", "Lecture.pdf", "application/pdf"], ["txt", "Notes.txt", "text/plain"], ["md", "Notes.md", "text/markdown"], ["doc", "Google lecture", "application/vnd.google-apps.document"], ["bad", "program.exe", "application/octet-stream"], ["folder", "Lectures", "application/vnd.google-apps.folder"]]) {
        const content = ["txt", "md"].includes(id) ? new TextEncoder().encode(inductionPages.flat().join("\n")) : textPdf(inductionPages);
        files.set(id, { id, name, mimeType: mime, modifiedTime: "2026-09-19T12:00:00.000Z", size: String(content.length), webViewLink: `https://drive.google.com/file/d/${id}/view`, parents: ["root"] });
        bytes.set(id, content);
    }
    http = vi.fn<typeof fetch>(async (raw, init) => {
        const url = new URL(String(raw));
        if (url.pathname === "/revoke")
            return Response.json({});
        if (!url.href.startsWith("https://www.googleapis.com/drive/v3/"))
            throw new Error("Unexpected network: no LLM or other provider requests permitted");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer drive-test-secret-access");
        if (failure)
            return Response.json({ error: { message: "private provider body and token" } }, { status: failure });
        if (url.pathname.endsWith("/files")) {
            listPage++;
            const page = url.searchParams.get("pageToken");
            return Response.json({ files: [...files.values()].slice(page ? 2 : 0, page ? 4 : 2), ...(page ? {} : { nextPageToken: "page-two" }) });
        }
        const id = url.pathname.split("/")[4], file = files.get(id);
        if (!file)
            return Response.json({ error: "missing" }, { status: 404 });
        if (url.searchParams.get("alt") === "media" || url.pathname.endsWith("/export")) {
            if (downloadHook)
                await downloadHook();
            return new Response(Buffer.from(bytes.get(id)!));
        }
        return Response.json(file);
    });
    vi.stubGlobal("fetch", http);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await cleanup(); await db().jobRun.deleteMany({ where: { resourceId: { in: jobIds } } }); await db().user.deleteMany({ where: { id: { in: [owner.id, other.id] } } }); await db().$disconnect(); });
describe.sequential("Drive selected imports through existing owned Document/RAG pipeline", () => {
    it("reuses drive-read and requests it only by incremental consent", async () => {
        const calendar = await account(owner.id, [...GOOGLE_SCOPES["account-profile"], ...GOOGLE_SCOPES["calendar-read"]]);
        await expect(drive.list(owner.id, calendar.id)).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
        const response = await startIntegrationConnection({ provider: "google", connectedAccountId: calendar.id, capabilities: ["drive-read"], redirectPath: "/student/settings" }, owner.headers);
        const url = new URL(response.authorizationUrl);
        expect(url.searchParams.get("include_granted_scopes")).toBe("true");
        expect(url.searchParams.get("scope")).toContain(GOOGLE_SCOPES["drive-read"][0]);
        expect(url.searchParams.get("scope")).toContain(GOOGLE_SCOPES["calendar-read"][0]);
        expect(new GoogleIntegrationProvider().capabilitiesFor(calendar.scopes)).not.toContain("drive-read");
        expect(http).not.toHaveBeenCalled();
    });
    it("lists normalized bounded metadata and follows explicit page tokens", async () => {
        const first = await drive.list(owner.id, accountId);
        const second = await drive.list(owner.id, accountId, { pageToken: first.nextPageToken });
        expect(first.files[0]).toMatchObject({ name: "Lecture.pdf", importable: true, provider: "google", connectedAccountId: accountId });
        expect(second.nextPageToken).toBeNull();
        expect(listPage).toBe(2);
        expect(downloads()).toHaveLength(0);
        expect(new URL(String(http.mock.calls[0][0])).searchParams.get("pageSize")).toBe("30");
        expect(JSON.stringify(first)).not.toMatch(/accessToken|secret|capabilities|scopes/);
        expect((await getDriveSettings(owner.id, accountId)).lastSuccessfulAccess).toBeTruthy();
    });
    it("escapes filename search, supports folder filters and rejects query injection", async () => {
        await drive.list(owner.id, accountId, { search: "O'Brien\\notes", folderId: "folder" });
        const query = new URL(String(http.mock.calls[0][0])).searchParams.get("q");
        expect(query).toBe("trashed = false and name contains 'O\\'Brien\\\\notes' and 'folder' in parents");
        await expect(drive.list(owner.id, accountId, { folderId: "x' or true" })).rejects.toThrow();
        await expect(drive.metadata(owner.id, accountId, "../private")).rejects.toThrow();
    });
    it.each(["pdf", "txt", "md", "doc"])("imports %s with real extraction, chunking and embeddings", async (id) => {
        const documentId = await imported(id), document = await getDocument(owner.id, documentId);
        expect(document.processingStatus).toBe("READY");
        expect(document._count.chunks).toBeGreaterThan(0);
        expect(document.pageCount).toBe(id === "pdf" || id === "doc" ? 2 : 1);
        expect((await fullDocumentText(owner.id, documentId)).content).toContain("inductive hypothesis");
        expect(document.externalFileLink?.provider).toBe("google");
        if (id === "doc")
            expect(String(downloads()[0][0])).toContain("/export?mimeType=application%2Fpdf");
        else
            expect(String(downloads()[0][0])).toContain("alt=media");
        expect((await getDriveSettings(owner.id, accountId)).importedCount).toBe(1);
    });
    it("rejects unsupported types before any download or job creation", async () => {
        await expect(requested("bad")).rejects.toThrow("Supported");
        expect(downloads()).toHaveLength(0);
        expect(queued).toHaveLength(0);
        const metadata = await drive.metadata(owner.id, accountId, "bad");
        expect(metadata.importable).toBe(false);
    });
    it("rejects large metadata and disabled download before reading bytes", async () => {
        files.get("pdf")!.size = String(MAX_FILE_BYTES + 1);
        await expect(requested()).rejects.toThrow("10 MB");
        files.get("txt")!.capabilities = { canDownload: false };
        await expect(requested("txt")).rejects.toThrow("does not allow download");
        expect(downloads()).toHaveLength(0);
    });
    it("bounds actual bytes even when provider size is missing or inaccurate", async () => {
        delete files.get("pdf")!.size;
        await requested();
        bytes.set("pdf", new Uint8Array(MAX_FILE_BYTES + 1));
        await expect(importDriveFile({ userId: owner.id, ...resource() })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
        expect(await db().document.count({ where: { userId: owner.id } })).toBe(0);
    });
    it("sanitizes unsafe source URLs and long filenames", async () => {
        for (const url of ["javascript:alert(1)", "https://drive.google.com.evil.test/file", "https://u:p@docs.google.com/x", "http://drive.google.com/x"])
            expect(safeDriveLink(url)).toBeNull();
        files.get("txt")!.name = "a".repeat(300) + ".txt";
        files.get("txt")!.webViewLink = "https://evil.test/file";
        const doc = await getDocument(owner.id, await imported("txt"));
        expect(doc.originalFileName.endsWith(".txt")).toBe(true);
        expect(doc.externalFileLink?.webViewLink).toBeNull();
    });
    it("enforces course/account ownership before requesting provider metadata", async () => {
        await expect(requestDriveImport(other.id, resource(), publish)).rejects.toThrow();
        await expect(requestDriveImport(owner.id, resource("pdf", foreignCourse), publish)).rejects.toThrow();
        const foreign = await account(other.id);
        await expect(requestDriveImport(owner.id, { ...resource(), connectedAccountId: foreign.id }, publish)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(drive.list(other.id, accountId)).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(http).not.toHaveBeenCalled();
    });
    it("deduplicates concurrent imports and queues one job per file/course", async () => {
        const [one, two] = await Promise.all([requested(), requested()]);
        expect(one.id).toBe(two.id);
        expect(queued).toHaveLength(1);
        await importDriveFile({ userId: owner.id, ...resource() });
        const existing = await requested();
        expect(existing.documentId).toBeTruthy();
        expect(await db().document.count({ where: { userId: owner.id } })).toBe(1);
        expect(queued).toHaveLength(1);
    });
    it("allows the same file in different courses", async () => {
        const first = await imported("txt"), second = await imported("txt", secondCourse);
        expect(first).not.toBe(second);
        expect((await getDocument(owner.id, second)).courseId).toBe(secondCourse);
    });
    it("keeps successful batch imports when another selected file fails", async () => {
        const results = await Promise.allSettled([requested("pdf"), requested("txt"), requested("bad")]);
        expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "fulfilled", "rejected"]);
        await importDriveFile({ userId: owner.id, ...resource("pdf") });
        await processNextDocument(undefined, (await listDriveImports(owner.id, accountId)).find(x => x.name === "Lecture.pdf")!.documentId!);
        const progress = await listDriveImports(owner.id, accountId);
        expect(progress.map(x => x.status).sort()).toEqual(["Importing", "Ready"]);
    });
    it("uses the existing source attribution and excludes other users in vector retrieval", async () => {
        const documentId = await imported();
        const sources = await retrieveAcademicContext(owner.id, { query: "mathematical induction base case", courseId, documentIds: [documentId] });
        expect(sources.length).toBeGreaterThan(0);
        expect(sources[0]).toMatchObject({ documentId, documentTitle: "Lecture.pdf", pageNumber: expect.any(Number) });
        await expect(retrieveAcademicContext(other.id, { query: "mathematical induction", documentIds: [documentId] })).rejects.toThrow();
    });
    it.each([getTutorAgentDefinition(), getNotesAgentDefinition(), getQuizAgentDefinition()])("provides imported material through $id's unchanged Context Builder requirements", async (agent) => {
        const documentId = await imported();
        http.mockClear();
        const context = await buildUserContext({ request: "Explain the mathematical induction base case", courseId, documentIds: [documentId], options: agent.contextRequirements }, owner.headers);
        expect(context.documents?.length).toBeGreaterThan(0);
        expect(JSON.stringify(context.documents)).toContain("Lecture.pdf");
        expect(http).not.toHaveBeenCalled();
    });
    it("checks unchanged/changed timestamps without downloading and skips unchanged refresh", async () => {
        const documentId = await imported();
        http.mockClear();
        expect(await checkExternalFileFreshness(owner.id, documentId)).toEqual({ changed: false, available: true });
        await requestDriveRefresh(owner.id, documentId, publish);
        expect(downloads()).toHaveLength(0);
        expect(queued).toHaveLength(1);
        change();
        expect(await checkExternalFileFreshness(owner.id, documentId)).toEqual({ changed: true, available: true });
        expect(downloads()).toHaveLength(0);
    });
    it("atomically refreshes the same document identity and replaces all old vectors and bytes", async () => {
        const documentId = await imported(), old = await db().document.findUniqueOrThrow({ where: { id: documentId } });
        const oldChunks = await db().documentChunk.findMany({ where: { documentId }, select: { id: true } });
        change();
        await requestDriveRefresh(owner.id, documentId, publish);
        await importDriveFile({ userId: owner.id, ...resource() });
        const current = await getDocument(owner.id, documentId);
        expect(current.processingStatus).toBe("READY");
        expect(current.pageCount).toBe(1);
        expect((await fullDocumentText(owner.id, documentId)).content).toContain("Updated mathematical");
        expect(await db().documentChunk.count({ where: { id: { in: oldChunks.map(x => x.id) } } })).toBe(0);
        await expect(storage.get(old.storageKey)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await db().externalFileLink.findUniqueOrThrow({ where: { documentId } })).externalModifiedAt?.toISOString()).toBe(files.get("pdf")!.modifiedTime);
    });
    it("preserves the usable old copy after invalid PDF refresh", async () => {
        const documentId = await imported(), old = await db().document.findUniqueOrThrow({ where: { id: documentId } });
        change();
        bytes.set("pdf", new TextEncoder().encode("%PDF-broken"));
        await requestDriveRefresh(owner.id, documentId, publish);
        await expect(importDriveFile({ userId: owner.id, ...resource() })).rejects.toThrow();
        expect((await getDocument(owner.id, documentId)).processingStatus).toBe("READY");
        expect((await fullDocumentText(owner.id, documentId)).content).toContain("inductive hypothesis");
        expect((await db().document.findUniqueOrThrow({ where: { id: documentId } })).storageKey).toBe(old.storageKey);
        expect((await listDriveImports(owner.id, accountId))[0]).toMatchObject({ status: "Ready", syncStatus: "FAILED" });
    });
    it("keeps old vectors visible until all replacement embeddings succeed", async () => {
        const documentId = await imported();
        change();
        await requestDriveRefresh(owner.id, documentId, publish);
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
        const work = importDriveFile({ userId: owner.id, ...resource() }, { provider: { id: embeddingProvider.id, async generateEmbedding() { entered(); await gate; throw new Error("embedding outage"); } } });
        await started;
        expect((await fullDocumentText(owner.id, documentId)).content).toContain("inductive hypothesis");
        release();
        await expect(work).rejects.toThrow();
        expect((await fullDocumentText(owner.id, documentId)).content).toContain("inductive hypothesis");
    });
    it.each(["deleted", "trashed", "permission"])("preserves imported documents when source is %s", async (mode) => {
        const documentId = await imported();
        if (mode === "deleted")
            files.delete("pdf");
        else if (mode === "trashed")
            files.get("pdf")!.trashed = true;
        else
            failure = 403;
        expect(await checkExternalFileFreshness(owner.id, documentId)).toEqual({ changed: false, available: false });
        expect((await getDocument(owner.id, documentId)).processingStatus).toBe("READY");
        expect((await listDriveImports(owner.id, accountId))[0].syncStatus).toBe("UNAVAILABLE");
    });
    it("disconnect stops browse/freshness/refresh and preserves the stored document", async () => {
        const documentId = await imported();
        await disconnectConnectedAccount(owner.id, accountId);
        http.mockClear();
        await expect(drive.list(owner.id, accountId)).rejects.toMatchObject({ code: "DISCONNECTED" });
        await expect(checkExternalFileFreshness(owner.id, documentId)).rejects.toMatchObject({ code: "DISCONNECTED" });
        await expect(requestDriveRefresh(owner.id, documentId, publish)).rejects.toMatchObject({ code: "DISCONNECTED" });
        expect((await getDocument(owner.id, documentId)).processingStatus).toBe("READY");
        expect(http).not.toHaveBeenCalled();
    });
    it("does not publish downloaded data after an in-flight disconnect", async () => {
        await requested();
        downloadHook = async () => { await disconnectConnectedAccount(owner.id, accountId); };
        await expect(importDriveFile({ userId: owner.id, ...resource() })).rejects.toMatchObject({ code: "DISCONNECTED" });
        expect(await db().document.count({ where: { userId: owner.id } })).toBe(0);
        expect((await listDriveImports(owner.id, accountId))[0].status).toBe("Failed");
    });
    it("prevents cross-user document/source refresh, including database ownership violations", async () => {
        const documentId = await imported();
        http.mockClear();
        await expect(checkExternalFileFreshness(other.id, documentId)).rejects.toThrow();
        await expect(requestDriveRefresh(other.id, documentId, publish)).rejects.toThrow();
        await expect(db().externalFileLink.update({ where: { documentId }, data: { userId: other.id } })).rejects.toMatchObject({ code: "P2003" });
        expect(http).not.toHaveBeenCalled();
    });
    it("serializes workers and never duplicates a document", async () => {
        await requested();
        const result = await Promise.all([importDriveFile({ userId: owner.id, ...resource() }), importDriveFile({ userId: owner.id, ...resource() })]);
        expect(result.filter(r => r.skipped)).toHaveLength(1);
        expect(downloads()).toHaveLength(1);
        expect(await db().document.count({ where: { userId: owner.id } })).toBe(1);
    });
    it("reclaims expired leases and rejects unstable source versions", async () => {
        const link = await requested();
        await db().externalFileLink.update({ where: { id: link.id }, data: { syncStatus: "IMPORTING", leaseToken: "dead-worker", leaseUntil: new Date(0) } });
        downloadHook = async () => { change(); };
        await expect(importDriveFile({ userId: owner.id, ...resource() })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
        expect(await db().document.count({ where: { userId: owner.id } })).toBe(0);
        downloadHook = undefined;
        expect((await importDriveFile({ userId: owner.id, ...resource() })).documentId).toBeTruthy();
    });
    it("registers a resource-only job with bounded retries and runs the real processing pipeline", async () => {
        const link = await requested();
        expect(getBackgroundJob("import-google-drive-file")).toBe(importGoogleDriveFileJob);
        expect(queued[0].data).toEqual({ version: 1, trackingId: expect.any(String), ...resource() });
        expect(queued[0].options).toMatchObject({ retryLimit: 2, expireInSeconds: 300, group: { id: link.id } });
        await executeBackgroundJob(importGoogleDriveFileJob, { id: queued[0].options!.id!, name: queued[0].name, data: queued[0].data, retryCount: 0, retryLimit: 2, signal: new AbortController().signal });
        expect((await listDriveImports(owner.id, accountId))[0].status).toBe("Ready");
        const before = downloads().length;
        await importGoogleDriveFileJob.handler({ payload: { version: 1, ...resource() }, signal: new AbortController().signal, attempt: 2, jobRunId: "retry" });
        expect(downloads()).toHaveLength(before);
    });
    it.each([["PROVIDER_UNAVAILABLE", true], ["STORAGE_FAILURE", true], ["RESOURCE_NOT_FOUND", false], ["AUTHORIZATION_REQUIRED", false], ["DISCONNECTED", false], ["FILE_TOO_LARGE", false]] as const)("classifies %s retries safely", (code, retryable) => {
        expect(normalizeBackgroundJobError(new IntegrationError(code)).retryable).toBe(retryable);
    });
    it("rolls back import requests if queue insertion fails", async () => {
        await expect(requestDriveImport(owner.id, resource(), async () => { throw new Error("queue down"); })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
        expect(await db().externalFileLink.count({ where: { userId: owner.id } })).toBe(0);
    });
    it("sanitizes HTTP errors, rejects frontend userId, and requires authentication/origin", async () => {
        expect((await routes.import(request(owner, { ...resource(), userId: other.id }))).status).toBe(400);
        expect((await routes.import(new Request("http://localhost:3000/api/student/drive/imports", { method: "POST" }))).status).toBe(403);
        const anonymous = new Request("http://localhost:3000/api/student/drive/imports", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(resource()) });
        expect((await routes.import(anonymous)).status).toBe(401);
        failure = 503;
        const result = await routes.import(request(owner, resource()));
        expect(result.status).toBe(503);
        expect(await result.text()).not.toMatch(/private provider|secret|token/);
    });
    it("cleans link and stored files on document deletion without accessing Drive", async () => {
        const documentId = await imported();
        http.mockClear();
        const doc = await db().document.findUniqueOrThrow({ where: { id: documentId } });
        await deleteDocument(owner.id, documentId);
        expect(await db().externalFileLink.count({ where: { documentId } })).toBe(0);
        await expect(storage.get(doc.storageKey)).rejects.toThrow();
        expect(http).not.toHaveBeenCalled();
    });
    it("makes zero LLM calls for browse/import/freshness/refresh", async () => {
        await drive.list(owner.id, accountId);
        const documentId = await imported();
        change();
        await requestDriveRefresh(owner.id, documentId, publish);
        await importDriveFile({ userId: owner.id, ...resource() });
        expect(http.mock.calls.every(([url]) => String(url).startsWith("https://www.googleapis.com/drive/v3/"))).toBe(true);
    });
    it("runs Notes, Tutor and Quiz in Lecture Study using real imported PDF sources", async () => {
        const documentId = await imported();
        http.mockClear();
        const calls: string[] = [], prompts: string[] = [];
        const provider: AIProvider = {
            async generateStructuredOutput<T>(input: AIStructuredRequest<T>) {
                calls.push(input.schemaName);
                prompts.push(JSON.stringify(input.messages));
                const params = JSON.parse(input.messages[0].content.split("Execution parameters: ")[1] ?? "{}");
                let data: unknown;
                if (input.schemaName === "study_notes")
                    data = { title: "Induction notes", focusCovered: true, topics: ["Mathematical Induction"], concepts: [{ topic: "Mathematical Induction", complexity: "advanced", keyIdea: "Prove the base case and inductive step.", definitions: ["Assume the inductive hypothesis P(k)."], formulasOrProcedures: ["P(1); P(k) implies P(k+1)."], notes: "The base case starts the chain of implications.", sourceIndices: [0] }] };
                else if (input.schemaName === "lecture_explanation")
                    data = { explanations: params.targets.map((topic: string) => ({ topic, explanation: "Establish a base case then prove the successor step.", workedExample: "Prove a sum formula by adding its next term.", understandingCheck: "Where is the hypothesis used?", sourceIndices: [0] })) };
                else if (input.schemaName === "quiz_generation")
                    data = { quizTitle: "Induction practice", topic: "Mathematical Induction", difficulty: params.difficulty, questions: Array.from({ length: params.count }, (_, i) => ({ type: i % 2 ? "short-answer" : "true-false", prompt: `Question ${i + 1}: Explain the base case in mathematical induction.`, choices: i % 2 ? null : ["True", "False"], correctAnswer: "true", explanation: "The base case starts the chain of implications.", topics: ["Mathematical Induction"] })) };
                else
                    throw Error("Unexpected generation");
                return { id: "drive-fixture", model: "test", text: JSON.stringify(data), data: input.schema.parse(data) };
            }, generateText() { throw Error("Unexpected text call"); }, streamText() { throw Error("Unexpected stream"); }, generateEmbedding() { throw Error("Use real local embeddings"); },
        };
        const run = await new WorkflowService({ getProvider: () => provider, conversationEmbeddingProvider: null }).runWorkflow({ workflowId: "lecture-study", goal: "Help me study mathematical induction in this lecture", courseId, documentIds: [documentId], mode: "deep-study" }, owner.headers);
        expect(run, JSON.stringify(run)).toMatchObject({ status: "waiting-for-input", completedSteps: ["notes", "tutor", "quiz"] });
        expect(calls).toEqual(["study_notes", "lecture_explanation", "quiz_generation"]);
        expect(prompts.every(prompt => prompt.includes("Lecture.pdf"))).toBe(true);
        const context = (await db().workflowRun.findUniqueOrThrow({ where: { id: run.runId } })).context as unknown as {
            lecture: {
                sources: {
                    documentId: string;
                    pageNumber: number;
                }[];
            };
        };
        expect(context.lecture.sources.every(source => source.documentId === documentId && [1, 2].includes(source.pageNumber))).toBe(true);
        expect(http).not.toHaveBeenCalled();
    });
    it("does not resurrect a document deleted during refresh preparation", async () => {
        const documentId = await imported();
        change();
        await requestDriveRefresh(owner.id, documentId, publish);
        await expect(importDriveFile({ userId: owner.id, ...resource() }, { provider: { id: embeddingProvider.id, async generateEmbedding(text) { await deleteDocument(owner.id, documentId); return embeddingProvider.generateEmbedding(text); } } })).rejects.toThrow();
        expect(await db().document.count({ where: { id: documentId } })).toBe(0);
        expect(await db().documentChunk.count({ where: { documentId } })).toBe(0);
    });
    it("rolls back refresh when staged storage fails and allows retry", async () => {
        const documentId = await imported();
        const original = await fullDocumentText(owner.id, documentId);
        change();
        await requestDriveRefresh(owner.id, documentId, publish);
        const put = vi.spyOn(storage, "put").mockRejectedValueOnce(Error("disk unavailable"));
        await expect(importDriveFile({ userId: owner.id, ...resource() })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
        put.mockRestore();
        expect((await fullDocumentText(owner.id, documentId)).content).toBe(original.content);
        await importDriveFile({ userId: owner.id, ...resource() });
        expect((await fullDocumentText(owner.id, documentId)).content).toContain("Updated mathematical");
    });
    it("cancels a refresh before activating its new source", async () => {
        const documentId = await imported();
        change();
        await requestDriveRefresh(owner.id, documentId, publish);
        const controller = new AbortController();
        await expect(importDriveFile({ userId: owner.id, ...resource() }, { signal: controller.signal, provider: { id: embeddingProvider.id, async generateEmbedding(text) { controller.abort(); return embeddingProvider.generateEmbedding(text); } } })).rejects.toThrow();
        expect((await fullDocumentText(owner.id, documentId)).content).toContain("inductive hypothesis");
    });
    it("rejects content-length overflow, redirects, and untrusted download destinations", async () => {
        const provider = new GoogleIntegrationProvider(async () => new Response("x", { headers: { "content-length": String(MAX_FILE_BYTES + 1) } }));
        await expect(provider.download({ capability: "drive-read", path: "files/pdf", query: { alt: "media" }, maxBytes: MAX_FILE_BYTES, accessToken: "test" })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
        await expect(provider.download({ capability: "drive-read", path: "https://evil.test", query: { alt: "media" }, maxBytes: MAX_FILE_BYTES, accessToken: "test" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        const redirect = new GoogleIntegrationProvider(async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }));
        await expect(redirect.download({ capability: "drive-read", path: "files/pdf", query: { alt: "media" }, maxBytes: MAX_FILE_BYTES, accessToken: "test" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    });
    it("removes links and local sources when the owning course is deleted", async () => {
        const course = await db().course.create({ data: { userId: owner.id, courseCode: "DELETE", courseName: "Delete test", semester: "Fall 2026" } });
        const documentId = await imported("pdf", course.id), original = await db().document.findUniqueOrThrow({ where: { id: documentId } });
        await db().course.delete({ where: { id: course.id } });
        await cleanupFiles(owner.id);
        expect(await db().externalFileLink.count({ where: { documentId } })).toBe(0);
        await expect(storage.get(original.storageKey)).rejects.toThrow();
    });
    it("commits the real pg-boss import job with its link and processes the fetched resource", async () => {
        const schema = `drive_jobs_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        vi.stubEnv("BACKGROUND_JOB_SCHEMA", schema);
        vi.stubEnv("BACKGROUND_JOB_SCHEDULE_ENABLED", "false");
        const boss = await createBackgroundJobBoss("worker", { schema }).start();
        try {
            await ensureBackgroundJobQueues(boss);
            const enqueue: DriveEnqueue = async (tx, link) => { jobIds.push(link.id); await enqueueDriveImport(tx, link, boss); };
            const link = await requestDriveImport(owner.id, resource(), enqueue);
            await requestDriveImport(owner.id, resource(), enqueue);
            const jobs = await boss.fetch<Parameters<typeof importGoogleDriveFileJob.handler>[0]["payload"]>(importGoogleDriveFileJob.name, { includeMetadata: true });
            expect(jobs).toHaveLength(1);
            expect(jobs[0].data).not.toHaveProperty("userId");
            // boss.work supplies a runtime cancellation signal; manual fetch does not.
            const result = await executeBackgroundJob(importGoogleDriveFileJob, { ...jobs[0], signal: new AbortController().signal });
            expect(result.status).toBe("completed");
            expect((await listDriveImports(owner.id, accountId)).find(row => row.id === link.id)?.status).toBe("Ready");
        }
        finally {
            await boss.stop({ graceful: true, timeout: 5000 });
            await db().$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
        }
    });
    it("retries Google's 403 rate limits without treating them as revoked permissions", async () => {
        const provider = new GoogleIntegrationProvider(async () => Response.json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403 }));
        await expect(provider.read({ capability: "drive-read", path: "files", accessToken: "test" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
        await expect(provider.download({ capability: "drive-read", path: "files/pdf", query: { alt: "media" }, maxBytes: MAX_FILE_BYTES, accessToken: "test" })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    });
});
