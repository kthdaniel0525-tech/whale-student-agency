import { Suspense } from "react";
import { headers } from "next/headers";
import { Skeleton } from "@/components/ui/skeleton";
import { requirePageUser } from "@/server/auth/session";
import { getStudentDashboard } from "@/server/dashboard";
import { SmartDashboard } from "@/features/student/dashboard/smart-dashboard";

async function DashboardContent() {
  const { user } = await requirePageUser();
  const data = await getStudentDashboard(user.id, await headers());
  return <SmartDashboard key={data.generatedAt} initial={data} />;
}

function DashboardLoading() {
  return (
    <div aria-label="Loading dashboard" aria-busy="true" className="smart-dashboard">
      <div className="space-y-3"><Skeleton className="h-4 w-28" /><Skeleton className="h-10 w-72 max-w-full" /><Skeleton className="h-5 w-96 max-w-full" /></div>
      <Skeleton className="h-52 w-full rounded-2xl" />
      <div className="grid gap-5 lg:grid-cols-2"><Skeleton className="h-96 w-full rounded-2xl" /><Skeleton className="h-96 w-full rounded-2xl" /></div>
    </div>
  );
}

export default function DashboardPage() {
  return <Suspense fallback={<DashboardLoading />}><DashboardContent /></Suspense>;
}
