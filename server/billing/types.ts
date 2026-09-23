import type { BillingInterval, BillingStatus } from "@/lib/billing/types";
export type ProviderPrice = { id: string; productId: string; active: boolean; amount: number; currency: string; interval: BillingInterval; live: boolean };
export type ProviderSubscription = {
  id: string; customerId: string; priceId: string; itemId: string; createdAt: Date;
  status: BillingStatus; periodStart: Date; periodEnd: Date; cancelAtPeriodEnd: boolean;
  trialEnd: Date | null; delinquentSince: Date | null; live: boolean;
  pending: { priceId: string; effectiveAt: Date } | null;
};
export type BillingEvent = { id: string; type: string; live: boolean; subscriptionId: string | null; customerId: string | null; checkoutId: string | null; supported: boolean };
export interface BillingProvider {
  createCustomer(userId: string, key: string): Promise<string>;
  price(id: string): Promise<ProviderPrice>;
  subscription(id: string): Promise<ProviderSubscription>;
  subscriptionIds(customerId: string): Promise<string[]>;
  checkout(input: { customerId: string; priceId: string; key: string; expiresAt: Date }): Promise<{ id: string; url: string }>;
  checkoutState(id: string): Promise<{ status: "open" | "complete" | "expired"; url: string | null }>;
  portal(customerId: string, change?: { subscriptionId: string; itemId: string; priceId: string }): Promise<string>;
  expireCheckout(id: string): Promise<void>;
  cancelSubscription(id: string): Promise<void>;
  verify(body: string, signature: string): BillingEvent;
}
