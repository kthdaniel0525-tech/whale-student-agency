import Link from "next/link";
import {
  BookOpen,
  CalendarDays,
  ArrowUpRight,
  Sparkles,
  CheckCheck,
} from "lucide-react";
import { requirePageUser } from "@/server/auth/session";
import { dashboard } from "@/server/services/academic";
import { formatDate, countdown } from "@/lib/student/dates";
import { EmptyState } from "@/features/student/components/empty-state";
import { EntityForm } from "@/features/student/components/entity-form";
export default async function Dashboard() {
  const { user, profile } = await requirePageUser();
  const data = await dashboard(user.id);
  const timezone = profile!.timezone;
  const hour = Number(
    new Intl.DateTimeFormat("en", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(new Date()),
  );
  const priorities = [
    ...data.assignments.map((a) => ({
      ...a,
      date: a.dueDate,
      kind: "Assignment",
    })),
    ...data.exams.map((e) => ({ ...e, date: e.examDate, kind: "Exam" })),
  ]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 4);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{profile!.semester}</p>
          <h1 className="mt-2">
            Good {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"},{" "}
            {user.name.split(" ")[0]}.
          </h1>
          <p>A clear view of what matters this semester.</p>
        </div>
        <EntityForm kind="course" semester={profile!.semester} />
      </div>
      <div className="grid sm:grid-cols-3 gap-4 mb-7">
        {[
          [BookOpen, "Your courses", data.courses.length],
          [
            CheckCheck,
            "Open assignments",
            data.courses.reduce((n, c) => n + c._count.assignments, 0),
          ],
          [
            CalendarDays,
            "Next exam",
            data.exams[0]
              ? countdown(data.exams[0].examDate, timezone)
              : "None scheduled",
          ],
        ].map(([Icon, label, value]) => {
          const Symbol = Icon as typeof BookOpen;
          return (
            <div key={String(label)} className="panel flex items-center gap-4">
              <span className="p-3 rounded-xl bg-secondary text-primary">
                <Symbol size={22} />
              </span>
              <div>
                <p className="text-sm muted">{String(label)}</p>
                <p className="text-2xl font-semibold">{String(value)}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="grid xl:grid-cols-[1.6fr_1fr] gap-6">
        <section className="panel">
          <div className="flex items-center justify-between">
            <h2>Today’s priorities</h2>
            <span className="text-xs muted">Nearest deadlines first</span>
          </div>
          {priorities.length ? (
            priorities.map((item) => (
              <Link
                className="deadline-row"
                key={item.id}
                href={`/student/courses/${item.courseId}`}
              >
                <span className="w-10 h-10 shrink-0 rounded-lg bg-secondary text-primary flex items-center justify-center">
                  {item.kind === "Exam" ? (
                    <CalendarDays size={19} />
                  ) : (
                    <BookOpen size={19} />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="text-xs muted">
                    {item.course.courseCode} · {item.kind}
                  </p>
                  <p className="font-medium break-words">{item.title}</p>
                  <p className="text-sm muted">
                    {formatDate(item.date, timezone)}
                  </p>
                </div>
                <span className="ml-auto text-sm text-primary shrink-0">
                  {item.date < new Date()
                    ? "Overdue"
                    : countdown(item.date, timezone)}
                </span>
              </Link>
            ))
          ) : (
            <EmptyState
              title="Room to get organized"
              description="Add a course, then record your assignments and exams. Your nearest deadlines will appear here."
            />
          )}
        </section>
        <section className="panel flex flex-col">
          <div className="flex items-center gap-2">
            <Sparkles size={19} className="text-primary" />
            <h2>AI recommendations</h2>
          </div>
          <EmptyState
            title="Your foundation comes first"
            description="Personalized recommendations will be available in a future release. For now, keep your courses and deadlines up to date."
          />
        </section>
      </div>
      <section className="mt-8">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold">Your courses</h2>
          <Link
            href="/student/courses"
            className="text-primary text-sm flex items-center gap-1"
          >
            View all <ArrowUpRight size={16} />
          </Link>
        </div>
        {data.courses.length ? (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.courses.slice(0, 6).map((course) => (
              <Link
                key={course.id}
                className="course-link"
                href={`/student/courses/${course.id}`}
              >
                <p className="eyebrow">{course.courseCode}</p>
                <h3 className="font-semibold text-lg mt-3">
                  {course.courseName}
                </h3>
                <p className="text-sm muted mt-1">{course.semester}</p>
                <div className="mt-6 text-sm muted">
                  {course._count.assignments} open assignments ·{" "}
                  {course._count.exams} exams
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="panel">
            <EmptyState
              title="Start with your first course"
              description="Create a home for each subject you’re studying."
            />
          </div>
        )}
      </section>
      <div className="grid lg:grid-cols-2 gap-6 mt-8">
        <section className="panel">
          <h2>Upcoming assignments</h2>
          {data.assignments.length ? (
            data.assignments.map((a) => (
              <Link
                key={a.id}
                className="deadline-row"
                href={`/student/courses/${a.courseId}`}
              >
                <div>
                  <p className="font-medium">{a.title}</p>
                  <p className="text-sm muted">
                    {a.course.courseCode} · {formatDate(a.dueDate, timezone)}
                  </p>
                </div>
                <span className="ml-auto text-xs muted">{a.priority}</span>
              </Link>
            ))
          ) : (
            <EmptyState
              title="No open assignments"
              description="Assignments you add to a course will appear here."
            />
          )}
        </section>
        <section className="panel">
          <h2>Upcoming exams</h2>
          {data.exams.length ? (
            data.exams.map((e) => (
              <Link
                key={e.id}
                className="deadline-row"
                href={`/student/courses/${e.courseId}`}
              >
                <div>
                  <p className="font-medium">{e.title}</p>
                  <p className="text-sm muted">
                    {e.course.courseCode} · {formatDate(e.examDate, timezone)}
                  </p>
                </div>
                <span className="ml-auto text-sm text-primary">
                  {countdown(e.examDate, timezone)}
                </span>
              </Link>
            ))
          ) : (
            <EmptyState
              title="No exams scheduled"
              description="Add an exam date to see your countdown."
            />
          )}
        </section>
      </div>
    </>
  );
}
