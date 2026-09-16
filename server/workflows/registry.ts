import "server-only";
import { z } from "zod";
import type { AgentRegistry } from "../agents/registry";
import { WORKFLOW_IDS, type WorkflowDefinition, type WorkflowId } from "./types";
import { WorkflowError } from "./errors";

const policy = z.enum(["fail-workflow", "skip-step", "continue-with-warning"]);
const schema = z.object({
  id: z.enum(WORKFLOW_IDS), name: z.string().min(1).max(100), description: z.string().min(1).max(400),
  intents: z.array(z.string().min(1).max(100)).max(10),
  maxSteps: z.number().int().min(1).max(8), maxAgentCalls: z.number().int().min(1).max(3),
  agentCallLimits: z.record(z.number().int().min(1).max(3)).optional(),
  maxOutputCharacters: z.number().int().min(14000).max(48000).optional(),
  maxDurationMs: z.number().int().min(1000).max(300000), maxRetries: z.number().int().min(0).max(1), failurePolicy: policy,
  steps: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/), agentId: z.string(), purpose: z.string().min(1).max(300), outputKey: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/), input: z.function(), condition: z.function().optional(), failurePolicy: policy.optional(), invalidates: z.array(z.enum(["profile", "course", "assignments", "exams", "documents", "memories", "learning", "academicOverview", "career"])).optional() }).strict()).min(1).max(8),
}).strict();

export class WorkflowRegistry {
  private readonly definitions = new Map<WorkflowId, WorkflowDefinition>();
  constructor(private readonly agents: AgentRegistry) {}
  register(definition: WorkflowDefinition) {
    if (!schema.safeParse(definition).success || this.definitions.has(definition.id) || definition.steps.length > definition.maxSteps) throw new WorkflowError("INVALID_DEFINITION");
    const ids = new Set<string>(), outputs = new Set<string>(), calls = new Map<string, number>();
    for (const step of definition.steps) {
      const count = (calls.get(step.agentId) ?? 0) + 1;
      if ((step.agentId !== "deterministic" && (!this.agents.has(step.agentId) || count > (definition.agentCallLimits?.[step.agentId] ?? definition.maxAgentCalls))) || ids.has(step.id) || outputs.has(step.outputKey)) throw new WorkflowError("INVALID_DEFINITION");
      ids.add(step.id); outputs.add(step.outputKey); calls.set(step.agentId, count);
    }
    this.definitions.set(definition.id, Object.freeze({ ...definition, ...(definition.agentCallLimits ? { agentCallLimits: Object.freeze({ ...definition.agentCallLimits }) } : {}), intents: Object.freeze([...definition.intents]), steps: Object.freeze(definition.steps.map((step) => Object.freeze({ ...step, ...(step.invalidates ? { invalidates: Object.freeze([...step.invalidates]) } : {}) }))) }));
  }
  get(id: WorkflowId) {
    const definition = this.definitions.get(id);
    if (!definition) throw new WorkflowError("INVALID_DEFINITION");
    return definition;
  }
  has(id: string): id is WorkflowId { return this.definitions.has(id as WorkflowId); }
  list(): readonly WorkflowDefinition[] { return Object.freeze([...this.definitions.values()]); }
}
