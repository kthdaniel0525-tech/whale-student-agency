import "dotenv/config";
import { processNextDocument } from "../server/documents/processor";
import { cleanupFiles, reconcileStorage } from "../server/documents/cleanup";
import { db } from "../server/db/client";
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
});
console.log("Document worker started. Processing private queued documents.");
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
    console.error("Document worker will retry", {
      type: e instanceof Error ? e.name : "UnknownError",
    });
    if (process.argv.includes("--once")) {
      process.exitCode = 1;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
await db().$disconnect();
