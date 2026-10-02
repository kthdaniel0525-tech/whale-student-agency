import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { LegalLinks } from "./legal-links";

export function LegalPage({
  eyebrow,
  title,
  summary,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-svh px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <Link href="/sign-in" className="mb-10 inline-flex items-center gap-3 font-semibold text-foreground">
          <span className="rounded-lg bg-primary p-2 text-primary-foreground"><GraduationCap size={22} /></span>
          Student Agency
        </Link>
        <header className="mb-8">
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          <p className="mt-4 max-w-2xl text-muted-foreground">{summary}</p>
        </header>
        <div className="space-y-5 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:text-muted-foreground [&_ul]:space-y-1">
          {children}
        </div>
        <footer className="mt-10 border-t pt-6 text-muted-foreground">
          <LegalLinks />
        </footer>
      </div>
    </main>
  );
}
