import { requirePageUser } from "@/server/auth/session";
import { Shell } from "@/features/student/components/shell";
export const dynamic = "force-dynamic";
export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await requirePageUser();
  return (
    <Shell name={user.name} semester={profile!.semester}>
      {children}
    </Shell>
  );
}
