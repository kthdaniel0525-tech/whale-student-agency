import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { db } from "@/server/db/client";
import { getEnv } from "@/server/env";

// Account-level throttling supplements IP limits without trusting forwarded headers.
// The upsert consumes an attempt atomically across all application instances.
export async function limitCredentialAttempts(email: string, action: string) {
  const key =
    "credential:" +
    createHmac("sha256", getEnv().BETTER_AUTH_SECRET)
      .update(`${action}:${email.trim().toLowerCase()}`)
      .digest("hex");
  const now = BigInt(Date.now());
  const cutoff = now - BigInt(900000);
  const rows = await db().$queryRaw<{ count: number; lastRequest: bigint }[]>`
    INSERT INTO "RateLimit" (id, key, count, "lastRequest")
    VALUES (${randomUUID()}, ${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN "RateLimit"."lastRequest" <= ${cutoff} THEN 1
                   ELSE LEAST("RateLimit".count + 1, 11) END,
      "lastRequest" = CASE WHEN "RateLimit"."lastRequest" <= ${cutoff} THEN ${now}
                           ELSE "RateLimit"."lastRequest" END
    RETURNING count, "lastRequest"
  `;
  return rows[0].count <= 10
    ? null
    : Math.max(
        1,
        Math.ceil((Number(rows[0].lastRequest) + 900000 - Number(now)) / 1000),
      );
}
