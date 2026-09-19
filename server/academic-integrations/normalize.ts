import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getEnv } from "../env";
import { academicSyncConfig } from "./config";
import { AcademicIntegrationError } from "./errors";
import type { AcademicPage } from "./types";
import type { ExternalAssessment, ExternalCourse, ExternalCourseFile } from "@/lib/student/academic-integrations/types";
export function safeAcademicUrl(value?: string) { try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
}
catch {
    return null;
} }
export function fileImportReason(file: ExternalCourseFile) {
    if ((file.size ?? 0) > 10 * 1024 * 1024)
        return "File exceeds 10 MB.";
    if (/[\/\\\x00-\x1f]/.test(file.name))
        return "Filename is not supported.";
    if (file.mimeType === "application/pdf" && /\.pdf$/i.test(file.name))
        return null;
    if (["text/plain", "text/markdown", "text/x-markdown"].includes(file.mimeType) && /\.(txt|md|markdown)$/i.test(file.name))
        return null;
    return "Supported files: PDF, TXT and Markdown.";
}
export function examImportReason(item: ExternalAssessment) { return !["exam", "midterm", "final", "major-assessment"].includes(item.assessmentType) ? "Small quizzes and practice assessments do not become exams." : !item.dueAt ? "Assessment has no explicit scheduled date." : null; }
export function courseMatches(external: ExternalCourse, courses: {
    id: string;
    courseCode: string;
    courseName: string;
    semester: string;
}[]) {
    // Exact normalized comparisons only; section codes and distinct concepts remain distinct.
    const normal = (s?: string) => (s ?? "").normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
    return courses.map(course => ({ courseId: course.id, label: `${course.courseCode} · ${course.courseName} · ${course.semester}`, score: (external.code && normal(course.courseCode) === normal(external.code) ? 50 : 0) + (normal(course.courseName) === normal(external.name) ? 30 : 0) + (external.term && normal(course.semester) === normal(external.term) ? 20 : 0) })).filter(row => row.score >= 30).sort((a, b) => b.score - a.score || a.courseId.localeCompare(b.courseId)).slice(0, 5);
}
export async function collectAcademic<T extends {
    externalId: string;
}>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, load: (cursor?: string) => Promise<AcademicPage<T>>, maxItems = academicSyncConfig().maxItems) {
    const items: T[] = [], deletedIds: string[] = [], cursors = new Set<string>(), ids = new Set<string>();
    let cursor: string | undefined, mode: "snapshot" | "delta" | undefined, checkpoint: string | undefined;
    for (let i = 0; i < academicSyncConfig().maxPages; i++) {
        const raw = await load(cursor);
        const page = z.object({ items: z.array(schema).max(academicSyncConfig().pageSize), nextCursor: z.string().min(1).max(2048).optional(), mode: z.enum(["snapshot", "delta"]), deletedIds: z.array(z.string().min(1).max(200)).max(100).optional(), checkpoint: z.string().max(4096).optional() }).safeParse(raw);
        if (!page.success || (mode && mode !== page.data.mode))
            throw new AcademicIntegrationError("INVALID_RESPONSE");
        mode = page.data.mode;
        for (const item of page.data.items) {
            if (ids.has(item.externalId))
                throw new AcademicIntegrationError("INVALID_RESPONSE");
            ids.add(item.externalId);
            items.push(item);
        }
        deletedIds.push(...page.data.deletedIds ?? []);
        checkpoint = page.data.checkpoint ?? checkpoint;
        if (items.length > maxItems || deletedIds.length > maxItems)
            throw new AcademicIntegrationError("LIMIT");
        cursor = page.data.nextCursor;
        if (!cursor) {
            if (deletedIds.some(id => ids.has(id)))
                throw new AcademicIntegrationError("INVALID_RESPONSE");
            return { items, deletedIds, mode, checkpoint };
        }
        if (cursors.has(cursor))
            throw new AcademicIntegrationError("INVALID_RESPONSE");
        cursors.add(cursor);
    }
    throw new AcademicIntegrationError("LIMIT");
}
export function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function previewToken(value: unknown, now = Date.now()) {
    const body = Buffer.from(JSON.stringify({ hash: fingerprint(value), expires: now + 10 * 60000 })).toString("base64url");
    return `${body}.${createHmac("sha256", getEnv().BETTER_AUTH_SECRET).update(body).digest("base64url")}`;
}
export function verifyPreview(token: string, value: unknown) {
    try {
        const [body, signature, extra] = token.split(".");
        const expected = createHmac("sha256", getEnv().BETTER_AUTH_SECRET).update(body).digest(), actual = Buffer.from(signature, "base64url");
        const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected) || parsed.expires < Date.now() || parsed.hash !== fingerprint(value))
            throw Error();
    }
    catch {
        throw new AcademicIntegrationError("PREVIEW_EXPIRED");
    }
}
