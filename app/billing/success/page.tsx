import { requirePageUser } from "@/server/auth/session";
import { billingSummary } from "@/server/billing/service";
import { BillingDetails } from "@/features/student/billing/billing";
export const dynamic = "force-dynamic";
export default async function BillingSuccess() {
  const { user } = await requirePageUser(false);
  // Read-only local status. No URL/session parameter can grant a plan.
  return <main className="mx-auto max-w-3xl p-6 py-12"><h1 className="mb-6 text-3xl font-semibold">Confirming your subscription</h1><BillingDetails initial={await billingSummary(user.id)} confirming /></main>;
}
