import "dotenv/config";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
// Read-only baseline. Select an explicitly designated synthetic user for useful
// staging measurements; default has no content and checks SQL/index compatibility.
const user = process.env.PERF_SYNTHETIC_USER_ID || `perf-${randomUUID()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 5000 });
const queries = {
  dashboard: 'SELECT id FROM "Assignment" WHERE "userId"=$1 ORDER BY "dueDate" LIMIT 20',
  aiWorkspace: 'SELECT id FROM "Conversation" WHERE "userId"=$1 ORDER BY "updatedAt" DESC LIMIT 20',
  courseWorkspace: 'SELECT id FROM "Course" WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 20',
  progress: 'SELECT "topicId" FROM "LearningProgress" WHERE "userId"=$1 ORDER BY "masteryScore" LIMIT 20',
  recommendations: 'SELECT id FROM "Recommendation" WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 20',
  calendar: 'SELECT id FROM "CalendarIntegrationPreference" WHERE "userId"=$1 AND "enabledForAvailability"=true',
  documents: 'SELECT c.id FROM "DocumentChunk" c JOIN "Document" d ON d.id=c."documentId" AND d."userId"=c."userId" WHERE c."userId"=$1 AND d."userId"=$1 AND d."processingStatus"=\'READY\' LIMIT 20',
};
try {
  for (const [name, sql] of Object.entries(queries)) {
    const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [user]);
    const plan = result.rows[0]["QUERY PLAN"][0];
    console.info(JSON.stringify({ path: name, planningMs: plan["Planning Time"], executionMs: plan["Execution Time"], fixture: process.env.PERF_SYNTHETIC_USER_ID ? "designated-synthetic" : "empty-synthetic" }));
  }
} finally { await pool.end(); }
