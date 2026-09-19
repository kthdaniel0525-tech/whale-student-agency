import { z } from "zod";
export const academicCapabilities = ["courses-read", "assignments-read", "assessments-read", "files-read", "announcements-read"] as const;
export type AcademicCapability = typeof academicCapabilities[number];
export const externalId = z.string().trim().min(1).max(200);
const instant = z.string().datetime({ offset: true }).refine(s => new Date(s).getUTCFullYear() >= 2000 && new Date(s).getUTCFullYear() <= 2100).transform(s => new Date(s).toISOString());
const text = (max: number) => z.string().trim().min(1).max(max);
export const externalCourseSchema = z.object({ externalId, name: text(160), code: text(30).optional(), term: text(80).optional(), instructor: text(160).optional(), startDate: instant.optional(), endDate: instant.optional(), provider: text(80), connectedAccountId: text(100) }).strict();
export const externalAssignmentSchema = z.object({ externalId, courseExternalId: externalId, title: text(200), description: z.string().max(5000).optional(), dueAt: instant.nullable(), availableFrom: instant.optional(), availableUntil: instant.optional(), pointsPossible: z.number().nonnegative().optional(), status: z.enum(["open", "submitted", "completed"]).optional(), updatedAt: instant.optional(), externalUrl: z.string().url().max(2048).optional() }).strict();
export const externalAssessmentSchema = z.object({ externalId, courseExternalId: externalId, title: text(200), dueAt: instant.nullable(), availableFrom: instant.optional(), durationMinutes: z.number().int().positive().max(1440).optional(), topics: z.array(text(120)).max(40).default([]), pointsPossible: z.number().nonnegative().optional(), assessmentType: z.enum(["exam", "midterm", "final", "major-assessment", "quiz", "practice", "other"]), updatedAt: instant.optional(), externalUrl: z.string().url().max(2048).optional() }).strict();
export const externalCourseFileSchema = z.object({ externalId, courseExternalId: externalId, name: text(200), mimeType: text(150), size: z.number().int().nonnegative().optional(), modifiedAt: instant.optional(), downloadReference: externalId, externalUrl: z.string().url().max(2048).optional() }).strict();
export type ExternalCourse = z.infer<typeof externalCourseSchema>;
export type ExternalAssignment = z.infer<typeof externalAssignmentSchema>;
export type ExternalAssessment = z.infer<typeof externalAssessmentSchema>;
export type ExternalCourseFile = z.infer<typeof externalCourseFileSchema>;
export const importOptionsSchema = z.object({ assignments: z.boolean(), assessments: z.boolean(), files: z.boolean() }).strict();
export type AcademicImportOptions = z.infer<typeof importOptionsSchema>;
export const courseImportRequest = z.object({ connectedAccountId: text(100), externalCourseId: externalId, options: importOptionsSchema }).strict();
export const confirmedCourseImport = courseImportRequest.extend({ targetCourseId: text(100).optional(), previewToken: text(4096), courseCode: text(30), semester: text(80), confirmed: z.literal(true) }).strict();
export type CourseImportRequest = z.infer<typeof courseImportRequest>;
export type ConfirmedCourseImport = z.infer<typeof confirmedCourseImport>;
export type ImportCounts = {
    assignments: number;
    assessments: number;
    files: number;
    skipped: number;
};
export type CourseImportPreview = {
    course: ExternalCourse;
    counts: ImportCounts;
    skippedReasons: string[];
    suggestions: {
        courseId: string;
        label: string;
        score: number;
    }[];
    ambiguous: boolean;
    previewToken: string;
};
export type CourseSyncResult = {
    created: ImportCounts;
    updated: ImportCounts;
    unchanged: number;
    failed: number;
    missing: number;
    partial: boolean;
    errors: {
        kind: string;
        externalId?: string;
        code: string;
    }[];
};
export type AcademicCourseStatus = {
    id: string;
    courseId: string;
    providerName: string;
    active: boolean;
    pending: boolean;
    status: string;
    lastSyncedAt: string | null;
    lastSuccessAt: string | null;
    result: CourseSyncResult | null;
};
export type AcademicSettings = {
    providers: {
        id: string;
        name: string;
    }[];
    accounts: {
        id: string;
        name: string;
        provider: string;
        connected: boolean;
        capabilities: AcademicCapability[];
    }[];
};
