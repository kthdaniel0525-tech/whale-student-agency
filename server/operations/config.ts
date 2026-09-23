import { betaConfig } from "../beta/config";
import { analyticsConfig } from "../product-analytics/config";
import "server-only";
import path from "node:path";
import { z } from "zod";
import { validateSecurityConfiguration } from "../security/startup";
import { getAIConfig, RAG_EMBEDDING } from "../ai/config";
import { getModelCatalog, DEFAULT_MODEL_CATALOG } from "../ai/routing/catalog";
import { getGuardrailConfig } from "../ai/guardrails/config";
import { getReliabilityConfig } from "../ai/reliability/config";
import { featureFlags } from "../entitlements/config";
import { getBackgroundJobConfig } from "../jobs/config";
import { documentConfig } from "../documents/config";
import { billingConfig } from "../billing/config";

const flag = z.enum(["true", "false"]);
export function operationsConfig() {
  const result = z.object({
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default(process.env.NODE_ENV === "production" ? "production" : "development"),
    APP_URL: z.string().url().optional(),
    RELEASE_SHA: z.string().regex(/^[a-zA-Z0-9._-]{7,80}$/).default("development"),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(30).default(8),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    OPERATIONS_TOKEN: z.string().min(32).optional(),
    ERROR_MONITORING_ENABLED: flag.optional(),
    SENTRY_DSN: z.string().url().optional(),
    SIGNUP_ENABLED: flag.default("true"),
    SIGNUP_EMAIL_ALLOWLIST: z.string().optional(),
  }).safeParse(process.env);
  if (!result.success) throw new Error("Invalid operations configuration. Check deployment environment variables.");
  const env = result.data;
  return { ...env, deployed: ["staging", "production"].includes(env.APP_ENV),
    monitoringEnabled: env.ERROR_MONITORING_ENABLED === "true" || env.ERROR_MONITORING_ENABLED === undefined && ["staging", "production"].includes(env.APP_ENV) };
}

export function signupAllowed(email: string): boolean {
  const config = operationsConfig();
  if (config.SIGNUP_ENABLED === "false") return false;
  const allowlist = config.SIGNUP_EMAIL_ALLOWLIST?.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  return (!betaConfig().enabled && !allowlist?.length) || !!allowlist?.includes(email.trim().toLowerCase());
}

/** No network requests; builds need no secrets, all runtime roles fail closed. */
export function validateRuntimeConfiguration() {
  validateSecurityConfiguration();
  const config = operationsConfig();
  const catalog = getModelCatalog();
  const ai = getAIConfig();
  const guard = getGuardrailConfig();
  getReliabilityConfig(); featureFlags(); getBackgroundJobConfig(); betaConfig(); analyticsConfig();
  const documents = documentConfig();
  if (!config.deployed) return config;
  const requireValue = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
  requireValue(process.env.NODE_ENV === "production", "Deployed environments require production runtime mode.");
  requireValue(config.APP_URL && config.APP_URL === process.env.BETTER_AUTH_URL && new URL(config.APP_URL).protocol === "https:", "APP_URL must equal the canonical HTTPS authentication origin.");
  requireValue(config.RELEASE_SHA !== "development", "Deployed environments require RELEASE_SHA.");
  requireValue(config.OPERATIONS_TOKEN && new Set(config.OPERATIONS_TOKEN).size >= 8, "A random OPERATIONS_TOKEN is required.");
  requireValue(!config.monitoringEnabled || config.SENTRY_DSN && new URL(config.SENTRY_DSN).protocol === "https:" && !/REPLACE_/i.test(config.SENTRY_DSN), "SENTRY_DSN is required when error monitoring is enabled.");
  requireValue(process.env.DOCUMENT_STORAGE_PATH && path.isAbsolute(process.env.DOCUMENT_STORAGE_PATH) && process.env.EMBEDDING_CACHE_PATH && path.isAbsolute(process.env.EMBEDDING_CACHE_PATH), "Deployed document storage and embedding cache must use explicit persistent volumes.");
  requireValue(!documents.storage.startsWith(process.cwd() + path.sep) && !documents.modelCache.startsWith(process.cwd() + path.sep) && documents.storage !== documents.modelCache, "Runtime volumes must be separate from application assets.");
  requireValue(process.env.EMBEDDING_ALLOW_DOWNLOAD !== "true", "Download the pinned embedding model in the preparation step, not serving processes.");
  requireValue(RAG_EMBEDDING.dimensions === 384, "RAG embedding dimensions require a separate data migration.");
  requireValue(process.env.AI_ROUTING_EVALUATION_MODE !== "true" && !process.env.AI_ROUTING_OVERRIDE_JSON, "Evaluation routing overrides are forbidden in deployed runtimes.");
  requireValue(guard.disableAllAI || ai.apiKey && !/replace[_ -]|placeholder/i.test(ai.apiKey), "Configure the AI provider key or explicitly disable AI.");
  const approved = (process.env.APPROVED_AI_MODELS || DEFAULT_MODEL_CATALOG.map(m => m.model).join(",")).split(",").map(v => v.trim());
  requireValue(catalog.filter(m => m.enabled).every(m => m.provider === "openai" && approved.includes(m.model)), "Enabled models must belong to the reviewed deployment catalog.");
  requireValue(guard.disableAllAI || catalog.some(m => m.enabled && m.model === ai.chatModel), "Default chat model must be enabled.");
  const billing = billingConfig();
  requireValue(!billing.enabled || billing.environment === config.APP_ENV && billing.mode === (config.APP_ENV === "production" ? "live" : "test"), "Billing mode/environment must match this deployment.");
  requireValue(!config.SIGNUP_EMAIL_ALLOWLIST || config.SIGNUP_EMAIL_ALLOWLIST.split(",").every(v => z.string().email().safeParse(v.trim()).success), "Invalid beta email allowlist.");
  return config;
}
