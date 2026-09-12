"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/student/client";
import { DocumentActions } from "./actions";
import { ProcessingStatus } from "./library";
import type { DocumentItem } from "../types";
export function DocumentDetail({ initial }: { initial: DocumentItem }) {
  const [item, setItem] = useState(initial);
  const [pages, setPages] = useState<{ pageNumber: number; content: string }[]>(
    [],
  );
  const [error, setError] = useState("");
  const [from, setFrom] = useState(1);
  const [busy, setBusy] = useState(false);
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
  useEffect(() => {
    if (!["UPLOADED", "PROCESSING"].includes(item.processingStatus)) return;
    const timer = setInterval(() => void reload(), 2500);
    return () => clearInterval(timer);
  }, [item.processingStatus, reload]);
  async function showPages(start: number) {
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
  }
  return (
    <>
      <Link href="/student/documents" className="text-primary text-sm">
        ← Document library
      </Link>
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
