import "server-only";
import { PgBoss } from "pg-boss";
import { getBackgroundJobConfig } from "./config";

export type BackgroundJobPublisher = Pick<PgBoss, "sendDebounced">;

export function createBackgroundJobBoss(
  role: "publisher" | "worker" | "migration",
  overrides: { connectionString?: string; schema?: string } = {},
): PgBoss {
  const config = getBackgroundJobConfig();
  return new PgBoss({
    connectionString: overrides.connectionString ?? config.connectionString,
    schema: overrides.schema ?? config.schema,
    application_name: `student-agency-background-${role}`,
    max: role === "worker" ? config.workerConcurrency + 4 : 2,
    connectionTimeoutMillis: 5000,
    createSchema: role === "migration" || role === "worker" && process.env.NODE_ENV !== "production",
    migrate: role === "migration" || role === "worker" && process.env.NODE_ENV !== "production",
    supervise: role === "worker",
    schedule: role === "worker" && config.scheduleEnabled,
    useListenNotify: role === "worker",
  });
}

let publisherPromise: Promise<PgBoss> | undefined;

export function getBackgroundJobPublisher(): Promise<PgBoss> {
  publisherPromise ??= createBackgroundJobBoss("publisher").start()
    .catch((error) => {
      publisherPromise = undefined;
      throw error;
    });
  return publisherPromise;
}

export async function stopBackgroundJobPublisher(): Promise<void> {
  if (!publisherPromise) return;
  const publisher = await publisherPromise.catch(() => null);
  publisherPromise = undefined;
  if (publisher) await publisher.stop({ graceful: true, timeout: 5000 });
}
