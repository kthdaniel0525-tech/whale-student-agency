"use client";
import { useCallback, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { FileText, Search } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/features/student/components/empty-state";
import { request } from "@/lib/student/client";
import { UploadDialog } from "./upload-dialog";
import { DocumentActions } from "./actions";
import type { CourseOption, DocumentItem } from "../types";
const labels = {
  UPLOADED: "Queued",
  PROCESSING: "Processing…",
  READY: "Ready",
  FAILED: "Processing failed",
};
export function ProcessingStatus({
  status,
}: {
  status: DocumentItem["processingStatus"];
}) {
  return (
    <span
      className={`text-sm rounded-md px-2 py-1 ${status === "FAILED" ? "text-destructive bg-muted" : status === "READY" ? "text-primary bg-secondary" : "muted bg-muted"}`}
    >
      {labels[status]}
    </span>
  );
}
export function DocumentLibrary({
  courses,
  courseId,
  initial,
}: {
  courses: CourseOption[];
  courseId?: string;
  initial: DocumentItem[];
}) {
  const version = useRef(0);
  const [selected, setSelected] = useState(courseId || "");
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(
    async (filter = selected) => {
      const current = ++version.current;
      try {
        const data = await request<DocumentItem[]>(
          `/api/student/documents${filter ? "?courseId=" + encodeURIComponent(filter) : ""}`,
          "GET",
        );
        if (current !== version.current) return;
        setItems(data);
        setError("");
      } catch (e) {
        if (current === version.current)
          setError(
            e instanceof Error ? e.message : "Unable to load documents.",
          );
      } finally {
        if (current === version.current) setBusy(false);
      }
    },
    [selected],
  );
  useEffect(() => {
    if (
      !items.some((d) =>
        ["UPLOADED", "PROCESSING"].includes(d.processingStatus),
      )
    )
      return;
    const timer = setInterval(() => void reload(), 2500);
    return () => clearInterval(timer);
  }, [items, reload]);
  return (
    <section className={courseId ? "" : "panel"}>
      <div className="flex items-center justify-between flex-wrap gap-4 mb-5">
        {courseId ? (
          <h2>Documents</h2>
        ) : (
          <div className="field">
            <label htmlFor="library-course">Filter by course</label>
            <NativeSelect
              id="library-course"
              value={selected}
              onChange={(e) => {
                setBusy(true);
                setSelected(e.target.value);
                void reload(e.target.value);
              }}
            >
              <option value="">All courses and general material</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.courseCode} · {c.courseName}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        <UploadDialog
          courses={courses}
          courseId={courseId}
          onUploaded={() => void reload()}
        />
      </div>
      {!courseId && (
        <Link
          className="text-primary text-sm inline-flex items-center gap-2 mb-5"
          href="/student/documents/playground"
        >
          <Search size={16} />
          Open retrieval playground
        </Link>
      )}
      {error && (
        <div role="alert" className="field-error mb-4">
          {error}
          <Button variant="ghost" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      )}
      {busy ? (
        <Skeleton className="h-28" />
      ) : items.length ? (
        <div>
          {items.map((d) => (
            <article key={d.id} className="py-5 border-b last:border-0">
              <div className="flex gap-4 items-start">
                <FileText className="text-primary shrink-0 mt-1" size={21} />
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/student/documents/${d.id}`}
                    className="font-semibold hover:underline break-words"
                  >
                    {d.title}
                  </Link>
                  <p className="muted text-sm mt-1">
                    {d.course?.courseCode || "General material"} · {d.fileType}{" "}
                    · {Math.ceil(d.fileSize / 1024)} KB ·{" "}
                    {new Date(d.createdAt).toLocaleDateString("en")}
                  </p>
                  <div className="flex gap-3 items-center flex-wrap mt-3">
                    <ProcessingStatus status={d.processingStatus} />
                    <span className="text-sm muted">
                      {d._count.chunks ? `${d._count.chunks} passages` : ""}
                    </span>
                  </div>
                  {d.processingError && (
                    <p className="field-error mt-2">{d.processingError}</p>
                  )}
                  <div className="mt-3">
                    <DocumentActions
                      id={d.id}
                      failed={d.processingStatus === "FAILED"}
                      onChange={() => void reload()}
                    />
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title="Build your course library"
          description="Upload lecture notes, syllabi or readings. Searchable passages will keep their original document and page sources."
        />
      )}
      {items.some((d) => d.processingStatus === "UPLOADED") && (
        <p className="text-sm muted mt-5">
          Your files are queued for processing. This page updates automatically.
        </p>
      )}
    </section>
  );
}
