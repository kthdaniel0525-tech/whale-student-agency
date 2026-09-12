import { Skeleton } from "@/components/ui/skeleton";
export default function Loading() {
  return (
    <div
      aria-label="Loading your workspace"
      role="status"
      className="space-y-6"
    >
      <Skeleton className="h-10 w-64" />
      <div className="grid md:grid-cols-3 gap-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}
