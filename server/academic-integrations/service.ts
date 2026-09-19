import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, ExternalCourseLink } from "@/generated/prisma/client";
import { db } from "../db/client";
import { createCourse, createAssignment, createExam, updateImportedAssignment, updateImportedExam } from "../services/academic";
import { uploadDocument, assertCourse } from "../documents/service";
import { replaceDocumentSource } from "../documents/replacement";
import { processNextDocument } from "../documents/processor";
import { MAX_FILE_BYTES, DocumentError } from "../documents/config";
import { getOwnedConnection, revokeImportedConnection } from "../integrations/connections";
import { credentialContext, getTokenEncryptionService } from "../integrations/encryption";
import { refreshRecommendationsBestEffort } from "../recommendations";
import { academicAccess } from "./access";
import { academicProviderRegistry, type AcademicProviderRegistry } from "./registry";
import { AcademicIntegrationError, academicError } from "./errors";
import { academicSyncConfig } from "./config";
import { collectAcademic, courseMatches, examImportReason, fileImportReason, previewToken, safeAcademicUrl, verifyPreview } from "./normalize";
import { academicEvent } from "./events";
import type { AcademicConnection, AcademicCredentialAccess } from "./types";
import { confirmedCourseImport, courseImportRequest, externalCourseSchema, externalAssignmentSchema, externalAssessmentSchema, externalCourseFileSchema, importOptionsSchema, type AcademicSettings, type CourseImportRequest, type ConfirmedCourseImport, type CourseImportPreview, type CourseSyncResult, type AcademicCourseStatus, type ExternalAssignment, type ExternalAssessment, type ExternalCourseFile } from "@/lib/student/academic-integrations/types";
export type AcademicEnqueue = (tx: Prisma.TransactionClient, link: ExternalCourseLink) => Promise<void>;
const syncKey = (id: string) => `academic-course:${id}`;
const linkKey = (accountId: string, externalId: string) => ({ connectedAccountId_externalId: { connectedAccountId: accountId, externalId } });
const emptyCounts = () => ({ assignments: 0, assessments: 0, files: 0, skipped: 0 });
const blankResult = (): CourseSyncResult => ({ created: emptyCounts(), updated: emptyCounts(), unchanged: 0, failed: 0, missing: 0, partial: false, errors: [] });
const selectedCapability = { assignments: "assignments-read", assessments: "assessments-read", files: "files-read" } as const;
const stamp = (value?: string) => value ? new Date(value) : null;
const sameDate = (left: Date | null, right?: string | null) => left?.toISOString() === (right ? new Date(right).toISOString() : undefined);
export function createAcademicIntegrationService(dependencies: {
    registry?: AcademicProviderRegistry;
    credentials?: (connection: AcademicConnection) => AcademicCredentialAccess;
    enqueue?: AcademicEnqueue;
} = {}) {
    const registry = dependencies.registry ?? academicProviderRegistry, access = academicAccess(registry, dependencies.credentials);
    const publish: AcademicEnqueue = dependencies.enqueue ?? (async (tx, link) => { const { enqueueExternalCourseSync } = await import("../jobs/sync-external-course"); await enqueueExternalCourseSync(tx, link); });
    async function checkedCourse(userId: string, accountId: string, externalCourseId: string, signal: AbortSignal) {
        const value = await access.call(userId, accountId, "courses-read", signal, (call, p) => p.getCourse(call, externalCourseId));
        const parsed = externalCourseSchema.safeParse(value);
        const { provider } = await access.authorize(userId, accountId, "courses-read");
        if (!parsed.success || parsed.data.externalId !== externalCourseId || parsed.data.connectedAccountId !== accountId || parsed.data.provider !== provider.id)
            throw new AcademicIntegrationError("INVALID_RESPONSE");
        return parsed.data;
    }
    async function readCategory<K extends "assignments" | "assessments" | "files">(userId: string, input: CourseImportRequest, kind: K, signal: AbortSignal, since?: string, checkpoint?: string) {
        const capability = selectedCapability[kind];
        const read = async (cursor?: string) => access.call(userId, input.connectedAccountId, capability, signal, async (call, p) => {
            const args = { courseExternalId: input.externalCourseId, cursor, limit: academicSyncConfig().pageSize,
                ...(p.incremental === "updated-since" && since ? { updatedSince: since } : {}), ...(p.incremental === "sync-token" && checkpoint ? { syncToken: checkpoint } : {}) };
            if (kind === "assignments")
                return p.listAssignments!(call, args);
            if (kind === "assessments")
                return p.listAssessments!(call, args);
            return p.listFiles!(call, args);
        });
        const schema = (kind === "assignments" ? externalAssignmentSchema : kind === "assessments" ? externalAssessmentSchema : externalCourseFileSchema) as z.ZodType<ExternalAssignment | ExternalAssessment | ExternalCourseFile, z.ZodTypeDef, unknown>;
        const maxItems = kind === "files" ? academicSyncConfig().maxFiles : academicSyncConfig().maxItems;
        let data;
        try {
            data = await collectAcademic(schema, read, maxItems);
        }
        catch (cause) {
            if (!(cause instanceof AcademicIntegrationError) || cause.code !== "SYNC_CHECKPOINT_EXPIRED" || (!since && !checkpoint))
                throw cause;
            since = undefined;
            checkpoint = undefined;
            data = await collectAcademic(schema, read, maxItems);
            if (data.mode !== "snapshot")
                throw new AcademicIntegrationError("INVALID_RESPONSE");
        }
        if (data.items.some(item => item.courseExternalId !== input.externalCourseId))
            throw new AcademicIntegrationError("INVALID_RESPONSE");
        return data;
    }
    async function loadPreview(userId: string, raw: CourseImportRequest) {
        const input = courseImportRequest.parse(raw), signal = AbortSignal.timeout(30000);
        const course = await checkedCourse(userId, input.connectedAccountId, input.externalCourseId, signal);
        const data: Record<string, unknown> = {};
        const counts = emptyCounts(), skippedReasons: string[] = [];
        for (const kind of ["assignments", "assessments", "files"] as const)
            if (input.options[kind]) {
                const result = await readCategory(userId, input, kind, signal);
                if (result.mode !== "snapshot")
                    throw new AcademicIntegrationError("INVALID_RESPONSE");
                data[kind] = result.items.sort((a, b) => a.externalId.localeCompare(b.externalId));
                for (const row of result.items) {
                    const reason = kind === "assignments" ? !(row as ExternalAssignment).dueAt ? "Assignment has no explicit due date." : null : kind === "assessments" ? examImportReason(row as ExternalAssessment) : fileImportReason(row as ExternalCourseFile);
                    if (reason) {
                        counts.skipped++;
                        if (skippedReasons.length < 20)
                            skippedReasons.push(`${"title" in row ? row.title : row.name}: ${reason}`);
                    }
                    else
                        counts[kind]++;
                }
            }
        return { input, course, data, counts, skippedReasons };
    }
    async function preview(userId: string, raw: CourseImportRequest): Promise<CourseImportPreview> {
        const loaded = await loadPreview(userId, raw), courses = await db().course.findMany({ where: { userId }, select: { id: true, courseCode: true, courseName: true, semester: true }, take: 200 });
        const suggestions = courseMatches(loaded.course, courses);
        return { course: loaded.course, counts: loaded.counts, skippedReasons: loaded.skippedReasons, suggestions, ambiguous: suggestions.length > 1 || (suggestions.length === 1 && suggestions[0].score < 80), previewToken: previewToken({ userId, ...loaded }) };
    }
    async function lock(tx: Prisma.TransactionClient, userId: string, accountId: string) {
        await tx.$queryRaw `SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
        await tx.$queryRaw `SELECT id FROM "ConnectedAccount" WHERE id=${accountId} AND "userId"=${userId} FOR UPDATE`;
        return access.authorize(userId, accountId, "courses-read", tx);
    }
    async function importExternalCourse(userId: string, raw: ConfirmedCourseImport) {
        const input = confirmedCourseImport.parse(raw);
        if (input.targetCourseId)
            await assertCourse(userId, input.targetCourseId);
        const loaded = await loadPreview(userId, { connectedAccountId: input.connectedAccountId, externalCourseId: input.externalCourseId, options: input.options });
        verifyPreview(input.previewToken, { userId, ...loaded });
        const link = await db().$transaction(async (tx) => {
            await lock(tx, userId, input.connectedAccountId);
            const previous = await tx.externalCourseLink.findUnique({ where: linkKey(input.connectedAccountId, input.externalCourseId) });
            if (previous) {
                if (previous.userId !== userId || (input.targetCourseId && previous.courseId !== input.targetCourseId))
                    throw new AcademicIntegrationError("CONFLICT");
                return previous;
            }
            if (input.targetCourseId && (!await tx.course.findFirst({ where: { id: input.targetCourseId, userId } }) || await tx.externalCourseLink.findUnique({ where: { courseId: input.targetCourseId } })))
                throw new AcademicIntegrationError("CONFLICT");
            const course = input.targetCourseId ? { id: input.targetCourseId } : await createCourse(userId, { courseName: loaded.course.name, courseCode: input.courseCode, semester: input.semester, professor: loaded.course.instructor ?? "", description: "" }, tx);
            const result = await tx.externalCourseLink.create({ data: { userId, connectedAccountId: input.connectedAccountId, provider: loaded.course.provider, externalId: input.externalCourseId, courseId: course.id, options: input.options, externalEndsAt: stamp(loaded.course.endDate), requestQueuedAt: new Date() } });
            await publish(tx, result);
            return result;
        }, { timeout: 15000 });
        academicEvent("IMPORT", link.id);
        return status(userId, link.courseId);
    }
    async function status(userId: string, courseId: string): Promise<AcademicCourseStatus | null> {
        await assertCourse(userId, courseId);
        const link = await db().externalCourseLink.findFirst({ where: { userId, courseId } });
        if (!link)
            return null;
        const state = await db().integrationSyncState.findUnique({ where: { connectedAccountId_integrationType: { connectedAccountId: link.connectedAccountId, integrationType: syncKey(link.id) } } });
        const providerName = registry.list().find(p => p.id === link.provider)?.name ?? "External LMS";
        const syncing = state?.status === "SYNCING" && Boolean(state.leaseUntil && state.leaseUntil.getTime() > Date.now());
        const abandoned = state?.status === "SYNCING" && !syncing;
        const pending = link.active && !abandoned && Boolean(link.requestQueuedAt && link.requestQueuedAt.getTime() > Date.now() - 600000);
        return { id: link.id, courseId, providerName, active: link.active, pending, status: !link.active ? "paused" : syncing ? "syncing" : abandoned ? "failed" : pending ? "queued" : link.lastResult && (link.lastResult as unknown as CourseSyncResult).partial ? "partial" : state?.status === "FAILED" ? "failed" : state?.status === "COMPLETED" ? "synced" : "not-synced", lastSyncedAt: state?.lastSyncCompletedAt?.toISOString() ?? null, lastSuccessAt: state?.lastSuccessfulSyncAt?.toISOString() ?? null, result: link.lastResult as CourseSyncResult | null };
    }
    async function requestSync(userId: string, courseId: string, scheduled = false) {
        await assertCourse(userId, courseId);
        const link = await db().externalCourseLink.findFirst({ where: { userId, courseId } });
        if (!link)
            throw new AcademicIntegrationError("NOT_FOUND");
        await db().$transaction(async (tx) => {
            await lock(tx, userId, link.connectedAccountId);
            const current = await tx.externalCourseLink.findUniqueOrThrow({ where: { id: link.id } });
            if (!current.active)
                throw new AcademicIntegrationError("DISCONNECTED");
            const state = await tx.integrationSyncState.findUnique({ where: { connectedAccountId_integrationType: { connectedAccountId: link.connectedAccountId, integrationType: syncKey(link.id) } } });
            const abandoned = state?.status === "SYNCING" && (!state.leaseUntil || state.leaseUntil.getTime() <= Date.now());
            if ((!abandoned && current.requestQueuedAt && current.requestQueuedAt.getTime() > Date.now() - 600000) || (state?.leaseUntil && state.leaseUntil.getTime() > Date.now()))
                return;
            if (abandoned) await tx.integrationSyncState.update({ where: { id: state.id }, data: { status: "FAILED", leaseToken: null, leaseUntil: null, lastErrorCode: "LEASE_EXPIRED" } });
            const updated = await tx.externalCourseLink.update({ where: { id: link.id }, data: { requestVersion: { increment: 1 }, requestQueuedAt: new Date(), ...(!scheduled ? { filesRequested: true } : {}) } });
            await publish(tx, updated);
        });
        return status(userId, courseId);
    }
    async function syncExternalCourse(userId: string, accountId: string, externalCourseId: string, incomingSignal?: AbortSignal) {
        const signal = incomingSignal ? AbortSignal.any([incomingSignal, AbortSignal.timeout(academicSyncConfig().timeoutMs)]) : AbortSignal.timeout(academicSyncConfig().timeoutMs);
        const token = randomUUID(), result = blankResult();
        const original = await db().externalCourseLink.findUnique({ where: linkKey(accountId, externalCourseId) });
        if (!original || original.userId !== userId)
            throw new AcademicIntegrationError("NOT_FOUND");
        const claimed = await db().$transaction(async (tx) => {
            const { credentialVersion } = await lock(tx, userId, accountId);
            const link = await tx.externalCourseLink.findUniqueOrThrow({ where: { id: original.id } });
            if (!link.active)
                throw new AcademicIntegrationError("DISCONNECTED");
            const where = { connectedAccountId_integrationType: { connectedAccountId: accountId, integrationType: syncKey(link.id) } };
            const state = await tx.integrationSyncState.findUnique({ where });
            if (state?.leaseUntil && state.leaseUntil.getTime() > Date.now())
                return null;
            const current = await tx.integrationSyncState.upsert({ where, create: { ...where.connectedAccountId_integrationType, status: "SYNCING", leaseToken: token, leaseUntil: new Date(Date.now() + 540000), lastSyncStartedAt: new Date() }, update: { status: "SYNCING", leaseToken: token, leaseUntil: new Date(Date.now() + 540000), lastSyncStartedAt: new Date(), lastErrorCode: null } });
            return { link, state: current, credentialVersion, since: state?.lastSuccessfulSyncAt?.toISOString() };
        });
        if (!claimed)
            return { skipped: true, failed: 0 };
        const { link, state, credentialVersion } = claimed, options = importOptionsSchema.parse(link.options);
        const guard = async (tx: Prisma.TransactionClient, capability: "courses-read" | "assignments-read" | "assessments-read" | "files-read" = "courses-read") => {
            signal.throwIfAborted();
            const current = await lock(tx, userId, accountId);
            await access.authorize(userId, accountId, capability, tx);
            if (current.credentialVersion !== credentialVersion)
                throw new AcademicIntegrationError("DISCONNECTED");
            const rows = await tx.$queryRaw<{
                id: string;
            }[]> `SELECT id FROM "IntegrationSyncState" WHERE id=${state.id} AND "leaseToken"=${token} AND "leaseUntil">NOW() FOR UPDATE`;
            if (!rows.length || !await tx.externalCourseLink.findFirst({ where: { id: link.id, userId, active: true } }))
                throw new AcademicIntegrationError("DISCONNECTED");
            if (!await tx.course.findFirst({ where: { id: link.courseId, userId } }))
                throw new AcademicIntegrationError("NOT_FOUND");
        };
        let transient = false, filesRead = false;
        const error = (kind: string, cause: unknown, externalId?: string) => { const safe = cause instanceof DocumentError || cause instanceof z.ZodError ? new AcademicIntegrationError("INVALID_RESPONSE") : academicError(cause); result.failed++; result.partial = true; if (result.errors.length < 20)
            result.errors.push({ kind, externalId, code: safe.code }); if (["PROVIDER_UNAVAILABLE", "STORAGE_FAILURE"].includes(safe.code))
            transient = true; if (["DISCONNECTED", "AUTHORIZATION_REQUIRED"].includes(safe.code))
            academicEvent("AUTH_FAILURE", link.id); };
        const checkpoints: Record<string, string> = {};
        try {
            academicEvent("SYNC_STARTED", link.id);
            const externalCourse = await checkedCourse(userId, accountId, externalCourseId, signal);
            const incremental = (await access.authorize(userId, accountId, "courses-read")).provider.incremental;
            if (state.cursorEncrypted)
                Object.assign(checkpoints, JSON.parse(getTokenEncryptionService().decrypt(state.cursorEncrypted, credentialContext(userId, link.provider, state.id, "sync-cursor"))));
            for (const kind of ["assignments", "assessments", "files"] as const) {
                if (!options[kind])
                    continue;
                if (kind === "files" && link.filesLastSyncedAt && !link.filesRequested && link.filesLastSyncedAt.getTime() > Date.now() - academicSyncConfig().fileIntervalMs)
                    continue;
                let collection: Awaited<ReturnType<typeof readCategory>>;
                try {
                    collection = await readCategory(userId, { connectedAccountId: accountId, externalCourseId, options }, kind, signal, checkpoints[`${kind}:since`], checkpoints[kind]);
                }
                catch (cause) {
                    error(kind, cause);
                    continue;
                }
                const failuresBefore = result.failed;
                for (const item of collection.items) {
                    try {
                        if (kind === "files") {
                            await syncFile(item as ExternalCourseFile);
                            continue;
                        }
                        const assignment = item as ExternalAssignment, exam = item as ExternalAssessment;
                        const skip = kind === "assignments" ? !assignment.dueAt : Boolean(examImportReason(exam));
                        if (skip) {
                            // Internal dates are required: preserve the last known date and expose the source as unscheduled.
                            await db().$transaction(async (tx) => {
                                await guard(tx, selectedCapability[kind]);
                                const where = { userId, externalCourseLinkId: link.id, externalId: item.externalId };
                                if (kind === "assignments")
                                    await tx.externalAssignmentLink.updateMany({ where, data: { syncStatus: "UNSCHEDULED", lastSyncedAt: new Date() } });
                                else
                                    await tx.externalExamLink.updateMany({ where, data: { syncStatus: "UNMAPPED", lastSyncedAt: new Date() } });
                            });
                            result.created.skipped++;
                            continue;
                        }
                        const change = await db().$transaction(async (tx) => {
                            await guard(tx, selectedCapability[kind]);
                            if (kind === "assignments") {
                                const mapping = await tx.externalAssignmentLink.findUnique({ where: { externalCourseLinkId_externalId: { externalCourseLinkId: link.id, externalId: item.externalId } }, include: { assignment: true } });
                                const fields = { title: assignment.title, description: assignment.description ?? "", dueDate: assignment.dueAt! };
                                if (mapping) {
                                    if (mapping.userId !== userId || mapping.assignment.userId !== userId || mapping.assignment.courseId !== link.courseId)
                                        throw new AcademicIntegrationError("NOT_FOUND");
                                    const changed = mapping.assignment.title !== fields.title || mapping.assignment.description !== fields.description || !sameDate(mapping.assignment.dueDate, fields.dueDate);
                                    if (changed)
                                        await updateImportedAssignment(userId, mapping.assignmentId, fields, tx);
                                    await tx.externalAssignmentLink.update({ where: { id: mapping.id }, data: { syncStatus: "SYNCED", lastSyncedAt: new Date(), lastExternalUpdatedAt: stamp(assignment.updatedAt), externalUrl: safeAcademicUrl(assignment.externalUrl) } });
                                    return changed ? "updated" : "unchanged";
                                }
                                else {
                                    const created = await createAssignment(userId, link.courseId, { ...fields, status: "TODO", priority: "MEDIUM", estimatedHours: 0 }, tx);
                                    await tx.externalAssignmentLink.create({ data: { userId, externalCourseLinkId: link.id, externalId: item.externalId, assignmentId: created.id, lastExternalUpdatedAt: stamp(assignment.updatedAt), externalUrl: safeAcademicUrl(assignment.externalUrl) } });
                                    return "created";
                                }
                            }
                            else {
                                const mapping = await tx.externalExamLink.findUnique({ where: { externalCourseLinkId_externalId: { externalCourseLinkId: link.id, externalId: item.externalId } }, include: { exam: true } });
                                const fields = { title: exam.title, examDate: exam.dueAt! };
                                if (mapping) {
                                    if (mapping.userId !== userId || mapping.exam.userId !== userId || mapping.exam.courseId !== link.courseId)
                                        throw new AcademicIntegrationError("NOT_FOUND");
                                    const changed = mapping.exam.title !== fields.title || !sameDate(mapping.exam.examDate, fields.examDate);
                                    if (changed)
                                        await updateImportedExam(userId, mapping.examId, fields, tx);
                                    await tx.externalExamLink.update({ where: { id: mapping.id }, data: { syncStatus: "SYNCED", lastSyncedAt: new Date(), lastExternalUpdatedAt: stamp(exam.updatedAt), externalUrl: safeAcademicUrl(exam.externalUrl) } });
                                    return changed ? "updated" : "unchanged";
                                }
                                else {
                                    const created = await createExam(userId, link.courseId, { ...fields, topics: exam.topics, notes: "" }, tx);
                                    await tx.externalExamLink.create({ data: { userId, externalCourseLinkId: link.id, externalId: item.externalId, examId: created.id, lastExternalUpdatedAt: stamp(exam.updatedAt), externalUrl: safeAcademicUrl(exam.externalUrl) } });
                                    return "created";
                                }
                            }
                        });
                        if (change === "unchanged")
                            result.unchanged++;
                        else
                            result[change][kind]++;
                    }
                    catch (cause) {
                        error(kind, cause, item.externalId);
                    }
                }
                // A bounded, fully traversed snapshot can establish absence; a delta cannot.
                result.missing += await db().$transaction(async (tx) => {
                    await guard(tx, selectedCapability[kind]);
                    const externalIds = collection.items.map(item => item.externalId);
                    const filter = collection.mode === "snapshot" ? { notIn: externalIds } : { in: collection.deletedIds };
                    if (kind === "assignments")
                        return (await tx.externalAssignmentLink.updateMany({ where: { externalCourseLinkId: link.id, userId, externalId: filter, syncStatus: { not: "MISSING" } }, data: { syncStatus: "MISSING" } })).count;
                    else if (kind === "assessments")
                        return (await tx.externalExamLink.updateMany({ where: { externalCourseLinkId: link.id, userId, externalId: filter, syncStatus: { not: "MISSING" } }, data: { syncStatus: "MISSING" } })).count;
                    else
                        return (await tx.externalFileLink.updateMany({ where: { externalCourseLinkId: link.id, userId, externalFileId: filter, syncStatus: { not: "UNAVAILABLE" } }, data: { syncStatus: "UNAVAILABLE", errorCode: "SOURCE_UNAVAILABLE" } })).count;
                });
                if (result.failed === failuresBefore) {
                    if (incremental === "updated-since")
                        checkpoints[`${kind}:since`] = state.lastSyncStartedAt!.toISOString();
                    if (incremental === "sync-token") {
                        if (collection.checkpoint)
                            checkpoints[kind] = collection.checkpoint;
                        else if (collection.mode === "snapshot")
                            delete checkpoints[kind];
                    }
                    if (kind === "files")
                        filesRead = true;
                }
            }
            result.partial = result.failed > 0 && result.created.assignments + result.created.assessments + result.created.files + result.updated.assignments + result.updated.assessments + result.updated.files + result.unchanged > 0;
            await db().$transaction(async (tx) => {
                await guard(tx);
                const cursor = JSON.stringify(checkpoints);
                if (cursor.length > 10000)
                    throw new AcademicIntegrationError("LIMIT");
                await tx.integrationSyncState.update({ where: { id: state.id }, data: { status: result.failed ? "FAILED" : "COMPLETED", lastSyncCompletedAt: new Date(), lastErrorCode: result.failed ? "PARTIAL_FAILURE" : null, leaseToken: null, leaseUntil: null, ...(!result.failed ? { lastSuccessfulSyncAt: new Date(), ...(Object.keys(checkpoints).length ? { cursorEncrypted: getTokenEncryptionService().encrypt(cursor, credentialContext(userId, link.provider, state.id, "sync-cursor")) } : {}) } : {}) } });
                await tx.externalCourseLink.update({ where: { id: link.id }, data: { lastResult: result as unknown as Prisma.InputJsonValue, externalEndsAt: stamp(externalCourse.endDate), requestQueuedAt: null, nextSyncAt: new Date(Date.now() + academicSyncConfig().intervalMs), ...(filesRead ? { filesLastSyncedAt: new Date(), filesRequested: false } : {}) } });
            });
            await refreshRecommendationsBestEffort(userId);
            academicEvent(result.failed ? "PARTIAL_FAILURE" : "SYNC_COMPLETED", link.id, { created: result.created.assignments + result.created.assessments + result.created.files, updated: result.updated.assignments + result.updated.assessments + result.updated.files, failed: result.failed });
            if (transient)
                throw new AcademicIntegrationError("PROVIDER_UNAVAILABLE");
            return { skipped: false, failed: result.failed };
        }
        catch (cause) {
            // Only the current lease may publish failure; a late worker cannot overwrite a newer run or disconnect.
            const recorded = await db().$transaction(async (tx) => {
                const changed = await tx.integrationSyncState.updateMany({ where: { id: state.id, leaseToken: token }, data: { status: "FAILED", lastSyncCompletedAt: new Date(), lastErrorCode: academicError(cause).code, leaseToken: null, leaseUntil: null } });
                if (!changed.count)
                    return false;
                error("course", cause);
                result.partial = result.created.assignments + result.created.assessments + result.created.files + result.updated.assignments + result.updated.assessments + result.updated.files > 0;
                await tx.externalCourseLink.updateMany({ where: { id: link.id, userId }, data: { lastResult: result as unknown as Prisma.InputJsonValue, requestQueuedAt: null, nextSyncAt: new Date(Date.now() + academicSyncConfig().intervalMs) } });
                return true;
            });
            if (recorded) {
                academicEvent("PARTIAL_FAILURE", link.id, { created: result.created.assignments + result.created.assessments + result.created.files, updated: result.updated.assignments + result.updated.assessments + result.updated.files, failed: result.failed });
                await refreshRecommendationsBestEffort(userId);
            }
            throw academicError(cause);
        }
        async function syncFile(file: ExternalCourseFile) {
            if (fileImportReason(file)) {
                result.created.skipped++;
                return;
            }
            const where = { connectedAccountId_externalFileId_courseId: { connectedAccountId: accountId, externalFileId: file.externalId, courseId: link.courseId } };
            const mapping = await db().externalFileLink.findUnique({ where });
            if (mapping && (mapping.userId !== userId || mapping.externalCourseLinkId !== link.id))
                throw new AcademicIntegrationError("NOT_FOUND");
            if (mapping?.documentId && file.modifiedAt && sameDate(mapping.externalModifiedAt, file.modifiedAt) && await txDocumentReady(mapping.documentId)) {
                await db().$transaction(async (tx) => { await guard(tx, "files-read"); await tx.externalFileLink.update({ where: { id: mapping.id }, data: { lastCheckedAt: new Date(), syncStatus: "IDLE", errorCode: null } }); });
                result.unchanged++;
                return;
            }
            try {
                const bytes = await access.call(userId, accountId, "files-read", signal, (call, p) => p.downloadFile!(call, file, MAX_FILE_BYTES));
                if (!bytes.length || bytes.length > MAX_FILE_BYTES)
                    throw new DocumentError("File size is not supported.");
                const complete = async (tx: Prisma.TransactionClient, documentId: string) => {
                    const data = { documentId, name: file.name, externalMimeType: file.mimeType, externalModifiedAt: stamp(file.modifiedAt), importedAt: new Date(), lastCheckedAt: new Date(), webViewLink: safeAcademicUrl(file.externalUrl), syncStatus: "IDLE", errorCode: null };
                    await tx.externalFileLink.upsert({ where, create: { ...where.connectedAccountId_externalFileId_courseId, userId, provider: link.provider, externalCourseLinkId: link.id, ...data }, update: data });
                };
                if (mapping?.documentId) {
                    await replaceDocumentSource({ userId, documentId: mapping.documentId, courseId: link.courseId, fileName: file.name, bytes }, { guard: tx => guard(tx, "files-read"), complete: tx => complete(tx, mapping.documentId!), check: () => signal.throwIfAborted() });
                    result.updated.files++;
                }
                else {
                    const doc = await uploadDocument(userId, { title: file.name, courseId: link.courseId }, file.name, bytes, async (tx, doc) => { await guard(tx, "files-read"); await complete(tx, doc.id); });
                    await processNextDocument(undefined, doc.id);
                    result.created.files++;
                    const ready = await txDocumentReady(doc.id);
                    if (!ready)
                        throw new DocumentError("Imported document processing failed.");
                }
            }
            catch (cause) {
                await db().$transaction(async (tx) => {
                    await guard(tx, "files-read");
                    await tx.externalFileLink.updateMany({ where: { ...where.connectedAccountId_externalFileId_courseId, userId, externalCourseLinkId: link.id }, data: { syncStatus: "FAILED", errorCode: academicError(cause).code } });
                }).catch(() => { });
                throw cause;
            }
        }
        async function txDocumentReady(id: string) { return Boolean(await db().document.findFirst({ where: { id, userId, processingStatus: "READY" }, select: { id: true } })); }
    }
    async function settings(userId: string): Promise<AcademicSettings> {
        const providers = registry.list();
        const accounts = await db().connectedAccount.findMany({ where: { userId, provider: { in: providers.map(p => p.id) } }, select: { id: true, provider: true, displayName: true, email: true, status: true, scopes: true, connectionConfig: true } });
        return { providers: providers.filter(p => p.productionReady).map(p => ({ id: p.id, name: p.name })), accounts: accounts.map(a => ({ id: a.id, provider: a.provider, name: a.displayName ?? a.email ?? registry.get(a.provider).name, connected: ["ACTIVE", "ERROR"].includes(a.status), capabilities: [...registry.get(a.provider).grantedCapabilities({ id: a.id, userId, provider: a.provider, configuration: a.connectionConfig, grants: a.scopes })] })) };
    }
    async function listCourses(userId: string, accountId: string, cursor?: string) {
        return access.call(userId, accountId, "courses-read", AbortSignal.timeout(15000), async (call, p) => { const raw = await p.listCourses(call, { cursor, limit: academicSyncConfig().pageSize }); const parsed = z.object({ items: z.array(externalCourseSchema).max(25), nextCursor: z.string().max(2048).optional(), mode: z.literal("snapshot") }).safeParse(raw); if (!parsed.success || parsed.data.items.some(c => c.connectedAccountId !== accountId || c.provider !== p.id))
            throw new AcademicIntegrationError("INVALID_RESPONSE"); return parsed.data; });
    }
    async function disconnect(userId: string, accountId: string) { const account = await getOwnedConnection(userId, accountId); registry.get(account.provider); await revokeImportedConnection(userId, accountId, account.provider); return { disconnected: true }; }
    return { preview, importExternalCourse, requestSync, syncExternalCourse, status, settings, listCourses, disconnect };
}
export const academicIntegrationService = createAcademicIntegrationService();
