import "server-only";
import { z } from "zod";
import { AIError } from "../../ai/errors";
import type { AgentSource } from "../types";
import { AgentExecutionError } from "../executor";
import type { AgentExecutor, AgentExecutionRequest } from "../executor";
import { collectExecutionSources, validateSourceIndices } from "../executor/sources";
import { normalizeTopicName } from "../../learning/normalization";

/** Optional structured Notes output. Existing plain-text Notes execution is unchanged. */
export function structuredNotesSchema(maximumConcepts = 12) {
  return z.object({
    title: z.string().trim().min(1).max(160),
    focusCovered: z.boolean(),
    topics: z.array(z.string().trim().min(1).max(120)).min(1).max(maximumConcepts),
    concepts: z.array(z.object({
      topic: z.string().trim().min(1).max(120), complexity: z.enum(["basic", "intermediate", "advanced"]), keyIdea: z.string().trim().min(1).max(240),
      definitions: z.array(z.string().trim().min(1).max(400)).max(4),
      formulasOrProcedures: z.array(z.string().trim().min(1).max(600)).max(4),
      notes: z.string().trim().min(1).max(1600),
      sourceIndices: z.array(z.number().int().min(0)).min(1).max(5),
    }).strict()).min(1).max(maximumConcepts),
  }).strict().superRefine((data, ctx) => {
    const names = data.topics.map(normalizeTopicName), concepts = data.concepts.map((c) => normalizeTopicName(c.topic));
    if (new Set(names).size !== names.length || new Set(concepts).size !== concepts.length || names.length !== concepts.length || concepts.some((c) => !names.includes(c))) ctx.addIssue({ code: "custom", message: "Topics must match distinct note concepts." });
  });
}
export type StructuredNotes = z.infer<ReturnType<typeof structuredNotesSchema>>;
export async function executeStructuredNotes(executor: AgentExecutor, input: AgentExecutionRequest, headers: Headers,
  options: { detail: "concise" | "structured" | "detailed"; maximumConcepts: number; reviewMinutes: number; focus?: string }) {
  const execution = await executor.executeStructured({ ...input, agentId: "notes" }, headers, {
    schemaName: "study_notes", schema: structuredNotesSchema(options.maximumConcepts), maxOutputTokens: options.detail === "detailed" ? 7000 : options.detail === "concise" ? 2000 : 4500,
    requireDocumentSources: true,
    contextOverrides: { selectedDocumentCoverage: true, limits: { documents: 10, maxCharacters: 40000 } },
    buildDirective: (context) => {
      const sourceCatalog = collectExecutionSources(context);
      if (input.documentIds?.some((id) => !sourceCatalog.some((source) => source.documentId === id))) throw new AgentExecutionError("SOURCE_CONTEXT_UNAVAILABLE");
      return JSON.stringify({ ...options,
      guidance: "Extract topics and key ideas in this same Notes generation. Include definitions and formulas/procedures only when relevant. Keep notes readable in reviewMinutes. Base content on retrieved passages; do not claim complete lecture coverage. If the requested focus is absent, set focusCovered=false. Do not write citations in prose; cite zero-based sourceIndices only.",
      sourceCatalog,
      });
    },
  });
  const data = execution.structuredData;
  if (!data) throw new AIError("INVALID_RESPONSE");
  const sources: readonly AgentSource[] = execution.sources ?? [];
  for (const concept of data.concepts) validateSourceIndices(concept.sourceIndices, sources);
  if (input.documentIds?.some((id) => !sources.some((source) => source.documentId === id))) throw new AIError("INVALID_RESPONSE");
  return { data, sources, metadata: execution.metadata };
}
