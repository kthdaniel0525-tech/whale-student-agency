import "server-only";
import { AIError } from "../ai/errors";
import type { ENTITLEMENT_CODES, EntitlementKey } from "@/lib/entitlements/types";
export class EntitlementError extends AIError {
  readonly plansUrl = "/plans";
  readonly status: number;
  constructor(code: typeof ENTITLEMENT_CODES[number], public readonly entitlement?: EntitlementKey) {
    super(code);
    this.name = "EntitlementError";
    this.status = code === "PLAN_USAGE_EXHAUSTED" ? 429 : 403;
  }
}
