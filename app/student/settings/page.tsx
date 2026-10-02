import Link from "next/link";
import { Brain, ShieldCheck } from "lucide-react";
import { headers } from "next/headers";
import { Button } from "@/components/ui/button";
import { LegalLinks } from "@/features/legal/legal-links";
import { ProfileForm } from "@/features/student/components/profile-form";
import { PlanAccessSummary } from "@/features/student/entitlements/access";
import { IntegrationSettings } from "@/features/student/integrations/settings";
import { NotificationSettings } from "@/features/student/notifications/settings";
import { AccountDeletion } from "@/features/student/settings/account-deletion";
import { ConversationManager } from "@/features/student/settings/conversation-manager";
import { MemoryManager } from "@/features/student/settings/memory-manager";
import { requirePageUser } from "@/server/auth/session";
import { listConversations } from "@/server/conversations";
import { getIntegrationSettings } from "@/server/integrations/service";
import { listMemories } from "@/server/memory";
import { getNotificationPreferences } from "@/server/preferences/notifications";

export default async function Settings({ searchParams }: { searchParams: Promise<{ integration?: string }> }) {
  const result = await searchParams;
  const { user, profile } = await requirePageUser();
  const requestHeaders = await headers();
  const [memories, preferences, integrations, conversations] = await Promise.all([
    listMemories({ limit: 100 }, requestHeaders),
    getNotificationPreferences(user.id),
    getIntegrationSettings(user.id),
    listConversations(requestHeaders, 30),
  ]);
  const activeMemories = memories.filter((memory) => memory.status === "active");
  const categories = new Set(activeMemories.map((memory) => memory.category)).size;
  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">MAKE IT YOURS</p><h1 className="mt-2">Settings</h1><p>Keep your academic profile, preferences, and data controls up to date.</p></div></div>
      <PlanAccessSummary />
      <section className="panel mb-6 max-w-4xl"><h2>Help, legal &amp; privacy</h2><p className="my-3">Report a problem, manage product usage tracking, or review the current Privacy, Terms, and Support information.</p><div className="flex flex-wrap items-center gap-4"><Button asChild variant="outline"><Link href="/student/feedback">Send feedback &amp; manage privacy</Link></Button><LegalLinks className="text-muted-foreground" /></div></section>
      <section className="panel max-w-4xl"><h2 className="mb-6">Academic profile</h2><ProfileForm initial={{ name: user.name, school: profile!.school, program: profile!.program, currentYear: profile!.currentYear, semester: profile!.semester, academicGoal: profile!.academicGoal, studySessionMinutes: profile!.studySessionMinutes, explanationDifficulty: profile!.explanationDifficulty, timezone: profile!.timezone }} /></section>
      <NotificationSettings key={preferences.timezone} initial={preferences} />
      <IntegrationSettings initial={integrations} result={result.integration} />
      <section className="panel mt-6 max-w-4xl" aria-labelledby="memory-data-heading">
        <div className="settings-memory-heading"><div><p className="eyebrow">Personalization</p><h2 id="memory-data-heading">AI context &amp; memory</h2></div><Brain aria-hidden="true" /></div>
        <p className="settings-memory-copy">Your assistant can use your saved profile, conversation history, and supported learning preferences to keep help relevant across sessions.</p>
        <div className="settings-memory-summary" role="status"><ShieldCheck aria-hidden="true" /><div><strong>{activeMemories.length ? `${activeMemories.length} active ${activeMemories.length === 1 ? "memory" : "memories"}` : "No active memories yet"}</strong><span>{activeMemories.length ? `Across ${categories} ${categories === 1 ? "category" : "categories"}. Context is scoped to your account.` : "Personalization will grow from explicit preferences and supported activity in your account."}</span></div></div>
        <Button asChild variant="outline" size="sm"><Link href="/student/assistant">Open AI Assistant</Link></Button>
        <MemoryManager initial={memories} />
      </section>
      <ConversationManager initial={conversations} />
      <AccountDeletion />
    </>
  );
}
