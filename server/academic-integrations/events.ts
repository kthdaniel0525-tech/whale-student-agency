import "server-only";
export function academicEvent(event: "IMPORT" | "SYNC_STARTED" | "SYNC_COMPLETED" | "PARTIAL_FAILURE" | "AUTH_FAILURE", courseLinkId?: string, counts?: {
    created: number;
    updated: number;
    failed: number;
}) { console.info("Academic integration", { event, courseLinkId, ...counts }); }
