import "dotenv/config";
import { readFile } from "node:fs/promises";
import { validateRuntimeConfiguration } from "../server/operations/config";
import { bootstrapPlans } from "../server/operations/bootstrap";
import { db } from "../server/db/client";
import { createBackgroundJobBoss } from "../server/jobs/client";
import { ensureBackgroundJobQueues } from "../server/jobs/queue";
import { initializeMonitoring, reportError, flushMonitoring, logOperation } from "../server/operations/monitoring";
validateRuntimeConfiguration();
initializeMonitoring();
const boss = createBackgroundJobBoss("migration");
try {
  const file = process.env.PRODUCTION_PLANS_FILE;
  if (!file) throw new Error("An operator-reviewed PRODUCTION_PLANS_FILE is required");
  await bootstrapPlans(JSON.parse(await readFile(file, "utf8")));
  await boss.start();
  await ensureBackgroundJobQueues(boss);
  logOperation("info", "system-bootstrap-complete");
} catch (error) { reportError(error, { event: "system-bootstrap-failed" }); process.exitCode = 1; }
finally { await boss.stop(); await db().$disconnect(); await flushMonitoring(); }
