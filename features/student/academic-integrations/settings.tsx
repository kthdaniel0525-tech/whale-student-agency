"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { request } from "@/lib/student/client";
import type { AcademicSettings, AcademicImportOptions, CourseImportPreview, ExternalCourse, AcademicCourseStatus } from "@/lib/student/academic-integrations/types";
import type { CourseOption } from "@/features/documents/types";
export function AcademicIntegrationSettings() {
    const [settings, setSettings] = useState<AcademicSettings>({ providers: [], accounts: [] }), [error, setError] = useState("");
    const [account, setAccount] = useState(""), [courses, setCourses] = useState<ExternalCourse[]>([]), [next, setNext] = useState<string>(), [external, setExternal] = useState("");
    const [options, setOptions] = useState<AcademicImportOptions>({ assignments: true, assessments: true, files: true });
    const [preview, setPreview] = useState<CourseImportPreview | null>(null), [internal, setInternal] = useState<(CourseOption & {
        semester: string;
    })[]>([]), [target, setTarget] = useState("");
    const [code, setCode] = useState(""), [semester, setSemester] = useState(""), [busy, setBusy] = useState(false), [imported, setImported] = useState<AcademicCourseStatus | null>(null);
    useEffect(() => { let current = true; void request<AcademicSettings>("/api/student/academic-integrations", "GET").then(data => { if (current)
        setSettings(data); }).catch(e => { if (current)
        setError(e.message); }); return () => { current = false; }; }, []);
    async function load(id: string, cursor?: string) { setBusy(true); setError(""); try {
        const result = await request<{
            items: ExternalCourse[];
            nextCursor?: string;
        }>(`/api/student/academic-integrations/accounts/${id}/courses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, "GET");
        setAccount(id);
        setCourses(result.items);
        setNext(result.nextCursor);
        setExternal("");
        setPreview(null);
        const selected = settings.accounts.find(a => a.id === id);
        setOptions({ assignments: Boolean(selected?.capabilities.includes("assignments-read")), assessments: Boolean(selected?.capabilities.includes("assessments-read")), files: Boolean(selected?.capabilities.includes("files-read")) });
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Unable to load courses.");
    }
    finally {
        setBusy(false);
    } }
    async function showPreview() { setBusy(true); setError(""); try {
        const [result, owned] = await Promise.all([request<CourseImportPreview>("/api/student/academic-integrations/preview", "POST", { connectedAccountId: account, externalCourseId: external, options }), request<(CourseOption & {
                semester: string;
            })[]>("/api/student/courses", "GET")]);
        setPreview(result);
        setInternal(owned);
        setTarget("");
        setCode(result.course.code ?? "");
        setSemester(result.course.term ?? "");
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Preview failed.");
    }
    finally {
        setBusy(false);
    } }
    async function importCourse() { if (!preview)
        return; setBusy(true); setError(""); try {
        const selected = internal.find(c => c.id === target);
        setImported(await request<AcademicCourseStatus>("/api/student/academic-integrations/import", "POST", { connectedAccountId: account, externalCourseId: external, options, targetCourseId: target || undefined, previewToken: preview.previewToken, courseCode: selected?.courseCode ?? code, semester: selected?.semester ?? semester, confirmed: true }));
        setPreview(null);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Import failed.");
    }
    finally {
        setBusy(false);
    } }
    return <section id="academic-integrations" className="mt-6 rounded-xl border p-4" aria-label="Course imports"><h3 className="font-semibold">LMS / Course imports</h3>
    {!settings.providers.length && !settings.accounts.length && <p className="mt-2 text-sm text-muted-foreground">Institution connections are not available yet. You can continue adding courses and uploading materials normally.</p>}
    {settings.accounts.map(a => <div key={a.id} className="mt-3 flex flex-wrap items-center gap-3"><span>{a.name} · {a.connected ? "Connected" : "Disconnected"}</span><Button size="sm" variant="outline" disabled={!a.connected || busy} onClick={() => void load(a.id)}>Browse courses</Button><Button size="sm" variant="ghost" disabled={!a.connected || busy} onClick={async () => { setBusy(true); try {
        await request(`/api/student/academic-integrations/accounts/${a.id}`, "DELETE");
        setSettings(s => ({ ...s, accounts: s.accounts.map(row => row.id === a.id ? { ...row, connected: false } : row) }));
        setPreview(null);
        setCourses([]);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Disconnect failed.");
    }
    finally {
        setBusy(false);
    } }}>Disconnect LMS</Button></div>)}
    {!!courses.length && <div className="mt-4 space-y-3"><label className="block">External course<NativeSelect aria-label="External course" value={external} disabled={busy} onChange={e => { setExternal(e.target.value); setPreview(null); }}><option value="">Choose a course</option>{courses.map(c => <option key={c.externalId} value={c.externalId}>{c.code} · {c.name} · {c.term}</option>)}</NativeSelect></label>{next && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load(account, next)}>Next courses</Button>}
      <fieldset className="flex flex-wrap gap-4"><legend className="mb-2 text-sm">Include in this course import</legend>{(["assignments", "assessments", "files"] as const).map(kind => <label key={kind}><input type="checkbox" checked={options[kind]} disabled={busy || !settings.accounts.find(a => a.id === account)?.capabilities.includes(kind === "assignments" ? "assignments-read" : kind === "assessments" ? "assessments-read" : "files-read")} onChange={e => { setOptions(o => ({ ...o, [kind]: e.target.checked })); setPreview(null); }}/> {kind === "files" ? "Course files" : kind === "assessments" ? "Major assessments" : "Assignments"}</label>)}</fieldset><Button disabled={!external || busy} onClick={() => void showPreview()}>Preview import</Button></div>}
    {preview && <div className="mt-4 space-y-3 rounded-lg bg-muted p-4" aria-label="Course import preview"><h4>{preview.course.name}</h4><p>{preview.counts.assignments} assignments · {preview.counts.assessments} exams · {preview.counts.files} files</p>{preview.counts.skipped > 0 && <details><summary>{preview.counts.skipped} items excluded</summary><ul>{preview.skippedReasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></details>}
      {!!preview.suggestions.length && <p>Possible matches: {preview.suggestions.map(s => s.label).join("; ")}. {preview.ambiguous ? "Select the correct course; no match is applied automatically." : "Choose a match below if appropriate."}</p>}
      <label className="block">Course destination<NativeSelect aria-label="Course destination" value={target} disabled={busy} onChange={e => setTarget(e.target.value)}><option value="">Create a new course</option>{internal.map(c => <option key={c.id} value={c.id}>{c.courseCode} · {c.courseName} · {c.semester}</option>)}</NativeSelect></label>
      {!target && <div className="grid gap-3 sm:grid-cols-2"><label>Course code<input className="mt-1 w-full rounded border p-2" aria-label="Import course code" value={code} maxLength={30} onChange={e => setCode(e.target.value)}/></label><label>Semester<input className="mt-1 w-full rounded border p-2" aria-label="Import semester" value={semester} maxLength={80} onChange={e => setSemester(e.target.value)}/></label></div>}
      <p className="text-sm">Future syncs update source titles and deadlines while preserving your priority, effort estimates, completion and personal exam notes.</p><Button disabled={busy || (!target && (!code.trim() || !semester.trim()))} onClick={() => void importCourse()}>Import reviewed course</Button></div>}
    {imported && <p role="status" className="mt-3">Course import queued. <Link className="text-primary underline" href={`/student/courses/${imported.courseId}`}>Open course</Link></p>}
    {error && <p role="alert" className="mt-3 field-error">{error}</p>}
  </section>;
}
