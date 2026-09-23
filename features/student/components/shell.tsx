"use client";
import { ProductActivityObserver } from "../analytics/observer";
import { FeedbackPrompt } from "../analytics/feedback-prompt";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useState } from "react";
import { createAuthClient } from "better-auth/react";
import { toast } from "sonner";
import {
  GraduationCap,
  LayoutDashboard,
  MessagesSquare,
  BookOpen,
  CalendarDays,
  Files,
  ChartNoAxesCombined,
  BriefcaseBusiness,
  Settings,
  LogOut,
  SunMoon,
} from "lucide-react";
import {
  Sidebar,
  SidebarProvider,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "../notifications/bell";
const links = [
  ["Dashboard", "/student", LayoutDashboard],
  ["AI Assistant", "/student/assistant", MessagesSquare],
  ["Courses", "/student/courses", BookOpen],
  ["Study Plan", "/student/study-plan", CalendarDays],
  ["Documents", "/student/documents", Files],
  ["Progress", "/student/progress", ChartNoAxesCombined],
  ["Career", "/student/career", BriefcaseBusiness],
  ["Settings", "/student/settings", Settings],
] as const;
function Navigation() {
  const path = usePathname();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {links.map(([label, href, Icon]) => (
        <SidebarMenuItem key={href}>
          <SidebarMenuButton
            asChild
            isActive={
              href === "/student" ? path === href : path.startsWith(href)
            }
            className="h-11 text-sm px-4 rounded-lg"
          >
            <Link href={href} onClick={() => setOpenMobile(false)}>
              <Icon />
              <span>{label}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
export function Shell({
  children,
  name,
  semester,
}: {
  children: React.ReactNode;
  name: string;
  semester: string;
}) {
  const path = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [busy, setBusy] = useState(false);
  const currentPage = path === "/student/notifications" ? "Notifications"
    : links.find(([, href]) => href === "/student" ? path === href : path.startsWith(href))?.[0] ?? "Student workspace";
  async function signOut() {
    setBusy(true);
    try {
      const result = await createAuthClient().signOut();
      if (result.error) throw Error();
      window.location.assign("/sign-in");
    } catch {
      toast.error("Unable to sign out. Try again.");
      setBusy(false);
    }
  }
  return (
    <SidebarProvider>
      <ProductActivityObserver />
      <Sidebar>
        <SidebarHeader className="px-6 pt-8 pb-10">
          <Link
            href="/student"
            className="flex gap-3 items-center font-semibold text-foreground"
          >
            <span className="bg-primary text-primary-foreground p-2 rounded-lg">
              <GraduationCap size={22} />
            </span>
            <span>
              Student Agency
              <span className="block text-xs muted font-normal">
                Your academic home
              </span>
            </span>
          </Link>
        </SidebarHeader>
        <SidebarContent className="px-3">
          <span className="eyebrow px-4 pb-3 text-muted-foreground">
            WORKSPACE
          </span>
          <Navigation />
        </SidebarContent>
        <SidebarFooter className="p-5 border-t">
          <Link href="/student/feedback" className="text-sm underline">Feedback &amp; privacy</Link>
          <div className="text-sm font-medium truncate text-foreground">
            {name}
          </div>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={signOut}
            className="justify-start muted px-0"
          >
            <LogOut size={16} />
            {busy ? "Signing out…" : "Sign out"}
          </Button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="bg-background min-w-0">
        <header className="h-18 px-6 md:px-10 flex items-center gap-3 border-b bg-card">
          <SidebarTrigger aria-label="Open navigation" />
          <span className="text-sm font-medium text-foreground">{currentPage}</span>
          <span className="ml-auto text-sm muted hidden sm:inline">
            {semester}
          </span>
          <NotificationBell />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle color theme"
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <SunMoon size={19} />
          </Button>
        </header>
        <main className="student-main">{path !== "/student/feedback" && <FeedbackPrompt />}{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
