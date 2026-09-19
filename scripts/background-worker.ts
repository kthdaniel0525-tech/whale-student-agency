import "dotenv/config";
import { db } from "../server/db/client";
import {
  startBackgroundJobWorker,
  stopBackgroundJobWorker,
} from "../server/jobs/worker";

const boss = await startBackgroundJobWorker();
console.info("Background job worker started.");

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
await db().$disconnect();
console.info("Background job worker stopped safely.");
