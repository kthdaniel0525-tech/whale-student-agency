import { GuardrailService } from "@/server/ai/guardrails/service";
import { createMemoryGuardStore } from "@/server/ai/guardrails/store";
import { DEFAULT_GUARDRAILS } from "@/server/ai/guardrails/config";
import { trackAIProvider } from "@/server/ai/usage/tracking";
import type { AIProvider } from "@/server/ai/types";
export const testGuards = () => new GuardrailService(createMemoryGuardStore(), () => structuredClone(DEFAULT_GUARDRAILS), async () => {});

/** Orchestration fixtures still exercise real pre-call and reconciliation logic.
 * A fresh deterministic store isolates students across test cases; the separate
 * PostgreSQL integration suite verifies shared production locking. */
export const guardedWorkflowFixture = (transport: AIProvider) => trackAIProvider(transport, {
  provider: "fixture", chatModel: "fixture", embeddingModel: "fixture", guards: testGuards(), write: async () => {},
  pricing: { version: "test", models: [{ provider: "fixture", model: "fixture", inputPerMillion: 0, outputPerMillion: 0 }] },
});

import { ProviderHealthService } from "@/server/ai/reliability/health";
import { DEFAULT_RELIABILITY } from "@/server/ai/reliability/config";
export const testHealth = () => new ProviderHealthService(createMemoryGuardStore(), () => structuredClone(DEFAULT_RELIABILITY), async () => {});
