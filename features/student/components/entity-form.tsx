"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  courseSchema,
  assignmentSchema,
  examSchema,
} from "@/features/student/validation/schemas";
import { Field } from "./field";
import { FormError, request } from "@/lib/student/client";
import { localInput } from "@/lib/student/dates";
type Kind = "course" | "assignment" | "exam";
type Values = Record<string, string | number | string[] | null>;
export function EntityForm({
  kind,
  courseId,
  initial,
  semester,
}: {
  kind: Kind;
  courseId?: string;
  initial?: Values;
  semester?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const edit = !!initial?.id;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setErrors({});
    const form = new FormData(event.currentTarget);
    const raw: Record<string, unknown> = Object.fromEntries(form);
    if (kind === "assignment") raw.estimatedHours = Number(raw.estimatedHours);
    if (kind === "exam")
      raw.topics = String(raw.topics)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    const dateKey = kind === "assignment" ? "dueDate" : "examDate";
    if (kind !== "course") {
      const date = new Date(String(raw[dateKey]));
      raw[dateKey] = Number.isNaN(date.getTime()) ? "" : date.toISOString();
    }
    const schema =
      kind === "course"
        ? courseSchema
        : kind === "assignment"
          ? assignmentSchema
          : examSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      setErrors(parsed.error.flatten().fieldErrors);
      setError("Please check the highlighted fields.");
      return;
    }
    const path = edit
      ? `/api/student/${kind}s/${initial!.id}`
      : kind === "course"
        ? "/api/student/courses"
        : `/api/student/courses/${courseId}/${kind}s`;
    setBusy(true);
    try {
      await request(path, edit ? "PUT" : "POST", parsed.data);
      toast.success(
        `${kind[0].toUpperCase() + kind.slice(1)} ${edit ? "updated" : "created"}.`,
      );
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
      if (e instanceof FormError) setErrors(e.fields);
    } finally {
      setBusy(false);
    }
  }
  const field = (name: string, fallback = "") => ({
    name,
    value:
      typeof initial?.[name] === "number"
        ? (initial[name] as number)
        : String(initial?.[name] ?? fallback),
    error: errors[name]?.[0],
  });
  const title = `${edit ? "Edit" : "Add"} ${kind}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError("");
          setErrors({});
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={edit ? "outline" : "default"}
          size={edit ? "sm" : "default"}
        >
          {edit ? <Pencil size={14} /> : <Plus size={16} />}
          {title}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="student-dialog sm:max-w-xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {kind === "course"
              ? "Keep the essentials of your course in one place."
              : "Add a deadline to keep your semester on track. Times use your device timezone."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <div className="form-grid">
              {kind === "course" ? (
                <>
                  <Field
                    {...field("courseCode")}
                    label="Course code"
                    required
                  />
                  <Field
                    {...field("courseName")}
                    label="Course name"
                    required
                  />
                  <Field {...field("professor")} label="Professor" />
                  <Field
                    {...field("semester", semester)}
                    label="Semester"
                    required
                  />
                  <Field
                    {...field("description")}
                    label="Description"
                    multiline
                    wide
                  />
                </>
              ) : (
                <>
                  <Field {...field("title")} label="Title" required wide />
                  <Field
                    name={kind === "assignment" ? "dueDate" : "examDate"}
                    label={kind === "assignment" ? "Due date" : "Exam date"}
                    type="datetime-local"
                    value={
                      initial?.[kind === "assignment" ? "dueDate" : "examDate"]
                        ? localInput(
                            String(
                              initial[
                                kind === "assignment" ? "dueDate" : "examDate"
                              ],
                            ),
                          )
                        : ""
                    }
                    required
                    wide
                    error={
                      errors[
                        kind === "assignment" ? "dueDate" : "examDate"
                      ]?.[0]
                    }
                  />
                  {kind === "assignment" ? (
                    <>
                      <Field
                        {...field("status", "TODO")}
                        label="Status"
                        options={[
                          ["TODO", "To do"],
                          ["IN_PROGRESS", "In progress"],
                          ["COMPLETED", "Completed"],
                        ]}
                      />
                      <Field
                        {...field("priority", "MEDIUM")}
                        label="Priority"
                        options={[
                          ["LOW", "Low"],
                          ["MEDIUM", "Medium"],
                          ["HIGH", "High"],
                        ]}
                      />
                      <Field
                        {...field("estimatedHours", "1")}
                        label="Estimated hours"
                        type="number"
                        min={0}
                        max={1000}
                        step="0.25"
                        required
                      />
                      <Field
                        {...field("description")}
                        label="Description"
                        multiline
                        wide
                      />
                    </>
                  ) : (
                    <>
                      <Field
                        name="topics"
                        label="Topics (one per line)"
                        value={
                          Array.isArray(initial?.topics)
                            ? initial.topics.join("\n")
                            : ""
                        }
                        multiline
                        wide
                        error={errors.topics?.[0]}
                      />
                      <Field {...field("notes")} label="Notes" multiline wide />
                    </>
                  )}
                </>
              )}
            </div>
            {error && (
              <p role="alert" className="field-error mt-4">
                {error}
              </p>
            )}
            <div className="form-actions">
              <Button
                variant="outline"
                type="button"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {busy ? "Saving…" : edit ? "Save changes" : `Create ${kind}`}
              </Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
