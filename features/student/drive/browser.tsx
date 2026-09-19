"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { request } from "@/lib/student/client";
import type { IntegrationSettingsView } from "@/lib/student/integrations/types";
import type { CourseOption } from "@/features/documents/types";
import type { DriveFilePage, DriveImportView, ExternalDriveFile } from "@/lib/student/drive/types";
const EMPTY_COURSES: CourseOption[] = [];
export function DriveBrowser({ courses: initialCourses = EMPTY_COURSES, courseId, accountId: initialAccountId, onImported, label = "Import from Google Drive" }: {
    courses?: CourseOption[];
    courseId?: string;
    accountId?: string;
    onImported?: () => void;
    label?: string;
}) {
    const uid = useId(), generation = useRef(0), notify = useRef(onImported);
    useEffect(() => { notify.current = onImported; }, [onImported]);
    const [open, setOpen] = useState(false), [accounts, setAccounts] = useState<IntegrationSettingsView["accounts"]>([]);
    const [courses, setCourses] = useState(initialCourses), [course, setCourse] = useState(courseId ?? ""), [account, setAccount] = useState(initialAccountId ?? "");
    const [page, setPage] = useState<DriveFilePage>({ files: [], nextPageToken: null }), [search, setSearch] = useState("");
    const [folders, setFolders] = useState<{
        id: string;
        name: string;
    }[]>([]), [selected, setSelected] = useState<Record<string, ExternalDriveFile>>({});
    const [imports, setImports] = useState<DriveImportView[]>([]), [failures, setFailures] = useState<string[]>([]);
    const [busy, setBusy] = useState(false), [importing, setImporting] = useState(false), [error, setError] = useState("");
    const folderId = folders.at(-1)?.id;
    useEffect(() => {
        if (!open)
            return;
        let current = true;
        void Promise.all([request<IntegrationSettingsView>("/api/student/integrations", "GET"), initialCourses.length ? Promise.resolve(initialCourses) : request<CourseOption[]>("/api/student/courses", "GET")]).then(([settings, list]) => {
            if (!current)
                return;
            const available = settings.accounts.filter(a => a.provider === "google" && a.status === "connected" && a.capabilities.includes("drive-read"));
            setAccounts(available);
            setCourses(list);
            setAccount(previous => available.some(a => a.id === previous) ? previous : available[0]?.id ?? "");
        }).catch(e => { if (current)
            setError(e.message); });
        return () => { current = false; };
    }, [open, initialCourses]);
    const load = useCallback(async (query = "", folder?: string, token?: string) => {
        if (!account)
            return;
        const version = ++generation.current;
        setBusy(true);
        setError("");
        const params = new URLSearchParams({ ...(query ? { search: query } : {}), ...(folder ? { folderId: folder } : {}), ...(token ? { pageToken: token } : {}) });
        try {
            const data = await request<DriveFilePage>(`/api/student/drive/accounts/${encodeURIComponent(account)}/files?${params}`, "GET");
            if (version === generation.current)
                setPage(data);
        }
        catch (e) {
            if (version === generation.current)
                setError(e instanceof Error ? e.message : "Drive could not be loaded.");
        }
        finally {
            if (version === generation.current)
                setBusy(false);
        }
    }, [account]);
    useEffect(() => {
        const counter = generation;
        const timer = setTimeout(() => {
            if (open && account) {
                setSelected({});
                setFolders([]);
                setSearch("");
                setPage({ files: [], nextPageToken: null });
                void load();
            }
        }, 0);
        return () => { clearTimeout(timer); counter.current++; };
    }, [open, account, load]);
    useEffect(() => {
        if (!open || !account)
            return;
        let cancelled = false;
        const refresh = async () => {
            try {
                const rows = await request<DriveImportView[]>(`/api/student/drive/accounts/${encodeURIComponent(account)}/imports${course ? `?courseId=${encodeURIComponent(course)}` : ""}`, "GET");
                if (!cancelled) {
                    setImports(rows);
                    notify.current?.();
                }
            }
            catch (e) {
                if (!cancelled)
                    setError(e instanceof Error ? e.message : "Import progress could not be loaded.");
            }
        };
        void refresh();
        const timer = setInterval(() => void refresh(), 3000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [open, account, course]);
    async function importSelected() {
        setImporting(true);
        setFailures([]);
        setError("");
        const results = await Promise.allSettled(Object.values(selected).map(async (file) => {
            try {
                return await request<DriveImportView>("/api/student/drive/imports", "POST", { connectedAccountId: account, externalFileId: file.externalId, courseId: course });
            }
            catch (e) {
                throw new Error(`${file.name}: ${e instanceof Error ? e.message : "Import failed"}`);
            }
        }));
        const successful = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
        setImports(previous => [...successful, ...previous.filter(row => !successful.some(x => x.id === row.id))]);
        setFailures(results.flatMap(result => result.status === "rejected" ? [String(result.reason.message)] : []));
        setSelected({});
        setImporting(false);
        notify.current?.();
    }
    return <Dialog open={open} onOpenChange={value => { if (!importing)
        setOpen(value); }}><DialogTrigger asChild><Button variant="outline">{label}</Button></DialogTrigger>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Import from Google Drive</DialogTitle><DialogDescription>Select files to copy into your course library. Only selected files are downloaded. PDF, TXT, Markdown and Google Docs, up to 10 MB.</DialogDescription></DialogHeader>
      {error && <p role="alert" className="field-error">{error}</p>}
      {!accounts.length ? <p>Enable Google Drive in <Link className="text-primary underline" href="/student/settings#integrations">Settings → Integrations</Link> to browse your files.</p> : <>
        <div className="grid gap-3 sm:grid-cols-2"><div className="field"><label htmlFor={`${uid}-account`}>Google account</label><NativeSelect id={`${uid}-account`} value={account} disabled={importing} onChange={e => setAccount(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.email ?? a.displayName ?? "Google account"}</option>)}</NativeSelect></div>
          <div className="field"><label htmlFor={`${uid}-course`}>Import to course</label><NativeSelect id={`${uid}-course`} value={course} disabled={Boolean(courseId) || importing} onChange={e => setCourse(e.target.value)}><option value="">Choose a course</option>{courses.map(c => <option key={c.id} value={c.id}>{c.courseCode} · {c.courseName}</option>)}</NativeSelect></div></div>
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void load(search, folderId); }}><label className="sr-only" htmlFor={`${uid}-search`}>Search Drive by filename</label><input className="min-w-0 flex-1 rounded-md border px-3" id={`${uid}-search`} value={search} maxLength={100} placeholder="Search by filename" onChange={e => setSearch(e.target.value)}/><Button type="submit" variant="outline" disabled={busy}>Search</Button></form>
        <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setFolders([]); void load(search); }}>Recent files</Button>{folders.map((folder, index) => <Button key={folder.id} size="sm" variant="ghost" disabled={busy} onClick={() => { setFolders(folders.slice(0, index + 1)); void load(search, folder.id); }}>{folder.name}</Button>)}</div>
        <div aria-busy={busy} className="max-h-64 overflow-y-auto rounded-lg border">{busy ? <p className="p-4" role="status">Loading Drive files…</p> : page.files.length ? page.files.map(file => <div key={file.externalId} className="border-b p-3 last:border-0">
          {file.folder ? <Button size="sm" variant="ghost" onClick={() => { setFolders([...folders, { id: file.externalId, name: file.name }]); void load(search, file.externalId); }}>Open folder: {file.name}</Button> : <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={Boolean(selected[file.externalId])} disabled={importing || !file.importable || (!selected[file.externalId] && Object.keys(selected).length >= 10)} onChange={e => setSelected(previous => { const next = { ...previous }; if (e.target.checked)
                next[file.externalId] = file;
            else
                delete next[file.externalId]; return next; })}/><span className="min-w-0 break-words"><span>{file.name}</span><span className="block text-xs text-muted-foreground">{file.unavailableReason ?? (file.exportable ? "Google Doc · imported as PDF" : file.size === null ? "Size checked during download" : `${Math.ceil(file.size / 1024)} KB`)}</span></span></label>}</div>) : <p className="p-4">No files found.</p>}</div>
        {page.nextPageToken && <Button variant="ghost" disabled={busy} onClick={() => void load(search, folderId, page.nextPageToken ?? undefined)}>Next page</Button>}
        <Button disabled={!course || !Object.keys(selected).length || importing || busy} onClick={() => void importSelected()}>{importing ? "Requesting imports…" : `Import selected (${Object.keys(selected).length}/10)`}</Button>
      </>}
      {!!failures.length && <ul role="alert" className="text-sm text-destructive">{failures.map((failure, i) => <li key={i}>{failure}</li>)}</ul>}
      {!!imports.length && <section aria-label="Import progress"><h3 className="font-medium">Import progress</h3><p role="status" className="my-2 text-sm">{["Ready", "Processing", "Importing", "Failed"].map(status => `${imports.filter(row => row.status === status).length + (status === "Failed" ? failures.length : 0)} ${status}`).join(" · ")}</p><ul className="max-h-48 space-y-2 overflow-y-auto text-sm">{imports.map(row => <li key={row.id} className="rounded border p-2"><span className="break-words">{row.name} · {row.status}</span>{row.documentId && <Link href={`/student/documents/${row.documentId}`} className="ml-2 text-primary underline">Open document</Link>}{row.error && <p className="text-destructive">{row.error}</p>}</li>)}</ul></section>}
    </DialogContent></Dialog>;
}
