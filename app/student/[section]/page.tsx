import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/session";
import { EmptyState } from "@/features/student/components/empty-state";
const pages: Record<string, [string, string]> = {
  assistant: [
    "AI Assistant",
    "Course-aware conversations will be available in a future release.",
  ],
  "study-plan": [
    "Study Plan",
    "Personalized study schedules will be available in a future release.",
  ],
  progress: [
    "Progress",
    "Learning and topic mastery tracking will be available in a future release.",
  ],
  career: [
    "Career",
    "Academic projects and career tools will be available in a future release.",
  ],
};
export default async function FuturePage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  await requirePageUser();
  const page = pages[(await params).section];
  if (!page) notFound();
  return (
    <>
      <div className="page-heading">
        <h1>{page[0]}</h1>
      </div>
      <section className="panel">
        <EmptyState title="A little further ahead" description={page[1]} />
      </section>
    </>
  );
}
