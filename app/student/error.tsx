"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="panel">
      <h1 className="text-xl font-semibold">
        We couldn’t load your workspace.
      </h1>
      <p className="muted my-4">
        Your data has not been changed. Please try again.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
