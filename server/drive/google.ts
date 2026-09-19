import "server-only";
import { z } from "zod";
import { MAX_FILE_BYTES } from "../documents/config";
import { IntegrationError } from "../integrations/errors";
import { withProviderClient, updateIntegrationSyncState } from "../integrations/service";
import { driveFileId, driveListSchema, type ExternalDriveFile, type DriveFilePage } from "@/lib/student/drive/types";
const DOC = "application/vnd.google-apps.document", FOLDER = "application/vnd.google-apps.folder";
const fields = "id,name,mimeType,modifiedTime,size,parents,webViewLink,trashed,capabilities(canDownload)";
const fileSchema = z.object({ id: driveFileId, name: z.string().min(1).max(1024), mimeType: z.string().max(200), modifiedTime: z.string().datetime({ offset: true }).optional(),
    size: z.string().regex(/^\d+$/).optional(), parents: z.array(driveFileId).max(100).optional(), webViewLink: z.string().max(2048).optional(), trashed: z.boolean().optional(), capabilities: z.object({ canDownload: z.boolean().optional() }).optional() });
export function safeDriveLink(value?: string | null): string | null {
    try {
        const url = new URL(value ?? "");
        return url.protocol === "https:" && ["drive.google.com", "docs.google.com"].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : null;
    }
    catch {
        return null;
    }
}
function representation(name: string, mime: string) {
    if (mime === DOC)
        return "pdf";
    const ext = name.split(".").pop()?.toLowerCase();
    if (mime === "application/pdf" && ext === "pdf")
        return ext;
    if (["text/plain", "text/markdown", "text/x-markdown"].includes(mime) && ["txt", "md", "markdown"].includes(ext ?? ""))
        return ext;
    return null;
}
export function driveDownloadName(file: ExternalDriveFile) {
    const ext = representation(file.name, file.mimeType);
    if (!ext || !file.importable)
        throw new IntegrationError("INVALID_REQUEST");
    const name = file.name.replace(/[\/\\\x00-\x1f]/g, "_").slice(0, 180);
    return file.exportable ? `${name.replace(/\.pdf$/i, "")}.pdf` : `${file.name.replace(/[\/\\\x00-\x1f]/g, "_").replace(/\.[^.]*$/, "").slice(0, 180)}.${ext}`;
}
function normalize(raw: unknown, accountId: string): ExternalDriveFile {
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success)
        throw new IntegrationError("INVALID_RESPONSE");
    const file = parsed.data, size = file.size === undefined ? null : Number(file.size);
    if (size !== null && !Number.isSafeInteger(size))
        throw new IntegrationError("INVALID_RESPONSE");
    const reason = file.trashed ? "The source is in the trash." : file.mimeType === FOLDER ? "Open this folder to select files." :
        !representation(file.name, file.mimeType) ? "Supported: PDF, TXT, Markdown and Google Docs." :
            file.capabilities?.canDownload === false ? "This file does not allow download." :
                size !== null && size > MAX_FILE_BYTES ? "Files must be 10 MB or smaller." : null;
    if (!file.modifiedTime && file.mimeType !== FOLDER)
        throw new IntegrationError("INVALID_RESPONSE");
    return { externalId: file.id, name: file.name, mimeType: file.mimeType, modifiedAt: file.modifiedTime ?? new Date(0).toISOString(), size,
        parentIds: file.parents ?? [], webViewLink: safeDriveLink(file.webViewLink), exportable: file.mimeType === DOC, folder: file.mimeType === FOLDER,
        provider: "google", connectedAccountId: accountId, importable: !reason, unavailableReason: reason };
}
const escapeQuery = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
export class GoogleDriveService {
    async authorize(userId: string, connectedAccountId: string) {
        return withProviderClient({ userId, connectedAccountId, provider: "google", capability: "drive-read" }, async () => { });
    }
    async list(userId: string, connectedAccountId: string, raw: unknown = {}): Promise<DriveFilePage> {
        const input = driveListSchema.parse(raw);
        const q = ["trashed = false", ...(input.search ? [`name contains '${escapeQuery(input.search)}'`] : []), ...(input.folderId ? [`'${input.folderId}' in parents`] : [])].join(" and ");
        const result = await withProviderClient({ userId, connectedAccountId, provider: "google", capability: "drive-read" }, async (client) => {
            const data = await client.read({ path: "files", query: { q, pageSize: "30", orderBy: "folder,modifiedTime desc", spaces: "drive", fields: `nextPageToken,files(${fields})`, ...(input.pageToken ? { pageToken: input.pageToken } : {}) } });
            const page = z.object({ files: z.array(z.unknown()).max(30).default([]), nextPageToken: z.string().max(2048).optional() }).safeParse(data);
            if (!page.success)
                throw new IntegrationError("INVALID_RESPONSE");
            return { files: page.data.files.map(file => normalize(file, connectedAccountId)), nextPageToken: page.data.nextPageToken ?? null };
        });
        await updateIntegrationSyncState(userId, connectedAccountId, "drive-read", { status: "COMPLETED" });
        return result;
    }
    async metadata(userId: string, connectedAccountId: string, externalFileId: string) {
        driveFileId.parse(externalFileId);
        return withProviderClient({ userId, connectedAccountId, provider: "google", capability: "drive-read" }, async (client) => {
            const file = normalize(await client.read({ path: `files/${externalFileId}`, query: { fields, supportsAllDrives: "true" } }), connectedAccountId);
            if (file.externalId !== externalFileId)
                throw new IntegrationError("INVALID_RESPONSE");
            if (file.unavailableReason === "The source is in the trash.")
                throw new IntegrationError("RESOURCE_NOT_FOUND");
            return file;
        });
    }
    async download(userId: string, file: ExternalDriveFile) {
        if (!file.importable)
            throw new IntegrationError(file.size !== null && file.size > MAX_FILE_BYTES ? "FILE_TOO_LARGE" : "INVALID_REQUEST");
        return withProviderClient({ userId, connectedAccountId: file.connectedAccountId, provider: "google", capability: "drive-read" }, async (client) => {
            if (!client.download)
                throw new IntegrationError("INVALID_REQUEST");
            return client.download({ path: `files/${file.externalId}${file.exportable ? "/export" : ""}`, maxBytes: MAX_FILE_BYTES,
                query: file.exportable ? { mimeType: "application/pdf" } : { alt: "media", supportsAllDrives: "true" } });
        });
    }
}
export const googleDriveService = new GoogleDriveService();
