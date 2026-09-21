import type { AIAllowanceService } from "@/server/entitlements/usage";
import { DEVELOPMENT_PLANS } from "@/server/entitlements/config";
// Only transport/routing unit tests without database identities use this fixture.
// Production enforcement and locking are covered by entitlements integration tests.
export const testAllowances: AIAllowanceService = { reserve: async () => ({ release: async () => {} }) };
export const testEntitlements = async () => structuredClone(DEVELOPMENT_PLANS.find(p => p.code === "internal-unlimited")!.entitlements);
