import Link from "next/link";

export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Legal and support" className={`flex flex-wrap gap-x-4 gap-y-2 text-sm ${className}`.trim()}>
      <Link className="underline underline-offset-4" href="/privacy">Privacy</Link>
      <Link className="underline underline-offset-4" href="/terms">Terms</Link>
      <Link className="underline underline-offset-4" href="/support">Support</Link>
    </nav>
  );
}
