import "server-only";
import { AIError } from "../../ai/errors";
import type { UserContext } from "../../context/types";
import type { AgentSource } from "../types";

/** Provenance comes from retrieved metadata, never from generated text. */
export function collectExecutionSources(context: UserContext): AgentSource[] {
  const sources = new Map<string, AgentSource>();
  for (const document of context.documents ?? []) {
    const key = JSON.stringify([
      document.documentId,
      document.chunkIndex,
      document.pageNumber,
      document.pageEnd,
    ]);
    if (sources.has(key)) continue;
    sources.set(key, {
      documentId: document.documentId,
      documentTitle: document.documentTitle,
      pageNumber: document.pageNumber,
      pageEnd: document.pageEnd,
      courseId: document.courseId,
      courseCode: document.courseCode,
      chunkIndex: document.chunkIndex,
    });
  }
  return [...sources.values()];
}

/** Model citations may select retrieved entries, never manufacture provenance. */
export function validateSourceIndices(indices: readonly number[], sources: readonly AgentSource[]) {
  if (!indices.length || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= sources.length) || new Set(indices).size !== indices.length) throw new AIError("INVALID_RESPONSE");
}
