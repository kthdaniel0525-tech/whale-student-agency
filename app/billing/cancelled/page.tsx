import Link from "next/link";
export default function BillingCancelled() {
  return <main className="mx-auto max-w-2xl p-6 py-12"><h1 className="text-3xl font-semibold">Checkout closed</h1><p className="mt-4">Returning here does not change your subscription. You can review your current billing status or continue checkout from plans.</p><div className="mt-6 flex gap-5"><Link className="text-primary underline" href="/plans">View plans</Link><Link className="text-primary underline" href="/student/settings/billing">Billing settings</Link></div></main>;
}
