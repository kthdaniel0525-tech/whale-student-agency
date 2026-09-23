import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { validateRuntimeConfiguration } from "../server/operations/config";
validateRuntimeConfiguration();
const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
// Application login cannot administer roles or drop migrator-owned tables.
// Queue DDL is confined to its own schema, owned by the runtime role.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  await pool.query('GRANT USAGE ON SCHEMA public TO agency_app');
  await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agency_app');
  await pool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agency_app');
  await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agency_app');
  await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO agency_app');
} finally { await pool.end(); }
