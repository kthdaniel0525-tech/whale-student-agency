"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/student/client";
import { DriveSource } from "@/features/student/drive/source";
import { DocumentActions } from "./actions";
import { ProcessingStatus } from "./library";
import type { DocumentItem } from "../types";
function assistantUrl(
  prompt: string,
  target: { type: "agent" | "workflow"; id: string } | null,
  item: DocumentItem,
) {
  const params = new URLSearchParams({ prompt, documentId: item.id });
  if (item.courseId) params.set("courseId", item.courseId);
  if (target) params.set(target.type, target.id);
  return `/student/assistant?${params.toString()}`;
}

export function DocumentDetail({ initial, initialPage = 1 }: { initial: DocumentItem; initialPage?: number }) {
  const [item, setItem] = useState(initial);
  const [pages, setPages] = useState<{ pageNumber: number; content: string }[]>(
    [],
  );
  const [error, setError] = useState("");
  const [from, setFrom] = useState(1);
  const [busy, setBusy] = useState(false);
  const openedCitation = useRef<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setItem(
        await request<DocumentItem>(
          `/api/student/documents/${initial.id}`,
          "GET",
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to refresh.");
    }
  }, [initial.id]);
  const showPages = useCallback(async (start: number) => {
    setBusy(true);
    setError("");
    try {
      const data = await request<{ pages: typeof pages }>(
        `/api/student/documents/${item.id}/sections?fromPage=${start}&toPage=${Math.min(start + 4, item.pageCount || start)}`,
        "GET",
      );
      setPages(data.pages);
      setFrom(start);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to read pages.");
    } finally {
      setBusy(false);
    }
  }, [item.id, item.pageCount]);
  useEffect(() => {
    if (!["UPLOADED", "PROCESSING"].includes(item.processingStatus)) return;
    const timer = setInterval(() => void reload(), 2500);
    return () => clearInterval(timer);
  }, [item.processingStatus, reload]);
  useEffect(() => {
    if (openedCitation.current === item.updatedAt || item.processingStatus !== "READY") return;
    const page = openedCitation.current ? from : initialPage;
    openedCitation.current = item.updatedAt;
    void showPages(Math.min(page, item.pageCount || page));
  }, [from, initialPage, item.updatedAt, item.pageCount, item.processingStatus, showPages]);
  return (
    <>
      <Link href={item.courseId ? `/student/courses/${item.courseId}` : "/student/documents"} className="text-primary text-sm">
        ← {item.courseId ? `${item.course?.courseCode || "Course"} workspace` : "Document library"}
      </Link>
      {item.externalFileLink && item.externalFileLink.provider !== "google" && <p className="text-sm text-muted-foreground">Imported course material · {item.externalFileLink.syncStatus === "UNAVAILABLE" ? "Source unavailable; your imported copy is preserved." : item.externalFileLink.syncStatus === "FAILED" ? "Source sync needs attention. Manage it from the course workspace." : "Managed through course sync."}</p>}
      {item.externalFileLink?.provider === "google" && <DriveSource documentId={item.id} source={item.externalFileLink} onChange={() => void reload()} />}
      <div className="page-heading mt-5">
        <div>
          <p className="eyebrow">
            {item.course?.courseCode || "GENERAL MATERIAL"}
          </p>
          <h1 className="mt-2 break-words">{item.title}</h1>
          <p>
            {item.originalFileName} · {item.fileType} · {item.pageCount ?? "—"}{" "}
            pages
          </p>
          <p className="muted text-sm mt-2">
            Uploaded {new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(item.createdAt))}
          </p>
        </div>
        <ProcessingStatus status={item.processingStatus} />
      </div>
      <section className="panel">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <a
            className="text-primary text-sm underline"
            href={`/api/student/documents/${item.id}/download`}
          >
            Download original file
          </a>
          <DocumentActions
            id={item.id}
            failed={item.processingStatus === "FAILED"}
            onChange={() => void reload()}
            back
          />
        </div>
        {item.processingError && (
          <p role="alert" className="field-error mt-5">
            {item.processingError}
          </p>
        )}
        {item.processingStatus === "READY" ? (
          <div className="mt-7">
            <p className="muted">
              {item._count.chunks} indexed passages, with document and page
              citations.
            </p>
            <div className="flex flex-wrap gap-3 mt-4">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => showPages(1)}
              >
                {busy ? "Loading…" : "Read extracted pages"}
              </Button>
              <Button asChild>
                <Link
                  href={`/student/documents/playground?documentId=${item.id}`}
                >
                  Search this document
                </Link>
              </Button>
            </div>
            <div className="document-detail-ai-actions" aria-label="Document AI actions">
              <Button asChild size="sm">
                <Link href={assistantUrl(`Study ${item.title} as a lecture.`, { type: "workflow", id: "lecture-study" }, item)}>Study this lecture</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={assistantUrl(`Summarize ${item.title}.`, { type: "agent", id: "notes" }, item)}>Summarize</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={assistantUrl(`Make structured notes from ${item.title}.`, { type: "agent", id: "notes" }, item)}>Make notes</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={assistantUrl(`Quiz me on ${item.title}.`, { type: "agent", id: "quiz" }, item)}>Quiz me</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={assistantUrl(`Help me with ${item.title}.`, null, item)}>Ask AI</Link>
              </Button>
            </div>
          </div>
        ) : (
          <p className="muted mt-7">
            {item.processingStatus === "FAILED"
              ? "You can retry processing or delete and upload a corrected file."
              : "Your file is queued or processing. This page updates automatically."}
          </p>
        )}
        {error && (
          <p className="field-error mt-4" role="alert">
            {error}
          </p>
        )}
        {pages.map((page) => (
          <article key={page.pageNumber} className="mt-7 border-t pt-5">
            <h2>Page {page.pageNumber}</h2>
            <p className="whitespace-pre-wrap break-words mt-4">
              {page.content || "No readable text on this page."}
            </p>
          </article>
        ))}
        {!!pages.length && (
          <div className="flex gap-3 mt-5">
            <Button
              variant="outline"
              disabled={busy || from <= 1}
              onClick={() => showPages(Math.max(1, from - 5))}
            >
              Previous pages
            </Button>
            <Button
              variant="outline"
              disabled={busy || from + 5 > (item.pageCount || 0)}
              onClick={() => showPages(from + 5)}
            >
              Next pages
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
