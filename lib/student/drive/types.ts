import { z } from "zod";
export const driveFileId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const driveResourceSchema = z.object({ connectedAccountId: z.string().min(1).max(100), externalFileId: driveFileId, courseId: z.string().min(1).max(100) }).strict();
export const driveListSchema = z.object({ search: z.string().trim().max(100).optional(), folderId: driveFileId.optional(), pageToken: z.string().min(1).max(2048).optional() }).strict();
export type DriveResource = z.infer<typeof driveResourceSchema>;
export type ExternalDriveFile = {
    externalId: string;
    name: string;
    mimeType: string;
    modifiedAt: string;
    size: number | null;
    parentIds: string[];
    webViewLink: string | null;
    exportable: boolean;
    folder: boolean;
    provider: "google";
    connectedAccountId: string;
    importable: boolean;
    unavailableReason: string | null;
};
export type DriveFilePage = {
    files: ExternalDriveFile[];
    nextPageToken: string | null;
};
export type DriveImportView = {
    id: string;
    name: string;
    documentId: string | null;
    courseId: string;
    status: "Importing" | "Processing" | "Ready" | "Failed";
    syncStatus: string;
    error: string | null;
};
export type DriveSettings = {
    health?: import("../integrations/health").IntegrationHealth;
    enabled: boolean;
    needsReconnect: boolean;
    importedCount: number;
    lastSuccessfulAccess: string | null;
};
export type DocumentExternalSource = {
    provider: string;
    syncStatus: string;
    webViewLink: string | null;
};
