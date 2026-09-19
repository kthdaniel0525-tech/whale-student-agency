import "server-only";
import { z } from "zod";
import { enqueueRecommendationRefresh, enqueueReminderRefresh } from "./enqueue";
import { DOMAIN_BACKGROUND_EVENTS } from "./types";

export const domainBackgroundEventSchema = z.object({
  eventId: z.string().min(1).max(120),
  name: z.enum(DOMAIN_BACKGROUND_EVENTS),
  userId: z.string().min(1).max(100),
  resourceId: z.string().min(1).max(100).optional(),
  occurredAt: z.date().optional(),
});

export type DomainBackgroundEvent = z.infer<typeof domainBackgroundEventSchema>;

export async function enqueueDomainBackgroundEvent(
  rawEvent: DomainBackgroundEvent,
  dependencies: Parameters<typeof enqueueRecommendationRefresh>[2] = {},
) {
  const event = domainBackgroundEventSchema.parse(rawEvent);
  const [recommendation, reminder] = await Promise.all([
    enqueueRecommendationRefresh(event.userId, {
      idempotencyKey: `event:${event.name}:${event.eventId}`,
      debounceKey: `event-recommendation:${event.userId}`,
      resourceId: event.resourceId,
      sourceEvent: event.name,
      now: event.occurredAt,
    }, dependencies),
    enqueueReminderRefresh(event.userId, {
      idempotencyKey: `reminder-event:${event.name}:${event.eventId}`,
      debounceKey: `event-reminder:${event.userId}`,
      resourceId: event.resourceId,
      sourceEvent: event.name,
      now: event.occurredAt,
    }, dependencies),
  ]);
  return Object.assign(recommendation, { reminder });
}
