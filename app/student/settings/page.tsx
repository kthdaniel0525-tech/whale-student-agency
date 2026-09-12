import { requirePageUser } from "@/server/auth/session";
import { ProfileForm } from "@/features/student/components/profile-form";
import { EmptyState } from "@/features/student/components/empty-state";
export default async function Settings() {
  const { user, profile } = await requirePageUser();
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
      <section className="panel mt-6 max-w-4xl">
        <h2>AI memory</h2>
        <EmptyState
          title="Memory settings are not available yet"
          description="Your profile preferences are saved above. No AI conversation memory is being collected."
        />
      </section>
    </>
  );
}
