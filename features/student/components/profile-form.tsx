"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field } from "./field";
import {
  profileSchema,
  type ProfileInput,
} from "@/features/student/validation/schemas";
import { FormError, request } from "@/lib/student/client";
export function ProfileForm({
  initial,
  onboarding = false,
}: {
  initial: Partial<ProfileInput>;
  onboarding?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string[]>>({});
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setFields({});
    const form = new FormData(event.currentTarget);
    const data = {
      ...Object.fromEntries(form),
      currentYear: Number(form.get("currentYear")),
      studySessionMinutes: Number(form.get("studySessionMinutes")),
    };
    const result = profileSchema.safeParse(data);
    if (!result.success) {
      setFields(result.error.flatten().fieldErrors);
      setError("Please check the highlighted fields.");
      return;
    }
    setBusy(true);
    try {
      await request("/api/student/profile", "PUT", result.data);
      toast.success(onboarding ? "Your semester is ready." : "Settings saved.");
      if (onboarding) router.replace("/student");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
      if (e instanceof FormError) setFields(e.fields);
    } finally {
      setBusy(false);
    }
  }
  const field = (name: keyof ProfileInput) => ({
    name,
    value: initial[name],
    error: fields[name]?.[0],
  });
  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <div className="form-grid">
          <Field {...field("name")} label="Name" required autoComplete="name" />
          <Field {...field("school")} label="University or school" required />
          <Field {...field("program")} label="Program / major" required />
          <Field
            {...field("currentYear")}
            label="Current year"
            type="number"
            required
            min={1}
            max={12}
          />
          <Field {...field("semester")} label="Current semester" required />
          <Field {...field("timezone")} label="Timezone" required />
          <Field
            {...field("academicGoal")}
            label="Academic goal"
            multiline
            wide
            required
          />
          <Field
            {...field("studySessionMinutes")}
            label="Study session length (minutes)"
            type="number"
            min={10}
            max={180}
            required
          />
          <Field
            {...field("explanationDifficulty")}
            label="Explanation difficulty"
            options={[
              ["BEGINNER", "Beginner — build the basics"],
              ["INTERMEDIATE", "Intermediate — connect concepts"],
              ["ADVANCED", "Advanced — go deeper"],
            ]}
          />
        </div>
        {error && (
          <p role="alert" className="field-error mt-5">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button type="submit" disabled={busy}>
            {busy
              ? "Saving…"
              : onboarding
                ? "Open my dashboard"
                : "Save changes"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
