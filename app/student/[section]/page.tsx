import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/session";
export default async function UnknownStudentPage() {
  await requirePageUser();
  notFound();
}
