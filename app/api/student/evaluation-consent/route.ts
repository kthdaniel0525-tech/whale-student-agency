import { z } from "zod";
import { api, readJson } from "@/server/api";
import { hasEvaluationConsent, samplingConfig, setEvaluationConsent } from "@/server/ai/evaluation/sampling";
export function GET(request: Request) { return api(request, async userId => { const config = samplingConfig(); return { available: config.enabled, policyVersion: config.policyVersion, policyUrl: config.policyUrl, enabled: await hasEvaluationConsent(userId, config.policyVersion) }; }); }
export function PUT(request: Request) { return api(request, async userId => setEvaluationConsent(userId, await readJson(request, z.object({ enabled: z.boolean(), policyVersion: z.string().max(100).optional() }).strict()))); }
