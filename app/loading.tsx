import { Skeleton } from "@/components/ui/skeleton";
export default function Loading() {
  return (
    <main
      aria-label="Loading application"
      role="status"
      className="max-w-3xl mx-auto p-8 space-y-6"
    >
      <Skeleton className="h-10 w-2/3" />
      <Skeleton className="h-80 w-full" />
    </main>
  );
}
