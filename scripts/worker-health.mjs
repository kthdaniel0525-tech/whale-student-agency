import { Pool } from "pg";
import { hostname } from "node:os";
const role = process.argv[2];
if (!["jobs", "documents"].includes(role)) process.exit(1);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 2000 });
try {
  const result = await pool.query('SELECT 1 FROM "RuntimeHeartbeat" WHERE id=$1 AND release=$2 AND "seenAt">NOW()-INTERVAL \'90 seconds\' LIMIT 1', [`${role}:${hostname()}`, process.env.RELEASE_SHA]);
  process.exitCode = result.rowCount ? 0 : 1;
} catch { process.exitCode = 1; } finally { await pool.end(); }
