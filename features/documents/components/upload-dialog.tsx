"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { CourseOption } from "../types";
export function UploadDialog({
  courses,
  courseId,
  onUploaded,
}: {
  courses: CourseOption[];
  courseId?: string;
  onUploaded?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    setError("");
    if (!(file instanceof File) || !file.size || file.size > 10 * 1024 * 1024) {
      setError("Choose a non-empty PDF, TXT or Markdown file up to 10 MB.");
      return;
    }
    if (!form.get("title")) form.set("title", file.name);
    if (!form.get("courseId")) form.delete("courseId");
    setBusy(true);
    try {
      const response = await fetch("/api/student/documents", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw Error(result.error || "Upload failed. Please try again.");
      toast.success("Document uploaded. Processing will start shortly.");
      setOpen(false);
      router.refresh();
      onUploaded?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to upload.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Upload size={16} />
          Upload document
        </Button>
      </DialogTrigger>
      <DialogContent className="student-dialog">
        <DialogHeader>
          <DialogTitle>Upload study material</DialogTitle>
          <DialogDescription>
            Your files stay private. Add a course to keep searches focused.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <fieldset disabled={busy} className="space-y-5">
            <div className="field">
              <label htmlFor="upload-file">Document file</label>
              <Input
                id="upload-file"
                name="file"
                type="file"
                accept=".pdf,.txt,.md,.markdown"
                required
              />
              <p className="muted text-sm">
                PDF, TXT or Markdown · up to 10 MB · text-based PDFs
              </p>
            </div>
            <div className="field">
              <label htmlFor="upload-title">Document title (optional)</label>
              <Input id="upload-title" name="title" maxLength={200} />
            </div>
            {courseId ? (
              <input type="hidden" name="courseId" value={courseId} />
            ) : (
              <div className="field">
                <label htmlFor="upload-course">Course</label>
                <NativeSelect
                  id="upload-course"
                  name="courseId"
                  defaultValue=""
                >
                  <option value="">General study material</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.courseCode} · {c.courseName}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {busy ? "Uploading…" : "Upload file"}
              </Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
