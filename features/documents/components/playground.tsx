"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { request } from "@/lib/student/client";
import { EmptyState } from "@/features/student/components/empty-state";
import type { CourseOption, DocumentItem, SearchResult } from "../types";
export function RagPlayground({
  courses,
  documents,
  documentId,
}: {
  courses: CourseOption[];
  documents: DocumentItem[];
  documentId?: string;
}) {
  const selected = documents.find((d) => d.id === documentId);
  const [course, setCourse] = useState(selected?.courseId || "");
  const [document, setDocument] = useState(selected?.id || "");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState("");
  async function search(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    setResults(null);
    try {
      const data = await request<{ results: SearchResult[] }>(
        "/api/student/rag/search",
        "POST",
        {
          query,
          maxResults: 5,
          ...(course ? { courseId: course } : {}),
          ...(document ? { documentIds: [document] } : {}),
        },
      );
      setResults(data.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search is unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link href="/student/documents" className="text-primary text-sm">
        ← Document library
      </Link>
      <div className="page-heading mt-5">
        <div>
          <p className="eyebrow">KNOWLEDGE SEARCH</p>
          <h1 className="mt-2">Retrieval playground</h1>
          <p>
            Inspect the passages a future academic assistant could use. No AI
            answer is generated.
          </p>
        </div>
      </div>
      <section className="panel">
        <form onSubmit={search}>
          <fieldset disabled={busy}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="search-course">Course</label>
                <NativeSelect
                  id="search-course"
                  value={course}
                  onChange={(e) => {
                    setCourse(e.target.value);
                    setDocument("");
                    setResults(null);
                  }}
                >
                  <option value="">All my courses</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.courseCode} · {c.courseName}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="field">
                <label htmlFor="search-document">Document</label>
                <NativeSelect
                  id="search-document"
                  value={document}
                  onChange={(e) => {
                    setDocument(e.target.value);
                    setResults(null);
                  }}
                >
                  <option value="">All ready documents</option>
                  {documents
                    .filter(
                      (d) =>
                        d.processingStatus === "READY" &&
                        (!course || d.courseId === course),
                    )
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                </NativeSelect>
              </div>
              <div className="field form-wide">
                <label htmlFor="search-query">Search question</label>
                <Textarea
                  id="search-query"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  required
                  minLength={3}
                  maxLength={1000}
                  placeholder="What is the inductive hypothesis?"
                  rows={3}
                />
              </div>
            </div>
            <div className="form-actions">
              <Button type="submit">
                {busy ? "Searching passages…" : "Search passages"}
              </Button>
            </div>
          </fieldset>
        </form>
        {error && (
          <p role="alert" className="field-error mt-4">
            {error}
          </p>
        )}
      </section>
      <section className="mt-7" aria-live="polite">
        {results === null ? (
          <p className="muted text-sm">
            Search uses only your ready documents. Similarity is a matching
            score, not a guarantee that a passage answers the question.
          </p>
        ) : !results.length ? (
          <div className="panel">
            <EmptyState
              title="No relevant passages found"
              description="Try rephrasing your question, choosing another course, or checking that your documents are ready."
            />
          </div>
        ) : (
          <>
            <h2 className="text-xl font-semibold mb-4">Retrieved passages</h2>
            {results.map((result) => (
              <article key={result.id} className="panel mb-4">
                <div className="flex justify-between flex-wrap gap-2">
                  <Link
                    className="font-semibold text-primary"
                    href={`/student/documents/${result.documentId}`}
                  >
                    {result.documentTitle} · Page {result.pageNumber}
                    {result.pageEnd && result.pageEnd !== result.pageNumber
                      ? `–${result.pageEnd}`
                      : ""}
                  </Link>
                  <span className="text-sm muted">
                    Similarity: {result.similarityScore.toFixed(3)}
                  </span>
                </div>
                <p className="text-sm muted mt-1">
                  {result.courseCode || "General material"} · Passage{" "}
                  {result.chunkIndex + 1}
                </p>
                <p className="whitespace-pre-wrap break-words mt-4">
                  {result.content}
                </p>
              </article>
            ))}
          </>
        )}
      </section>
    </>
  );
}
