import { BetaSignOut } from "@/features/student/analytics/beta-actions";
import { BillingAction } from "@/features/student/billing/billing";
import { db } from "@/server/db/client";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth/config";
import { betaAccess, BetaAccessError } from "@/server/beta/access";
export const dynamic = "force-dynamic";
export default async function BetaPage() {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  try { await betaAccess(session.user.id); redirect("/student"); }
  catch (error) { if (!(error instanceof BetaAccessError)) throw error; }
  const billing = await db().billingCustomer.findUnique({ where: { userId: session.user.id }, select: { providerCustomerId: true } });
  return <main className="mx-auto max-w-xl p-10"><p className="eyebrow">STUDENT AGENCY BETA</p><h1 className="my-4">Access is by invitation</h1><p>Your account is signed in. The full workspace will be available when your beta access is approved. Contact the person who invited you if you expected access.</p><div className="mt-6"><BetaSignOut /></div>{billing?.providerCustomerId && <BillingAction kind="portal">Manage or cancel your subscription</BillingAction>}</main>;
}
