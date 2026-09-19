import Link from "next/link";
import { IntegrationSettings } from "@/features/student/integrations/settings";
import { getIntegrationSettings } from "@/server/integrations/service";
import { headers } from "next/headers";
import { Brain, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requirePageUser } from "@/server/auth/session";
import { listMemories } from "@/server/memory";
import { ProfileForm } from "@/features/student/components/profile-form";
import { NotificationSettings } from "@/features/student/notifications/settings";
import { getNotificationPreferences } from "@/server/preferences/notifications";
export default async function Settings({ searchParams }: { searchParams: Promise<{ integration?: string }> }) {
  const result = await searchParams;
  const { user, profile } = await requirePageUser();
  const requestHeaders = await headers();
  const [memories, preferences, integrations] = await Promise.all([
    listMemories({ status: "active", limit: 100 }, requestHeaders).catch(() => []),
    getNotificationPreferences(user.id),
    getIntegrationSettings(user.id),
  ]);
  const categories = new Set(memories.map((memory) => memory.category)).size;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MAKE IT YOURS</p>
          <h1 className="mt-2">Settings</h1>
          <p>Keep your academic profile and preferences up to date.</p>
        </div>
      </div>
      <section className="panel max-w-4xl">
        <h2 className="mb-6">Academic profile</h2>
        <ProfileForm
          initial={{
            name: user.name,
            school: profile!.school,
            program: profile!.program,
            currentYear: profile!.currentYear,
            semester: profile!.semester,
            academicGoal: profile!.academicGoal,
            studySessionMinutes: profile!.studySessionMinutes,
            explanationDifficulty: profile!.explanationDifficulty,
            timezone: profile!.timezone,
          }}
        />
      </section>
      <NotificationSettings key={preferences.timezone} initial={preferences} />
      <IntegrationSettings initial={integrations} result={result.integration} />
      <section className="panel mt-6 max-w-4xl">
        <div className="settings-memory-heading"><div><p className="eyebrow">Personalization</p><h2>AI context &amp; memory</h2></div><Brain /></div>
        <p className="settings-memory-copy">Your assistant can use your saved profile, conversation history, and supported learning preferences to keep help relevant across sessions.</p>
        <div className="settings-memory-summary" role="status">
          <ShieldCheck />
          <div><strong>{memories.length ? `${memories.length} active ${memories.length === 1 ? "memory" : "memories"}` : "No active memories yet"}</strong><span>{memories.length ? `Across ${categories} ${categories === 1 ? "category" : "categories"}. Context is scoped to your account.` : "Personalization will grow from explicit preferences and supported activity in your account."}</span></div>
        </div>
        <Button asChild variant="outline" size="sm"><Link href="/student/assistant">Open AI Assistant</Link></Button>
      </section>
    </>
  );
}
