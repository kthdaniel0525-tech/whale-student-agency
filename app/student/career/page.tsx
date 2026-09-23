import { hasEntitlement } from "@/server/entitlements/service";
import { CareerWorkspace } from "@/features/student/career/workspace";
import { headers } from "next/headers";
import { requirePageUser } from "@/server/auth/session";
import { getCareerWorkspace } from "@/server/career-workspace";

export default async function CareerPage() {
  const { user } = await requirePageUser();
  if (!await hasEntitlement(user.id, "ai.career")) return <section className="panel"><h1>Career workspace</h1><p className="mt-3">Career tools are not available with your current access. Your saved work is preserved.</p></section>;
  return <CareerWorkspace initial={await getCareerWorkspace(user.id, await headers())} />;
}
