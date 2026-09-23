import "server-only";
import { copyAgent } from "./metadata";
import type { Agent, AgentCapability, AgentId } from "./types";

export type AgentRegistryErrorCode = "DUPLICATE_AGENT" | "AGENT_NOT_FOUND";

export class AgentRegistryError extends Error {
  constructor(
    readonly code: AgentRegistryErrorCode,
    readonly agentId: string,
  ) {
    super(
      code === "DUPLICATE_AGENT"
        ? `Agent "${agentId}" is already registered.`
        : `Agent "${agentId}" is not registered.`,
    );
    this.name = "AgentRegistryError";
  }
}

/** An explicit, in-memory catalog of metadata. No routing or execution. */
export class AgentRegistry<Extension extends string = never> {
  readonly #agents = new Map<AgentId<Extension>, Agent<Extension>>();

  register(agent: Agent<Extension>): void {
    if (this.#agents.has(agent.id)) {
      throw new AgentRegistryError("DUPLICATE_AGENT", agent.id);
    }
    this.#agents.set(agent.id, copyAgent(agent));
  }

  get(agentId: AgentId<Extension>): Agent<Extension> {
    const agent = this.#agents.get(agentId);
    if (!agent) throw new AgentRegistryError("AGENT_NOT_FOUND", agentId);
    return copyAgent(agent);
  }

  has(agentId: AgentId<Extension>): boolean {
    return this.#agents.has(agentId);
  }

  list(): readonly Agent<Extension>[] {
    return Object.freeze([...this.#agents.values()].map(copyAgent));
  }

  getByCapability(capability: AgentCapability): readonly Agent<Extension>[] {
    return Object.freeze(
      [...this.#agents.values()]
        .filter((agent) => agent.capabilities.includes(capability))
        .map(copyAgent),
    );
  }
}
