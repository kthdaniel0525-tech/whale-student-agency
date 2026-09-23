"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/features/student/components/field";
import { FormError, request } from "@/lib/student/client";
import type { CareerWorkspace } from "@/server/career-workspace/types";

const lines = (value: FormDataEntryValue | null) => String(value ?? "").split("\n").map((item) => item.trim()).filter(Boolean);
const commas = (value: FormDataEntryValue | null) => String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const nullable = (value: FormDataEntryValue | null) => String(value ?? "").trim() || null;

function DialogForm({ title, description, edit, children, onSubmit, onDelete, busy, error }: {
  title: string; description: string; edit?: boolean; children: React.ReactNode;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<boolean>; onDelete?: () => void; busy: boolean; error: string;
}) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={(value) => !busy && setOpen(value)}>
    <DialogTrigger asChild><Button variant={edit ? "outline" : "default"} size={edit ? "sm" : "default"}>{edit ? <Pencil /> : <Plus />}{title}</Button></DialogTrigger>
    <DialogContent className="student-dialog sm:max-w-2xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <form onSubmit={async (event) => { if (await onSubmit(event)) setOpen(false); }} data-close-dialog={open ? "open" : "closed"}>
        <fieldset disabled={busy}><div className="form-grid">{children}</div>{error && <p role="alert" className="field-error mt-4">{error}</p>}
          <div className="form-actions">{onDelete && <Button type="button" variant="destructive" className="mr-auto" onClick={onDelete}><Trash2 /> Delete</Button>}<Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit">{busy ? "Saving…" : "Save"}</Button></div>
        </fieldset>
      </form>
    </DialogContent>
  </Dialog>;
}

export function CareerProfileForm({ profile, compact = false }: { profile: CareerWorkspace["profile"]; compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    try {
      await request("/api/student/career/profile", "PUT", {
        careerGoal: nullable(form.get("careerGoal")), targetRoles: commas(form.get("targetRoles")), targetIndustries: commas(form.get("targetIndustries")),
        targetCompanies: commas(form.get("targetCompanies")), applicationTimeline: nullable(form.get("applicationTimeline")),
        experiences: lines(form.get("experiences")), portfolioLinks: lines(form.get("portfolioLinks")), resumeText: nullable(form.get("resumeText")),
      });
      toast.success("Career profile updated."); router.refresh(); return true;
    } catch (cause) { setError(cause instanceof FormError ? cause.message : "Unable to save your career profile."); return false; }
    finally { setBusy(false); }
  }
  return <DialogForm title={compact ? "Get started" : "Edit career profile"} description="Keep your target and evidence current. Separate roles and industries with commas; use one experience or link per line." edit={!compact} onSubmit={submit} busy={busy} error={error}>
    <Field name="targetRoles" label="Target role(s)" value={profile.targetRoles.join(", ")} wide />
    <Field name="targetIndustries" label="Target industry" value={profile.targetIndustries.join(", ")} wide />
    <Field name="targetCompanies" label="Target companies (comma separated)" value={profile.targetCompanies.join(", ")} wide />
    <Field name="applicationTimeline" label="Application timeline" value={profile.applicationTimeline ?? ""} wide />
    <Field name="careerGoal" label="Career goal" value={profile.careerGoal ?? ""} multiline wide />
    <Field name="experiences" label="Experience evidence (one per line)" value={profile.experiences.join("\n")} multiline wide />
    <Field name="portfolioLinks" label="Portfolio links (one per line)" value={profile.portfolioLinks.join("\n")} multiline wide />
    <Field name="resumeText" label="Resume text" value={profile.resumeText ?? ""} multiline wide />
  </DialogForm>;
}

export function ProjectForm({ project }: { project?: CareerWorkspace["projects"][number] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget);
    try {
      await request(project ? `/api/student/career/projects/${project.id}` : "/api/student/career/projects", project ? "PUT" : "POST", {
        courseId: project?.course?.id ?? null, name: String(form.get("name") ?? "").trim(), description: String(form.get("description") ?? "").trim(),
        technologies: commas(form.get("technologies")), role: nullable(form.get("role")), outcomes: lines(form.get("outcomes")), link: nullable(form.get("link")), repositoryUrl: nullable(form.get("repositoryUrl")),
      });
      toast.success(project ? "Project updated." : "Project added."); router.refresh(); return true;
    } catch (cause) { setError(cause instanceof FormError ? cause.message : "Unable to save the project."); return false; }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!project || !window.confirm(`Delete ${project.name}?`)) return;
    setBusy(true); setError("");
    try { await request(`/api/student/career/projects/${project.id}`, "DELETE"); toast.success("Project deleted."); router.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to delete the project."); }
    finally { setBusy(false); }
  }
  return <DialogForm title={project ? "Edit project" : "Add project"} description="Record only work you can support with project details, outcomes, and links." edit={Boolean(project)} onSubmit={submit} onDelete={project ? remove : undefined} busy={busy} error={error}>
    <Field name="name" label="Project name" value={project?.name ?? ""} required wide />
    <Field name="description" label="Description" value={project?.description ?? ""} required multiline wide />
    <Field name="technologies" label="Technologies (comma separated)" value={project?.technologies.join(", ") ?? ""} wide />
    <Field name="role" label="Your role" value={project?.role ?? ""} wide />
    <Field name="outcomes" label="Outcomes (one per line)" value={project?.outcomes.join("\n") ?? ""} multiline wide />
    <Field name="repositoryUrl" label="Repository URL" value={project?.repositoryUrl ?? ""} type="url" wide />
    <Field name="link" label="Live project URL" value={project?.link ?? ""} type="url" wide />
  </DialogForm>;
}

export function SkillForm({ skill }: { skill?: CareerWorkspace["skillGroups"][number]["skills"][number] & { category?: string } }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget);
    try {
      await request(skill ? `/api/student/career/skills/${skill.id}` : "/api/student/career/skills", skill ? "PUT" : "POST", {
        name: String(form.get("name") ?? "").trim(), category: nullable(form.get("category")), proficiency: nullable(form.get("proficiency")), evidence: lines(form.get("evidence")),
      });
      toast.success(skill ? "Skill updated." : "Skill added."); router.refresh(); return true;
    } catch (cause) { setError(cause instanceof FormError ? cause.message : "Unable to save the skill."); return false; }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!skill || !window.confirm(`Delete ${skill.name}?`)) return;
    setBusy(true); setError("");
    try { await request(`/api/student/career/skills/${skill.id}`, "DELETE"); toast.success("Skill deleted."); router.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to delete the skill."); }
    finally { setBusy(false); }
  }
  return <DialogForm title={skill ? "Edit skill" : "Add skill"} description="Self-reported proficiency is labeled separately from supporting evidence." edit={Boolean(skill)} onSubmit={submit} onDelete={skill ? remove : undefined} busy={busy} error={error}>
    <Field name="name" label="Skill" value={skill?.name ?? ""} required />
    <Field name="category" label="Category" value={skill?.category ?? ""} />
    <Field name="proficiency" label="Self-reported proficiency" value={skill?.proficiency ?? ""} wide />
    <Field name="evidence" label="Evidence (one per line)" value={skill?.evidence.join("\n") ?? ""} multiline wide />
  </DialogForm>;
}
