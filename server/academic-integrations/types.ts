import type { z } from "zod";
import type { AcademicCapability, ExternalCourse, ExternalAssignment, ExternalAssessment, ExternalCourseFile } from "@/lib/student/academic-integrations/types";
/** Opaque pagination/checkpoints. Snapshot pages alone may prove a missing object. */
export type AcademicPage<T> = {
    items: T[];
    nextCursor?: string;
    mode: "snapshot" | "delta";
    deletedIds?: string[];
    checkpoint?: string;
};
export type AcademicRead = {
    courseExternalId: string;
    cursor?: string;
    updatedSince?: string;
    syncToken?: string;
    limit: number;
};
export type AcademicConnection = {
    id: string;
    userId: string;
    provider: string;
    configuration: unknown;
    grants: readonly string[];
};
/** Implementations delegate to the existing OAuth service, a secret vault or institution auth.
 * No browser token contract and no new unencrypted API token storage. */
export interface AcademicCredentialAccess {
    use<T>(operation: (credential: string) => Promise<T>): Promise<T>;
}
export type AcademicCall = {
    connection: AcademicConnection;
    signal: AbortSignal;
    credentials: AcademicCredentialAccess;
};
export interface AcademicIntegrationProvider {
    readonly id: string;
    readonly name: string;
    readonly productionReady: boolean;
    readonly authentication: "oauth2" | "api-token" | "institution" | "test";
    readonly configurationSchema: z.ZodType;
    readonly capabilities: readonly AcademicCapability[];
    readonly incremental?: "updated-since" | "sync-token";
    grantedCapabilities(connection: AcademicConnection): readonly AcademicCapability[];
    listCourses(call: AcademicCall, input: {
        cursor?: string;
        limit: number;
    }): Promise<AcademicPage<ExternalCourse>>;
    getCourse(call: AcademicCall, externalCourseId: string): Promise<ExternalCourse>;
    listAssignments?(call: AcademicCall, input: AcademicRead): Promise<AcademicPage<ExternalAssignment>>;
    listAssessments?(call: AcademicCall, input: AcademicRead): Promise<AcademicPage<ExternalAssessment>>;
    listFiles?(call: AcademicCall, input: AcademicRead): Promise<AcademicPage<ExternalCourseFile>>;
    /** Enforce maxBytes during download, honor cancellation, and fetch this exact modified version or reject. Never follow arbitrary signed URLs with account credentials. */
    downloadFile?(call: AcademicCall, file: ExternalCourseFile, maxBytes: number): Promise<Uint8Array>;
}
