import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./config";
import { db } from "@/server/db/client";
import { assertActiveUser, AccountUnavailableError } from "@/server/privacy/account-state";
export async function requirePageUser(onboarded = true) {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  try { await assertActiveUser(session.user.id); }
  catch (error) { if (error instanceof AccountUnavailableError) redirect("/sign-in"); throw error; }
  const profile = await db().profile.findUnique({
    where: { userId: session.user.id },
  });
  if (onboarded && !profile) redirect("/onboarding");
  return { user: session.user, profile };
}
