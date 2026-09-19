import "server-only";
export function driveEvent(event: "IMPORT_REQUESTED" | "IMPORT_SUCCESS" | "IMPORT_FAILURE" | "REFRESH_SUCCESS" | "REFRESH_FAILURE" | "SOURCE_UNAVAILABLE" | "TOKEN_SCOPE_ERROR", linkId?: string) {
    console.info("Drive integration", { event, ...(linkId ? { linkId } : {}) });
}
