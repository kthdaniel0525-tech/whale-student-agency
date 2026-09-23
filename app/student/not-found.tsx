import Link from "next/link";
export default function NotFound() {
  return (
    <section className="panel">
      <h1 className="text-xl font-semibold">This page is unavailable.</h1>
      <p className="muted my-4">
        It may have been removed, or you may not have access.
      </p>
      <Link className="text-primary" href="/student/courses">
        Back to courses
      </Link>
    </section>
  );
}
