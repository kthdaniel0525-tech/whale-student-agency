import "dotenv/config";
import { z } from "zod";
import { db } from "../server/db/client";
import { cohortSchema } from "../server/beta/config";
// Operator-only CLI. Never wired to a public route or populated from test fixtures.
const input = z.object({ userId: z.string().min(1).max(100), status: z.enum(["invited", "active", "revoked"]), cohort: cohortSchema, internal: z.enum(["true", "false"]).default("false") }).parse({ userId: process.argv[2], status: process.argv[3], cohort: process.argv[4], internal: process.argv[5] });
try {
  const user = await db().user.findFirst({ where: { id: input.userId, deletionRequestedAt: null }, select: { id: true } });
  if (!user) throw new Error("Account not found.");
  await db().betaAccess.upsert({ where: { userId: input.userId }, create: { ...input, internal: input.internal === "true", source: "operator", ...(input.status === "active" ? { activatedAt: new Date() } : {}) }, update: { status: input.status, cohort: input.cohort, internal: input.internal === "true", ...(input.status === "active" ? { activatedAt: new Date() } : {}) } });
  console.info("Beta access updated.");
} finally { await db().$disconnect(); }
