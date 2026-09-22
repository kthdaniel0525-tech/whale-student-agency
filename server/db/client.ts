import "server-only";
import { operationsConfig } from "../operations/config";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getEnv } from "@/server/env";
const globalDb = globalThis as unknown as { studentDb?: PrismaClient };
export function db() {
  if (!globalDb.studentDb) {
    globalDb.studentDb = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: getEnv().DATABASE_URL,
        max: operationsConfig().DATABASE_POOL_MAX,
        connectionTimeoutMillis: 5000,
      }),
    });
  }
  return globalDb.studentDb;
}
