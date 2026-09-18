import { Skeleton } from "@/components/ui/skeleton";

export default function StudentLoading() {
  return <div className="student-page-loading" aria-label="Loading workspace" aria-busy="true">
    <div className="space-y-3"><Skeleton className="h-4 w-28" /><Skeleton className="h-10 w-72 max-w-full" /><Skeleton className="h-5 w-96 max-w-full" /></div>
    <Skeleton className="h-44 w-full rounded-2xl" />
    <div className="student-page-loading-grid"><Skeleton className="h-80 w-full rounded-2xl" /><Skeleton className="h-80 w-full rounded-2xl" /></div>
  </div>;
}
