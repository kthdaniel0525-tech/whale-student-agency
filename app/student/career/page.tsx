import { CareerWorkspace } from "@/features/student/career/workspace";
import { headers } from "next/headers";
import { requirePageUser } from "@/server/auth/session";
import { getCareerWorkspace } from "@/server/career-workspace";

export default async function CareerPage() {
  const { user } = await requirePageUser();
  return <CareerWorkspace initial={await getCareerWorkspace(user.id, await headers())} />;
}
