import { Suspense } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { CourseWorkspace } from "@/features/student/courses/course-workspace";
import { requirePageUser } from "@/server/auth/session";
import { getCourseWorkspace } from "@/server/course-workspace";
import { NotFoundError } from "@/server/services/academic";

export const dynamic = "force-dynamic";

const workspaceTabs = new Set(["overview", "assignments", "exams", "documents", "notes", "progress"]);

async function WorkspaceContent({ id, initialTab }: { id: string; initialTab: string }) {
  const { user } = await requirePageUser();
  const workspace = await getCourseWorkspace(user.id, id, await headers()).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  return <CourseWorkspace initial={workspace} initialTab={initialTab} />;
}

function WorkspaceLoading() {
  return <div className="course-workspace" aria-label="Loading course workspace" aria-busy="true">
    <Skeleton className="h-4 w-28" />
    <div className="space-y-3">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-10 w-72 max-w-full" />
      <Skeleton className="h-5 w-56 max-w-full" />
    </div>
    <Skeleton className="h-12 w-full rounded-xl" />
    <div className="grid gap-5 lg:grid-cols-2">
      <Skeleton className="h-96 w-full rounded-2xl" />
      <Skeleton className="h-96 w-full rounded-2xl" />
    </div>
  </div>;
}

export default async function CourseDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { id } = await params;
  const requestedTab = (await searchParams).tab;
  const initialTab = typeof requestedTab === "string" && workspaceTabs.has(requestedTab)
    ? requestedTab
    : "overview";
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <WorkspaceContent id={id} initialTab={initialTab} />
    </Suspense>
  );
}
