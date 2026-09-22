import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/server/auth/config";
import { billingPrices, billingSummary } from "@/server/billing/service";
import { PlanPurchase } from "@/features/student/billing/billing";
import { basePlanCode } from "@/server/entitlements/config";
import { BillingAction } from "@/features/student/billing/billing";
import { publicPlanCatalog } from "@/server/entitlements/service";
export const dynamic = "force-dynamic";
const labels: Record<string, string> = { "documents.max": "Stored documents", "documents.monthlyProcessing": "Document processing / period", "courses.max": "Courses", "ai.monthlyRequests": "AI requests / period", "workflow.monthlyRuns": "Workflows / period", "integrations.maxAccounts": "Connected accounts", "memory.maxActive": "Active memories" };
export default async function PlansPage() {
  const plans = await publicPlanCatalog();
  const session = await auth().api.getSession({ headers: await headers() });
  const current = session ? await billingSummary(session.user.id) : null;
  const prices = await billingPrices().catch(() => []);
  return <main className="mx-auto max-w-6xl p-6 py-12"><Link href="/student/settings" className="text-sm text-primary underline">Back to settings</Link><h1 className="mt-6 text-3xl font-semibold">Plans for your learning</h1><p className="mt-3 max-w-2xl text-muted-foreground">Choose the access and allowances that fit your learning. Your saved academic work is preserved when your plan changes.</p>{!prices.length && <p role="status" className="mt-4 text-sm text-muted-foreground">Online subscriptions are currently unavailable. You can still compare plans and use your existing access.</p>}<Link href="/student/settings/billing" className="mt-4 inline-block text-primary underline">Billing settings</Link><div className="mt-8 grid gap-6 md:grid-cols-3">{plans.map(plan => <section key={plan.code} className="rounded-2xl border p-6"><h2 className="text-xl font-semibold">{plan.name}{current?.plan.code === plan.code ? " · Current Plan" : ""}</h2><p className="mt-2 text-sm text-muted-foreground">{plan.description}</p><ul className="mt-5 space-y-2 text-sm">{plan.features.map(feature => <li key={feature.name}>{feature.included ? "✓" : "—"} {feature.name}</li>)}</ul><dl className="mt-5 space-y-3 border-t pt-5 text-sm">{plan.limits.map(limit => <div key={limit.key} className="flex justify-between gap-3"><dt>{labels[limit.key] ?? limit.key}</dt><dd>{limit.value === null ? "Unlimited" : limit.value.toLocaleString("en-US")}</dd></div>)}</dl>{plan.code === basePlanCode() ? <div className="mt-4 border-t pt-4"><p className="text-lg font-semibold">Free · No payment required</p>{current?.enabled && current.canManage && current.price && !["expired", "cancelled"].includes(current.status) && <BillingAction kind="portal">Switch to Free at period end</BillingAction>}</div> : <PlanPurchase planCode={plan.code} prices={prices} current={current} />}<p className="mt-5 text-xs text-muted-foreground">Safety limits still apply. AI requests retain their required quality; exhausted allowances pause new work.</p></section>)}</div></main>;
}
