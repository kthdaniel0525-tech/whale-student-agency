import "server-only";
import type { Agent } from "./types";

/** Detach both writes and reads so caller-owned nested options never leak into storage. */
export function copyAgent<Extension extends string>(
  agent: Agent<Extension>,
): Agent<Extension> {
  const options = agent.contextRequirements;
  return Object.freeze({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    capabilities: Object.freeze([...agent.capabilities]),
    contextRequirements: Object.freeze({
      ...options,
      ...(options.memoryKeys ? { memoryKeys: [...options.memoryKeys] } : {}),
      ...(options.limits ? { limits: { ...options.limits } } : {}),
    }),
  });
}
