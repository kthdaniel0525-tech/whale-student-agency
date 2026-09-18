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
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "Unknown migration error").trim();
    throw new Error(`Migration to the fresh database failed.\n${details}`);
  }
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
      "MemoryObservation",
      "Session",
      "Account",
      "Verification",
      "RateLimit",
      "Document",
      "DocumentChunk",
      "DocumentPage",
      "FileDeletion",
      "Quiz",
      "QuizQuestion",
      "LearningTopic",
      "QuizQuestionTopic",
      "QuizAttempt",
      "QuestionAttempt",
      "LearningProgress",
      "LearningProgressSnapshot",
      "StudyPlan",
      "StudyTask",
      "CareerProfile",
      "Project",
      "Skill",
      "WorkflowRun",
      "WorkflowStepRun",
      "CareerPlan",
      "CareerTask",
      "Conversation",
      "ConversationMessage",
      "ConversationSummary",
      "AdaptiveOutcome",
      "Recommendation",
    ]) {
      if (!tables.rows.some((row) => row.tablename === table))
        throw new Error(`Missing ${table} table.`);
    }
    const migration = await verify.query(
      'SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    if (migration.rows[0].count !== 16)
      throw new Error("Unexpected applied migration count.");
    const memoryColumns = await verify.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='UserMemory'
       AND column_name IN ('category','sourceType','confidence','importance','status','firstObservedAt','lastObservedAt','embedding','embeddingModel','embeddingValueHash')`,
    );
    if (memoryColumns.rows.length !== 10)
      throw new Error("Missing memory personalization columns.");
    const waiting = await verify.query(
      `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=enumtypid
       WHERE typname='WorkflowRunStatus' AND enumlabel='WAITING_FOR_INPUT'`,
    );
    const budget = await verify.query(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='WorkflowRun' AND column_name='activeDurationMs' AND is_nullable='NO'`,
    );
    if (waiting.rows.length !== 1 || budget.rows[0]?.column_default !== "0")
      throw new Error("Missing workflow wait state or persisted execution budget.");
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
      "Fresh PostgreSQL migration verified: 37 tables, 16 migrations, course workspace indexes, learning progress snapshots, proactive recommendations, adaptive outcomes, conversation memory, semantic vectors, pgvector 0.8.2 and file-deletion trigger.",
    );
  } finally {
    await verify.end();
  }
} finally {
  if (created) await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
}
