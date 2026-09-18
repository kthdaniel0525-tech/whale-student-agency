import { Suspense } from "react";
import { headers } from "next/headers";
import { Skeleton } from "@/components/ui/skeleton";
import { ProgressExperience } from "@/features/student/progress/progress-experience";
import { requirePageUser } from "@/server/auth/session";
import { getStudentProgress } from "@/server/progress";

export const dynamic = "force-dynamic";

async function ProgressContent() {
  const { user } = await requirePageUser();
  const data = await getStudentProgress(user.id, await headers());
  return <ProgressExperience initial={data} />;
}

function ProgressLoading() {
  return (
    <div className="progress-page" aria-label="Loading learning progress" aria-busy="true">
      <div className="space-y-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <Skeleton className="h-44 w-full rounded-2xl" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-96 w-full rounded-2xl" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    </div>
  );
}

export default function ProgressPage() {
  return <Suspense fallback={<ProgressLoading />}><ProgressContent /></Suspense>;
}
