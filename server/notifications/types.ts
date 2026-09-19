export type NotificationChannelId = "in-app" | "email" | "push" | "sms";
export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  priority: "low" | "medium" | "high" | "critical";
  status: "delivered" | "read" | "dismissed";
  deliveredAt: string;
  readAt: string | null;
  actionLabel: string | null;
  canSnooze: boolean;
}
export interface NotificationPage {
  notifications: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
}
