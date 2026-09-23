import "server-only";
import { hostname } from "node:os";
import { db } from "../db/client";
import { operationsConfig } from "./config";
import { reportError } from "./monitoring";
export async function startHeartbeat(role: "jobs" | "documents") {
  const id = `${role}:${hostname()}`;
  const release = operationsConfig().RELEASE_SHA;
  let writing: Promise<void> | undefined;
  const beat = () => writing ??= (async () => {
      await db().runtimeHeartbeat.upsert({ where: { id }, create: { id, role, release }, update: { seenAt: new Date() } });
      await db().runtimeHeartbeat.deleteMany({ where: { seenAt: { lt: new Date(Date.now() - 7 * 86400000) } } });
  })().finally(() => { writing = undefined; });
  await beat();
  const timer = setInterval(() => { void beat().catch(error => reportError(error, { event: "heartbeat-failed", jobName: role })); }, 30000);
  timer.unref();
  return async () => { clearInterval(timer); await writing?.catch(() => {}); await db().runtimeHeartbeat.deleteMany({ where: { id } }); };
}
