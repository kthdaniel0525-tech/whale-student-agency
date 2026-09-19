import { Skeleton } from "@/components/ui/skeleton";
export default function SettingsLoading() {
  return <div role="status" aria-label="Loading settings" className="max-w-4xl space-y-6"><Skeleton className="h-10 w-40" /><Skeleton className="h-80 w-full rounded-xl" /><Skeleton className="h-96 w-full rounded-xl" /><span className="sr-only">Loading your saved settings…</span></div>;
}
