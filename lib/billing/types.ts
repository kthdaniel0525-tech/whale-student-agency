import { z } from "zod";
export const billingSelection = z.object({ planCode: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), billingInterval: z.enum(["monthly", "yearly"]) }).strict();
export type BillingSelection = z.infer<typeof billingSelection>;
export type BillingInterval = BillingSelection["billingInterval"];
export type BillingStatus = "active" | "trialing" | "past-due" | "cancelled" | "expired";
export type PublicPrice = { planCode: string; interval: BillingInterval; amount: number; currency: string };
export type BillingSummary = {
  enabled: boolean; plan: { code: string; name: string }; status: BillingStatus;
  renewsAt: string | null; cancelAtPeriodEnd: boolean; trialEndsAt: string | null;
  graceUntil: string | null; price: PublicPrice | null; canManage: boolean;
  pendingChange: { planCode: string; interval: BillingInterval; effectiveAt: string } | null;
  confirmed: boolean;
};
