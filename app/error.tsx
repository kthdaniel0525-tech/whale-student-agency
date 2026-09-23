"use client";
import { Button } from "@/components/ui/button";
export default function ApplicationError({ reset }: { reset: () => void }) {
  return (
    <main className="max-w-xl mx-auto p-8 py-20">
      <h1 className="text-2xl font-semibold">We couldn’t load this page.</h1>
      <p className="muted my-5">
        Please try again. If the problem continues, check that the application
        and database are running.
      </p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
