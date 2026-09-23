"use client";
import { INTEGRATION_HEALTH_LABELS } from "@/lib/student/integrations/health";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { request } from "@/lib/student/client";
import type { AcademicCourseStatus } from "@/lib/student/academic-integrations/types";
export function AcademicCourseSync({ courseId, onSynced }: {
    courseId: string;
    onSynced: () => void;
}) {
    const [state, setState] = useState<AcademicCourseStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const notify = useRef(onSynced), last = useRef<{
        courseId: string;
        stamp: string | null;
    } | null>(null);
    useEffect(() => { notify.current = onSynced; }, [onSynced]);
    useEffect(() => {
        let current = true;
        let timer: ReturnType<typeof setTimeout>;
        const read = async () => {
            try {
                const value = await request<AcademicCourseStatus | null>(`/api/student/courses/${courseId}/integration`, "GET");
                if (!current)
                    return;
                setState(value);
                if (last.current?.courseId === courseId && value?.lastSyncedAt && last.current.stamp !== value.lastSyncedAt)
                    notify.current();
                last.current = { courseId, stamp: value?.lastSyncedAt ?? null };
                if (value)
                    timer = setTimeout(() => void read(), value.pending || value.status === "syncing" ? 5000 : 30000);
            }
            catch {
                if (current) {
                    setError("Course sync status could not be loaded.");
                    timer = setTimeout(() => void read(), 30000);
                }
            }
        };
        void read();
        return () => { current = false; clearTimeout(timer); };
    }, [courseId, busy]);
    if (!state)
        return error ? <p className="text-sm text-muted-foreground">{error}</p> : null;
    const result = state.result;
    return <section className="mb-4 rounded-lg border p-3 text-sm" aria-label="Course integration status"><p>Synced with {state.providerName} · {state.health ? INTEGRATION_HEALTH_LABELS[state.health.state] : state.status}</p><p>Last sync: {state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : "Not yet"}</p>{result && <p>Created: {result.created.assignments} assignments, {result.created.assessments} exams, {result.created.files} files · Updated: {result.updated.assignments} assignments, {result.updated.assessments} exams, {result.updated.files} files · Failed: {result.failed}{result.created.skipped ? ` · ${result.created.skipped} items skipped (unsupported or no scheduled date; existing copies kept)` : ""}{result.missing ? ` · ${result.missing} sources missing; imported data preserved` : ""}</p>}
    <div className="mt-2 flex gap-3"><Button size="sm" variant="outline" disabled={!state.active || busy || state.pending || state.status === "syncing"} onClick={async () => { setBusy(true); setError(""); try {
        setState(await request<AcademicCourseStatus>(`/api/student/courses/${courseId}/integration/sync`, "POST"));
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Sync could not start.");
    }
    finally {
        setBusy(false);
    } }}>Sync Now</Button><Link className="self-center text-primary underline" href="/student/settings#academic-integrations">Manage Integration</Link></div>{error && <p role="alert" className="field-error mt-2">{error}</p>}
  </section>;
}
