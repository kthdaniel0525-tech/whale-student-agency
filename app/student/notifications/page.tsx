import { requirePageUser } from "@/server/auth/session";
import { getNotifications } from "@/server/notifications";
import { NotificationCenter } from "@/features/student/notifications/center";
export default async function NotificationsPage() {
  const { user } = await requirePageUser();
  return <NotificationCenter initial={await getNotifications({ userId: user.id })} />;
}
