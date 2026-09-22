import Link from "next/link";
import { requirePageUser } from "@/server/auth/session";
import { billingSummary } from "@/server/billing/service";
import { BillingDetails } from "@/features/student/billing/billing";
export default async function BillingSettings() {
  const { user } = await requirePageUser(false);
  return <main className="max-w-3xl"><Link className="text-primary underline" href="/student/settings">Back to settings</Link><h1 className="my-6 text-3xl font-semibold">Billing</h1><BillingDetails initial={await billingSummary(user.id)} /></main>;
}
