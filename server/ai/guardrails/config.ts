import "server-only";
import { z } from "zod";
import { AIError } from "../errors";
import { MODEL_TIERS } from "../routing/types";
const positive = z.number().int().positive();
export const budgetSchema = z.object({ maxAICalls: positive, maxEmbeddingCalls: positive, maxInputTokens: positive,
  maxOutputTokens: positive, maxTotalTokens: positive, maxWorkflowSteps: positive, deadlineMs: positive.max(900000),
  maxRepeatedCalls: positive, maxAgentCalls: positive, softCostUsd: z.number().positive(), qualityFloorTier: z.enum(MODEL_TIERS) });
export type AIExecutionBudget = z.infer<typeof budgetSchema>;
export const PROFILES = ["SIMPLE", "STANDARD", "COMPLEX", "WORKFLOW", "HIGH_COMPLEXITY", "BACKGROUND"] as const;
export type BudgetProfile = typeof PROFILES[number];
const standard: AIExecutionBudget = { maxAICalls: 8, maxEmbeddingCalls: 40, maxInputTokens: 500000, maxOutputTokens: 150000,
  maxTotalTokens: 600000, maxWorkflowSteps: 8, deadlineMs: 300000, maxRepeatedCalls: 2, maxAgentCalls: 5,
  softCostUsd: 5, qualityFloorTier: "BALANCED" };
export const DEFAULT_GUARDRAILS = {
  profiles: {
    SIMPLE: { ...standard, maxAICalls: 4, maxAgentCalls: 3, qualityFloorTier: "FAST" },
    STANDARD: standard,
    COMPLEX: { ...standard, maxAICalls: 12, maxInputTokens: 1000000, maxTotalTokens: 1500000, qualityFloorTier: "STRONG" },
    WORKFLOW: { ...standard, maxAICalls: 40, maxEmbeddingCalls: 256, maxInputTokens: 2000000, maxOutputTokens: 500000, maxTotalTokens: 2500000, maxAgentCalls: 32, deadlineMs: 600000, qualityFloorTier: "FAST", softCostUsd: 15 },
    HIGH_COMPLEXITY: { ...standard, maxAICalls: 24, maxInputTokens: 2000000, maxOutputTokens: 500000, maxTotalTokens: 2500000, deadlineMs: 600000, qualityFloorTier: "STRONG", softCostUsd: 15 },
    BACKGROUND: { ...standard, maxAICalls: 12, maxEmbeddingCalls: 512, maxInputTokens: 2000000, maxTotalTokens: 2200000, deadlineMs: 600000, qualityFloorTier: "FAST" },
  } as Record<BudgetProfile, AIExecutionBudget>,
  rates: { interactiveMinute: 60, interactiveHour: 600, workflowHour: 60, embeddingMinute: 1200, embeddingHour: 6000, backgroundHour: 120 },
  concurrency: { user: 4, provider: 24, model: 12, background: 4 },
  maxContextTokens: 1000000, maxEmbeddingInputTokens: 12000, userSoftCostUsd: 50, workflowHelperCalls: 20,
  disableAllAI: false, disableBackgroundAI: false, disabledFeatures: [] as string[],
};
const configSchema = z.object({ profiles: z.object(Object.fromEntries(PROFILES.map(p => [p, budgetSchema])) as Record<BudgetProfile, typeof budgetSchema>),
  rates: z.object({ interactiveMinute: positive, interactiveHour: positive, workflowHour: positive, embeddingMinute: positive, embeddingHour: positive, backgroundHour: positive }),
  concurrency: z.object({ user: positive, provider: positive, model: positive, background: positive }),
  maxContextTokens: positive, maxEmbeddingInputTokens: positive, userSoftCostUsd: z.number().positive(), workflowHelperCalls: positive,
  disableAllAI: z.boolean(), disableBackgroundAI: z.boolean(), disabledFeatures: z.array(z.string().min(1).max(100)).max(100) }).strict();
export type GuardrailConfig = z.infer<typeof configSchema>;
export function getGuardrailConfig(): GuardrailConfig {
  try {
    const raw = process.env.AI_GUARDRAILS_JSON ? JSON.parse(process.env.AI_GUARDRAILS_JSON) : {};
    return configSchema.parse({ ...DEFAULT_GUARDRAILS, ...raw,
      profiles: Object.fromEntries(PROFILES.map(p => [p, { ...DEFAULT_GUARDRAILS.profiles[p], ...raw.profiles?.[p] }])),
      rates: { ...DEFAULT_GUARDRAILS.rates, ...raw.rates }, concurrency: { ...DEFAULT_GUARDRAILS.concurrency, ...raw.concurrency } });
  } catch { throw new AIError("CONFIGURATION"); }
}
