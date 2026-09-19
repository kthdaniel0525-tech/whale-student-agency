"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
export function NotificationBell() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      fetch("/api/student/notifications/unread-count", { cache: "no-store" })
        .then(async (response) => { if (response.ok) { const data = await response.json() as { count: number }; if (!disposed) setCount(data.count); } })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    window.addEventListener("notifications-changed", refresh);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("notifications-changed", refresh); };
  }, []);
  return <Button asChild variant="ghost" size="icon" className="relative ml-auto sm:ml-0">
    <Link href="/student/notifications" aria-label={`Notifications${count ? `, ${count} unread` : ""}`}>
      <Bell size={19} />{count > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-[10px] text-primary-foreground">{count > 99 ? "99+" : count}</span>}
    </Link>
  </Button>;
}
