import { Suspense } from "react";
import { headers } from "next/headers";
import { Skeleton } from "@/components/ui/skeleton";
import { StudyPlanExperience } from "@/features/student/study-plan/experience";
import { requirePageUser } from "@/server/auth/session";
import { createStudyPlannerAgentService } from "@/server/agents/study-planner";

export const dynamic = "force-dynamic";

async function StudyPlanContent() {
  await requirePageUser();
  const plan = await createStudyPlannerAgentService().getCurrentPlan(await headers());
  return <StudyPlanExperience initialPlan={plan} />;
}

function StudyPlanLoading() {
  return <div className="study-plan-page" aria-label="Loading study plan" aria-busy="true">
    <div className="space-y-3"><Skeleton className="h-4 w-28" /><Skeleton className="h-10 w-64 max-w-full" /><Skeleton className="h-5 w-96 max-w-full" /></div>
    <Skeleton className="h-24 w-full rounded-2xl" />
    <Skeleton className="h-[28rem] w-full rounded-2xl" />
  </div>;
}

export default function StudyPlanPage() {
  return <Suspense fallback={<StudyPlanLoading />}><StudyPlanContent /></Suspense>;
}
