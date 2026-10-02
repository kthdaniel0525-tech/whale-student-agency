"use client";
import { useState } from "react";
import Link from "next/link";
import { GraduationCap, ArrowRight } from "lucide-react";
import { createAuthClient } from "better-auth/react";
import { Button } from "@/components/ui/button";
import { Field } from "./field";
import { LegalLinks } from "@/features/legal/legal-links";
import { credentialsSchema } from "@/features/student/validation/schemas";
const client = createAuthClient();
export function AuthForm({ signup = false }: { signup?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    const parsed = credentialsSchema.safeParse({
      email: data.get("email"),
      password: data.get("password"),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    const name = String(data.get("name") || "").trim();
    if (signup && (!name || name.length > 100)) {
      setError("Enter a name between 1 and 100 characters.");
      return;
    }
    setBusy(true);
    try {
      const result = signup
        ? await client.signUp.email({ ...parsed.data, name })
        : await client.signIn.email(parsed.data);
      if (result.error) {
        setError(
          result.error.message || "Unable to sign in. Please try again.",
        );
        return;
      }
      window.location.assign("/student");
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-svh flex items-center justify-center p-6">
      <div className="auth-card">
        <div className="flex items-center gap-3 mb-10 font-semibold">
          <span className="bg-primary text-primary-foreground p-2 rounded-lg">
            <GraduationCap size={24} />
          </span>
          Student Agency
        </div>
        <p className="eyebrow">YOUR ACADEMIC HOME</p>
        <h1 className="text-3xl font-semibold mt-3 tracking-tight">
          {signup ? "Make room for focus." : "Welcome back."}
        </h1>
        <p className="muted mt-3 mb-7">
          {signup
            ? "Bring your courses, deadlines, and goals together."
            : "Your semester is right where you left it."}
        </p>
        <form onSubmit={submit}>
          <fieldset disabled={busy} className="space-y-5">
            {signup && (
              <Field name="name" label="Name" required autoComplete="name" />
            )}
            <Field
              name="email"
              label="Email address"
              type="email"
              required
              autoComplete="email"
            />
            <Field
              name="password"
              label="Password"
              type="password"
              required
              autoComplete={signup ? "new-password" : "current-password"}
            />
            {signup && (
              <p className="text-sm muted">Use at least 12 characters.</p>
            )}
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <Button className="w-full h-11" type="submit">
              {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
              <ArrowRight size={16} />
            </Button>
          </fieldset>
        </form>
        <p className="text-sm muted mt-7">
          {signup ? "Already have an account?" : "New here?"}{" "}
          <Link
            className="text-primary font-medium"
            href={signup ? "/sign-in" : "/sign-up"}
          >
            {signup ? "Sign in" : "Create an account"}
          </Link>
        </p>
        <LegalLinks className="mt-6 border-t pt-5 text-muted-foreground" />
      </div>
    </main>
  );
}
