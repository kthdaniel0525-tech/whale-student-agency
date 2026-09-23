import "dotenv/config";
import { validateRuntimeConfiguration } from "../server/operations/config";
import { startHeartbeat } from "../server/operations/heartbeat";
import { initializeMonitoring, flushMonitoring, logOperation, reportError } from "../server/operations/monitoring";
import { db } from "../server/db/client";
import {
  startBackgroundJobWorker,
  stopBackgroundJobWorker,
} from "../server/jobs/worker";

async function main() {
validateRuntimeConfiguration();
initializeMonitoring();
const boss = await startBackgroundJobWorker();
const stopHeartbeat = await startHeartbeat("jobs");
logOperation("info", "background-worker-started");

await new Promise<void>((resolve) => {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    resolve();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});

await stopBackgroundJobWorker(boss);
await stopHeartbeat();
await db().$disconnect();
logOperation("info", "background-worker-stopped");
await flushMonitoring();

}
try { await main(); } catch (error) {
  try { reportError(error, { jobName: "background-worker" }); await flushMonitoring(); } catch { console.error(JSON.stringify({ event: "worker-startup-failed" })); }
  await db().$disconnect().catch(() => {}); process.exit(1);
}
