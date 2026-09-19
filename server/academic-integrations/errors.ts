import "server-only";
import { IntegrationError } from "../integrations/errors";
const messages = { SYNC_CHECKPOINT_EXPIRED: "The provider needs a fresh course read.", NOT_FOUND: "This academic connection or course is unavailable.", DISCONNECTED: "Reconnect your academic account before syncing.", AUTHORIZATION_REQUIRED: "This account does not grant the required academic access.", PROVIDER_UNAVAILABLE: "The academic provider is temporarily unavailable. Try syncing again later.", INVALID_RESPONSE: "The academic provider returned unsupported data.", INVALID_REQUEST: "Check your course import choices.", PREVIEW_EXPIRED: "Course details changed or the preview expired. Review a new preview before importing.", LIMIT: "This course exceeds the bounded import limit. Choose fewer import categories.", CONFLICT: "This course already has an academic source, or another sync is running.", STORAGE_FAILURE: "The course could not be imported or synced. Your existing data is preserved.", CONFIGURATION: "No production LMS connection is available yet." } as const;
export class AcademicIntegrationError extends Error {
    readonly status: number;
    constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = "AcademicIntegrationError"; this.status = code === "NOT_FOUND" ? 404 : ["DISCONNECTED", "AUTHORIZATION_REQUIRED"].includes(code) ? 403 : code === "CONFLICT" ? 409 : ["STORAGE_FAILURE", "PROVIDER_UNAVAILABLE", "CONFIGURATION"].includes(code) ? 503 : 400; }
}
export function academicError(error: unknown) {
    if (error instanceof AcademicIntegrationError)
        return error;
    if (error instanceof IntegrationError) {
        if (error.code === "NOT_FOUND")
            return new AcademicIntegrationError("NOT_FOUND");
        if (["DISCONNECTED", "RECONNECT_REQUIRED", "INVALID_GRANT"].includes(error.code))
            return new AcademicIntegrationError("DISCONNECTED");
        if (error.code === "AUTHORIZATION_REQUIRED")
            return new AcademicIntegrationError("AUTHORIZATION_REQUIRED");
        if (error.code === "PROVIDER_UNAVAILABLE")
            return new AcademicIntegrationError("PROVIDER_UNAVAILABLE");
    }
    if (error instanceof Error && "code" in error && error.code === "P2002")
        return new AcademicIntegrationError("CONFLICT");
    return new AcademicIntegrationError("STORAGE_FAILURE");
}
