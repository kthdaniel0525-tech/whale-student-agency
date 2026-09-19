import { Suspense } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { StudyPlanExperience } from "@/features/student/study-plan/experience";
import { requirePageUser } from "@/server/auth/session";
import { createStudyPlannerAgentService } from "@/server/agents/study-planner";

export const dynamic = "force-dynamic";

async function StudyPlanContent({ planId }: { planId?: string }) {
  await requirePageUser();
  const service = createStudyPlannerAgentService();
  const requestHeaders = await headers();
  const plan = planId ? await service.getPlan(planId, requestHeaders).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "PLAN_NOT_FOUND") notFound();
    throw error;
  }) : await service.getCurrentPlan(requestHeaders);
  return <StudyPlanExperience initialPlan={plan} />;
}

function StudyPlanLoading() {
  return <div className="study-plan-page" aria-label="Loading study plan" aria-busy="true">
    <div className="space-y-3"><Skeleton className="h-4 w-28" /><Skeleton className="h-10 w-64 max-w-full" /><Skeleton className="h-5 w-96 max-w-full" /></div>
    <Skeleton className="h-24 w-full rounded-2xl" />
    <Skeleton className="h-[28rem] w-full rounded-2xl" />
  </div>;
}

export default async function StudyPlanPage({ searchParams }: { searchParams: Promise<{ planId?: string }> }) {
  const { planId } = await searchParams;
  if (planId && (typeof planId !== "string" || planId.length > 100)) notFound();
  return <Suspense fallback={<StudyPlanLoading />}><StudyPlanContent planId={planId} /></Suspense>;
}
