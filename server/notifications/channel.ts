import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { NotificationChannelId } from "./types";

export interface NotificationChannel {
  readonly id: NotificationChannelId;
  readonly interruptive: boolean;
  readonly supportsQuietHours: boolean;
  readonly supportsRichActions: boolean;
  deliver(input: { userId: string; notification: { id: string }; now: Date }, transaction: Prisma.TransactionClient): Promise<void>;
}

/** In-app delivery is atomic persistence, independent of whether the user is online.
 * Quiet hours do not prevent silent in-app storage; the shared delivery timing
 * policy defers future interruptive adapters, including critical reminders. */
export class InAppNotificationChannel implements NotificationChannel {
  readonly id = "in-app";
  readonly interruptive = false;
  readonly supportsQuietHours = false;
  readonly supportsRichActions = true;
  async deliver({ userId, notification, now }: Parameters<NotificationChannel["deliver"]>[0], transaction: Prisma.TransactionClient) {
    const result = await transaction.notification.updateMany({
      where: { id: notification.id, userId, channel: "IN_APP", status: "PENDING" },
      data: { status: "DELIVERED", deliveredAt: now, readAt: null, dismissedAt: null,
        deliveryCount: { increment: 1 }, failedAttempts: 0, lastErrorCode: null },
    });
    if (result.count !== 1) throw new Error("In-app delivery was not persisted.");
  }
}
