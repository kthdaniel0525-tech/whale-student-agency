import Link from "next/link";
import { BookOpen, ExternalLink } from "lucide-react";
import type { AssistantSource } from "./types";

export function SourceList({ sources }: { sources: readonly AssistantSource[] }) {
  const unique = [...new Map(sources.map((source) => [
    `${source.documentId}:${source.pageNumber ?? ""}:${source.pageEnd ?? ""}`,
    source,
  ])).values()];
  if (!unique.length) return null;
  return (
    <section className="assistant-sources" aria-label="Sources">
      <h4 className="flex items-center gap-2 text-sm font-medium"><BookOpen size={16} /> Sources</h4>
      <div className="mt-2 flex flex-wrap gap-2">
        {unique.map((source) => (
          <Link
            className="assistant-source-link"
            href={`/student/documents/${source.documentId}${source.pageNumber ? `?page=${source.pageNumber}` : ""}`}
            key={`${source.documentId}-${source.chunkIndex}-${source.pageNumber ?? ""}`}
          >
            {source.documentTitle}
            {source.pageNumber ? ` · p. ${source.pageNumber}${source.pageEnd && source.pageEnd !== source.pageNumber ? `–${source.pageEnd}` : ""}` : ""}
            <ExternalLink size={12} />
          </Link>
        ))}
      </div>
    </section>
  );
}
