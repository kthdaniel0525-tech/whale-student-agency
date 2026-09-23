import "server-only";
import { z } from "zod";
import { EVENTS, DEFAULT_MEANINGFUL_EVENTS } from "@/lib/product-analytics/events";
export function analyticsConfig() {
  const env = z.object({
    PRODUCT_ANALYTICS_ENABLED: z.enum(["true", "false"]).default("false"),
    PRODUCT_ANALYTICS_PROVIDER: z.enum(["database", "console"]).default("database"),
    PRODUCT_ANALYTICS_RETENTION_DAYS: z.coerce.number().int().min(30).max(730).default(180),
    PRODUCT_ACTIVATION_EVENTS_JSON: z.string().optional(),
    PRODUCT_MEANINGFUL_EVENTS_JSON: z.string().optional(),
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default(process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development"),
  }).parse(process.env);
  const list = z.array(z.enum(EVENTS)).min(1).max(20);
  if (env.PRODUCT_ANALYTICS_PROVIDER === "console" && ["staging", "production"].includes(env.APP_ENV)) throw new Error("Console analytics is for development only.");
  return { enabled: env.PRODUCT_ANALYTICS_ENABLED === "true", provider: env.PRODUCT_ANALYTICS_PROVIDER, environment: env.APP_ENV, retentionDays: env.PRODUCT_ANALYTICS_RETENTION_DAYS,
    activation: env.PRODUCT_ACTIVATION_EVENTS_JSON ? list.parse(JSON.parse(env.PRODUCT_ACTIVATION_EVENTS_JSON)) : ["onboarding_completed", "course_created", "ai_request_completed"] as const,
    meaningful: env.PRODUCT_MEANINGFUL_EVENTS_JSON ? list.parse(JSON.parse(env.PRODUCT_MEANINGFUL_EVENTS_JSON)) : DEFAULT_MEANINGFUL_EVENTS };
}
