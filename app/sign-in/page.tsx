import { AuthForm } from "@/features/student/components/auth-form";
import { auth } from "@/server/auth/config";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function Page() {
  if (await auth().api.getSession({ headers: await headers() }))
    redirect("/student");
  return <AuthForm signup={false} />;
}
