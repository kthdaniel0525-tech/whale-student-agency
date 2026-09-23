import "server-only";
import { z } from "zod";
import { AIError } from "../errors";
const positive = z.number().int().positive();
const profile = z.object({ maxAttempts: positive.max(3), maxSameModelRetries: z.number().int().min(0).max(1), retryDelayMs: z.number().int().min(0).max(5000) }).strict();
export const DEFAULT_RELIABILITY = {
  interactive: { maxAttempts: 2, maxSameModelRetries: 1, retryDelayMs: 200 },
  background: { maxAttempts: 2, maxSameModelRetries: 1, retryDelayMs: 1000 },
  timeouts: { routing: 15000, text: 60000, structured: 90000, reasoning: 180000, embedding: 30000, background: 180000 },
  breaker: { windowMs: 300000, samples: 20, minimumSamples: 5, failureRate: .6, consecutiveFailures: 3, cooldownMs: 30000, rateLimitMs: 60000, authCooldownMs: 300000 },
  disabledProviders: [] as string[],
};
const schema = z.object({ interactive: profile, background: profile,
  timeouts: z.object({ routing: positive, text: positive, structured: positive, reasoning: positive, embedding: positive, background: positive }).strict(),
  breaker: z.object({ windowMs: positive, samples: positive.max(100), minimumSamples: positive.max(100), failureRate: z.number().min(.1).max(1), consecutiveFailures: positive, cooldownMs: positive, rateLimitMs: positive, authCooldownMs: positive }).strict(),
  disabledProviders: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)).max(100),
}).strict();
export type ReliabilityConfig = z.infer<typeof schema>;
export function getReliabilityConfig(): ReliabilityConfig {
  try {
    const raw = process.env.AI_RELIABILITY_JSON ? JSON.parse(process.env.AI_RELIABILITY_JSON) : {};
    return schema.parse({ ...DEFAULT_RELIABILITY, ...raw, interactive: { ...DEFAULT_RELIABILITY.interactive, ...raw.interactive },
      background: { ...DEFAULT_RELIABILITY.background, ...raw.background }, timeouts: { ...DEFAULT_RELIABILITY.timeouts, ...raw.timeouts }, breaker: { ...DEFAULT_RELIABILITY.breaker, ...raw.breaker } });
  } catch { throw new AIError("CONFIGURATION"); }
}
