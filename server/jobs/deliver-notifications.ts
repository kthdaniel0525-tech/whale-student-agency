import "server-only";
import { z } from "zod";
import { db } from "../db/client";
import { deliverUserNotifications, dueRemindersWhere } from "../notifications/delivery";
import { BackgroundJobError } from "./errors";
import type { BackgroundJob } from "./types";

export const deliveryUserPayload = z.object({ version: z.literal(1), trackingId: z.string().min(1).max(100), userId: z.string().min(1).max(100) });
export function createDeliverUserNotificationsJob(deliver = deliverUserNotifications): BackgroundJob<z.infer<typeof deliveryUserPayload>> {
  return { name: "deliver-user-notifications", version: 1, payloadSchema: deliveryUserPayload,
    retryPolicy: { limit: 2, delaySeconds: 10, maximumDelaySeconds: 60, exponentialBackoff: true },
    timeoutSeconds: 60, priority: "high", executionScope: "user", concurrency: { scope: "user", limit: 1 }, debounceSeconds: 5,
    async handler({ payload, signal }) {
      if (signal.aborted) throw new BackgroundJobError("TIMEOUT");
      const result = await deliver(payload.userId);
      if (result.failed) throw new BackgroundJobError("DATABASE_ERROR");
      return result;
    },
  };
}
export const deliverUserNotificationsJob = createDeliverUserNotificationsJob();

const sweepPayload = z.object({ version: z.literal(1), trackingId: z.string().min(1).max(100).optional() });
export async function selectDeliveryUsers(now: Date, cursor?: string, limit = 100) {
  const rows = await db().reminder.groupBy({ by: ["userId"], where: { ...dueRemindersWhere(now),
    ...(cursor ? { userId: { gt: cursor } } : {}),
    user: { OR: [{ reminderPreference: null }, { reminderPreference: { remindersEnabled: true, inAppEnabled: true } }] },
  }, orderBy: { userId: "asc" }, take: limit });
  return rows.map((row) => row.userId);
}
export function createDeliverReadyNotificationsJob(dependencies: {
  now?: () => Date; selectPage?: typeof selectDeliveryUsers;
  enqueue?: (userId: string) => Promise<unknown>;
} = {}): BackgroundJob<z.infer<typeof sweepPayload>> {
  return { name: "deliver-ready-notifications", version: 1, payloadSchema: sweepPayload,
    retryPolicy: { limit: 2, delaySeconds: 15, maximumDelaySeconds: 60, exponentialBackoff: true },
    timeoutSeconds: 300, priority: "normal", executionScope: "system", concurrency: { scope: "global", limit: 1 }, debounceSeconds: 60,
    async handler({ signal }) {
      const now = dependencies.now?.() ?? new Date();
      const select = dependencies.selectPage ?? selectDeliveryUsers;
      const enqueue = dependencies.enqueue ?? (await import("./enqueue")).enqueueNotificationDelivery;
      let cursor: string | undefined, pages = 0, enqueued = 0, failed = 0;
      do {
        if (signal.aborted) throw new BackgroundJobError("TIMEOUT");
        const users = await select(now, cursor, 100);
        if (!users.length) break;
        pages++;
        for (let offset = 0; offset < users.length; offset += 5) {
          const results = await Promise.allSettled(users.slice(offset, offset + 5).map((userId) => enqueue(userId)));
          for (const result of results) {
            if (result.status === "fulfilled") enqueued++;
            else failed++;
          }
        }
        cursor = users.at(-1);
      } while (cursor);
      return { pages, enqueued, failed };
    },
  };
}
export const deliverReadyNotificationsJob = createDeliverReadyNotificationsJob();
