import "server-only";
import { Pool } from "pg";
import { readdir, readFile, access, open, unlink } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { getEnv } from "../env";
import { operationsConfig } from "./config";
import { documentConfig } from "../documents/config";
import { RAG_EMBEDDING } from "../ai/config";
import { basePlanCode } from "../entitlements/config";
import { entitlementSchema } from "@/lib/entitlements/types";

let pool: Pool | undefined;
export function healthPool() {
  return pool ??= new Pool({ connectionString: getEnv().DATABASE_URL, max: 2, connectionTimeoutMillis: 1500, statement_timeout: 2000, query_timeout: 2500, idleTimeoutMillis: 10000, allowExitOnIdle: true });
}
export async function migrationManifest() {
  const directory = path.join(process.cwd(), "prisma/migrations");
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.filter(e => e.isDirectory()).map(async e => ({ name: e.name, checksum: createHash("sha256").update(await readFile(path.join(directory, e.name, "migration.sql"))).digest("hex") })));
}
export function migrationsReady(expected: { name: string; checksum: string }[], actual: { migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }[]) {
  return expected.length > 0 && !actual.some(row => !row.finished_at && !row.rolled_back_at) && expected.every(e => actual.some(a => a.migration_name === e.name && a.checksum === e.checksum && a.finished_at && !a.rolled_back_at));
}
export async function checkDatabase() {
  const connection = healthPool();
  const [migrations, vector, plan, expected] = await Promise.all([
    connection.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"'),
    connection.query("SELECT extversion FROM pg_extension WHERE extname='vector'"),
    connection.query('SELECT entitlements FROM "Plan" WHERE code=$1 AND active=true AND internal=false', [basePlanCode()]),
    migrationManifest(),
  ]);
  if (!migrationsReady(expected, migrations.rows) || vector.rows[0]?.extversion !== "0.8.2" || !entitlementSchema.safeParse(plan.rows[0]?.entitlements).success) throw new Error("Database is not ready");
}
export async function checkRuntimeStorage() {
  const config = documentConfig();
  const probe = path.join(config.storage, `.readiness-${randomUUID()}`);
  const file = await open(probe, "wx", 0o600);
  await file.close();
  await unlink(probe);
  const model = path.join(config.modelCache, RAG_EMBEDDING.model, RAG_EMBEDDING.revision);
  await Promise.all(["tokenizer.json", "tokenizer_config.json", "config.json", "onnx/model_quantized.onnx"].map(name => access(path.join(model, name))));
}
type ReadinessDependencies = { database: () => Promise<void>; storage: () => Promise<void> };
export async function checkReadiness(dependencies: ReadinessDependencies = { database: checkDatabase, storage: checkRuntimeStorage }): Promise<boolean> {
  const results = await Promise.allSettled([dependencies.database(), dependencies.storage()]);
  return results.every(result => result.status === "fulfilled");
}
let cached: { expires: number; value: Promise<boolean> } | undefined;
export function cachedReadiness() {
  if (!cached || cached.expires < Date.now()) cached = { expires: Date.now() + 10000, value: checkReadiness() };
  return cached.value;
}
export function operationsAuthorized(request: Request) {
  const token = operationsConfig().OPERATIONS_TOKEN;
  const supplied = request.headers.get("authorization");
  if (!token || !supplied || supplied.length > 512) return false;
  const expected = Buffer.from(`Bearer ${token}`), received = Buffer.from(supplied);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
