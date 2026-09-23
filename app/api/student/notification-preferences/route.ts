import { revalidatePath } from "next/cache";
import { api, readJson } from "@/server/api";
import { notificationPreferenceSchema } from "@/lib/student/notification-preferences";
import { getNotificationPreferences, updateNotificationPreferences } from "@/server/preferences/notifications";
export function GET(request: Request) {
  return api(request, (userId) => getNotificationPreferences(userId));
}
export function PATCH(request: Request) {
  return api(request, async (userId) => {
    const result = await updateNotificationPreferences(userId, await readJson(request, notificationPreferenceSchema));
    revalidatePath("/student", "layout");
    return result;
  });
}
