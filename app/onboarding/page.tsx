import { redirect } from "next/navigation";
import { requirePageUser } from "@/server/auth/session";
import { ProfileForm } from "@/features/student/components/profile-form";
export const dynamic = "force-dynamic";
export default async function Onboarding() {
  const { user, profile } = await requirePageUser(false);
  if (profile) redirect("/student");
  return (
    <main className="max-w-3xl mx-auto p-6 py-12">
      <p className="eyebrow">STUDENT AGENCY · GETTING STARTED</p>
      <h1 className="text-3xl font-semibold mt-4">
        Let’s get to know your semester.
      </h1>
      <p className="muted mt-3 mb-8">
        A few details to make this space yours. You can change them anytime in
        Settings.
      </p>
      <section className="panel">
        <ProfileForm
          onboarding
          initial={{
            name: user.name,
            currentYear: 1,
            studySessionMinutes: 45,
            explanationDifficulty: "INTERMEDIATE",
            timezone: "America/Winnipeg",
          }}
        />
      </section>
    </main>
  );
}
