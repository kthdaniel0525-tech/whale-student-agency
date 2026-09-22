import "dotenv/config";
import { validateRuntimeConfiguration } from "../server/operations/config";
import { startHeartbeat } from "../server/operations/heartbeat";
import { initializeMonitoring, flushMonitoring, logOperation, reportError } from "../server/operations/monitoring";
import { processNextDocument } from "../server/documents/processor";
import { cleanupFiles, reconcileStorage } from "../server/documents/cleanup";
import { db } from "../server/db/client";
async function main() {
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
validateRuntimeConfiguration();
initializeMonitoring();
const stopHeartbeat = await startHeartbeat("documents");
logOperation("info", "document-worker-started");
let lastReconcile = 0;
while (!stopped) {
  process.send?.({ type: "progress" });
  try {
    await cleanupFiles();
    if (Date.now() - lastReconcile > 60000) {
      await reconcileStorage();
      lastReconcile = Date.now();
    }
    const processed = await processNextDocument();
    if (process.argv.includes("--once")) break;
    if (!processed) await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (e) {
    reportError(e, { jobName: "document-processing" });
    if (process.argv.includes("--once")) {
      process.exitCode = 1;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
await stopHeartbeat();
await db().$disconnect();
await flushMonitoring();

}
try { await main(); } catch (error) {
  try { reportError(error, { jobName: "document-worker" }); await flushMonitoring(); } catch { console.error(JSON.stringify({ event: "worker-startup-failed" })); }
  await db().$disconnect().catch(() => {}); process.exit(1);
}
