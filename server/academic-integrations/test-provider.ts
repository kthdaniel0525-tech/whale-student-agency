import "server-only";
import { z } from "zod";
import type { AcademicCall, AcademicIntegrationProvider, AcademicRead, AcademicPage } from "./types";
import type { ExternalCourse, ExternalAssignment, ExternalAssessment, ExternalCourseFile, AcademicCapability } from "@/lib/student/academic-integrations/types";
import { AcademicIntegrationError } from "./errors";
/** In-memory fixture adapter. Never registered in production or offered as a working LMS. */
export class TestAcademicProvider implements AcademicIntegrationProvider {
    readonly id = "test-academic";
    readonly name = "Test Academic Provider";
    readonly productionReady = false;
    readonly authentication = "test" as const;
    readonly configurationSchema = z.object({ institution: z.string().optional() }).strict();
    readonly capabilities: readonly AcademicCapability[] = ["courses-read", "assignments-read", "assessments-read", "files-read"];
    readonly courses = new Map<string, Omit<ExternalCourse, "provider" | "connectedAccountId">>();
    readonly assignments = new Map<string, ExternalAssignment[]>();
    readonly assessments = new Map<string, ExternalAssessment[]>();
    readonly files = new Map<string, ExternalCourseFile[]>();
    readonly contents = new Map<string, Uint8Array>();
    readonly calls: string[] = [];
    failures = new Set<string>();
    beforeCall?: (kind: string) => Promise<void>;
    grantedCapabilities(connection: AcademicCall["connection"]) { return this.capabilities.filter(c => connection.grants.includes(c)); }
    private async check(kind: string, call: AcademicCall) { this.calls.push(kind); call.signal.throwIfAborted(); await this.beforeCall?.(kind); if (this.failures.has(kind))
        throw new AcademicIntegrationError("PROVIDER_UNAVAILABLE"); }
    private page<T>(items: T[], input: {
        cursor?: string;
        limit: number;
    }): AcademicPage<T> { const offset = input.cursor ? Number(input.cursor) : 0; if (!Number.isSafeInteger(offset) || offset < 0)
        throw new AcademicIntegrationError("INVALID_REQUEST"); return { items: structuredClone(items.slice(offset, offset + input.limit)), mode: "snapshot", ...(offset + input.limit < items.length ? { nextCursor: String(offset + input.limit) } : {}) }; }
    async listCourses(call: AcademicCall, input: {
        cursor?: string;
        limit: number;
    }) { await this.check("courses", call); return this.page([...this.courses.values()].map(c => ({ ...c, provider: this.id, connectedAccountId: call.connection.id })), input); }
    async getCourse(call: AcademicCall, id: string) { await this.check("course", call); const course = this.courses.get(id); if (!course)
        throw new AcademicIntegrationError("NOT_FOUND"); return { ...structuredClone(course), provider: this.id, connectedAccountId: call.connection.id }; }
    async listAssignments(call: AcademicCall, input: AcademicRead) { await this.check("assignments", call); return this.page(this.assignments.get(input.courseExternalId) ?? [], input); }
    async listAssessments(call: AcademicCall, input: AcademicRead) { await this.check("assessments", call); return this.page(this.assessments.get(input.courseExternalId) ?? [], input); }
    async listFiles(call: AcademicCall, input: AcademicRead) { await this.check("files", call); return this.page(this.files.get(input.courseExternalId) ?? [], input); }
    async downloadFile(call: AcademicCall, file: ExternalCourseFile, maxBytes: number) { await this.check(`download:${file.externalId}`, call); const current = this.files.get(file.courseExternalId)?.find(row => row.externalId === file.externalId); if (!current || current.modifiedAt !== file.modifiedAt || current.downloadReference !== file.downloadReference)
        throw new AcademicIntegrationError("INVALID_RESPONSE"); const bytes = this.contents.get(file.downloadReference); if (!bytes)
        throw new AcademicIntegrationError("NOT_FOUND"); if (bytes.length > maxBytes)
        throw new AcademicIntegrationError("LIMIT"); return bytes.slice(); }
}
