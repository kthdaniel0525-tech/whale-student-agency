import "dotenv/config";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

// Test only a fresh, randomly named database. Never reset the application database.
const name = `student_migration_${randomBytes(8).toString("hex")}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.pathname = `/${name}`;
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const result = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    throw new Error("Migration to the fresh database failed.");
  const verify = new Pool({ connectionString: testUrl.toString() });
  try {
    const tables = await verify.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    );
    for (const table of [
      "User",
      "Profile",
      "Course",
      "Assignment",
      "Exam",
      "UserMemory",
      "Session",
      "Account",
      "Verification",
      "RateLimit",
      "Document",
      "DocumentChunk",
      "DocumentPage",
      "FileDeletion",
    ]) {
      if (!tables.rows.some((row) => row.tablename === table))
        throw new Error(`Missing ${table} table.`);
    }
    const migration = await verify.query(
      'SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    if (migration.rows[0].count !== 2)
      throw new Error("Unexpected applied migration count.");
    const vector = await verify.query(
      "SELECT extversion FROM pg_extension WHERE extname='vector'",
    );
    if (vector.rows[0]?.extversion !== "0.8.2")
      throw new Error("Expected pgvector 0.8.2.");
    const trigger = await verify.query(
      "SELECT tgname FROM pg_trigger WHERE tgname='document_file_cleanup' AND NOT tgisinternal",
    );
    if (trigger.rows.length !== 1)
      throw new Error("Missing durable file-deletion trigger.");
    console.log(
      "Fresh PostgreSQL migration verified: 14 tables, 2 migrations, pgvector 0.8.2 and file-deletion trigger.",
    );
  } finally {
    await verify.end();
  }
} finally {
  if (created) await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
}
