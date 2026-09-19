import "server-only";
import { recordIntegrationMetric } from "../integrations/metrics";
export function driveEvent(event: "IMPORT_REQUESTED" | "IMPORT_SUCCESS" | "IMPORT_FAILURE" | "REFRESH_SUCCESS" | "REFRESH_FAILURE" | "SOURCE_UNAVAILABLE" | "TOKEN_SCOPE_ERROR", linkId?: string) {
    if (["IMPORT_SUCCESS", "REFRESH_SUCCESS"].includes(event)) recordIntegrationMetric("importsProcessed");
    console.info("Drive integration", { event, ...(linkId ? { linkId } : {}) });
}
