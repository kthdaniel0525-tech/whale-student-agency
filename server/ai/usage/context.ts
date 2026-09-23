import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AIUsageContext } from "./types";

const storage = new AsyncLocalStorage<AIUsageContext>();
const owners = new WeakMap<object, string>();
/** Ownership stays outside serialized Context Builder data and model prompts. */
export function bindUsageOwner<T extends object>(context: T, userId: string): T {
  owners.set(context, userId);
  return context;
}
export function usageOwner(context: object) { return owners.get(context); }
export function captureUsageContext(context: AIUsageContext = {}): AIUsageContext {
  const current = storage.getStore();
  // A different authenticated owner must never inherit another user's attribution.
  const differentOwner = current?.userId && context.userId && current.userId !== context.userId;
  const differentRequest = current?.requestId && context.requestId && current.requestId !== context.requestId;
  const parent = differentOwner || differentRequest ? undefined : current;
  return { ...parent, ...context, requestId: context.requestId ?? parent?.requestId ?? randomUUID() };
}
export function withAIUsageContext<T>(context: AIUsageContext, run: () => T): T {
  return storage.run(captureUsageContext(context), run);
}
/** Each next/return runs within the captured scope, including consumer cancellation. */
export function withAIUsageStream<T, R>(context: AIUsageContext, create: () => AsyncGenerator<T, R>): AsyncGenerator<T, R> {
  const captured = captureUsageContext(context);
  return (async function* () {
  const iterator = withAIUsageContext(captured, create);
  try {
    while (true) {
      const next = await withAIUsageContext(captured, () => iterator.next());
      if (next.done) return next.value;
      yield next.value;
    }
  } finally {
    await withAIUsageContext(captured, () => iterator.return(undefined as R));
  }
  })();
}
