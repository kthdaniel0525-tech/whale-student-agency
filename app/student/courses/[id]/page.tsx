import Link from "next/link";
import { DocumentLibrary } from "@/features/documents/components/library";
import { listDocuments } from "@/server/documents/service";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/session";
import { getCourse, NotFoundError } from "@/server/services/academic";
import { EntityForm } from "@/features/student/components/entity-form";
import {
  CompleteAssignment,
  DeleteItem,
} from "@/features/student/components/item-actions";
import { EmptyState } from "@/features/student/components/empty-state";
import { formatDate, countdown } from "@/lib/student/dates";
export default async function CourseDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, profile } = await requirePageUser();
  const { id } = await params;
  const course = await getCourse(user.id, id).catch((error) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const timezone = profile!.timezone;
  const documents = await listDocuments(user.id, id);
  return (
    <>
      <Link href="/student/courses" className="text-sm text-primary">
        ← All courses
      </Link>
      <div className="page-heading mt-5">
        <div>
          <p className="eyebrow">{course.courseCode}</p>
          <h1 className="mt-2">{course.courseName}</h1>
          <p>{course.semester}</p>
        </div>
        <div className="flex gap-2">
          <EntityForm
            kind="course"
            initial={{
              id: course.id,
              courseCode: course.courseCode,
              courseName: course.courseName,
              professor: course.professor,
              semester: course.semester,
              description: course.description,
            }}
          />
          <DeleteItem kind="course" id={id} />
        </div>
      </div>
      <section className="panel mb-6">
        <h2>Overview</h2>
        <p className="muted text-sm mt-3">
          Professor: {course.professor || "Not added"}
        </p>
        <p className="mt-3 whitespace-pre-wrap break-words">
          {course.description ||
            "Add a description to capture the essentials of this course."}
        </p>
      </section>
      <section className="panel mb-6">
        <div className="flex justify-between items-center gap-3">
          <h2>Assignments</h2>
          <EntityForm kind="assignment" courseId={id} />
        </div>
        {course.assignments.length ? (
          course.assignments.map((a) => (
            <article key={a.id} className="py-5 border-b last:border-0">
              <div className="flex justify-between gap-3 flex-wrap">
                <div>
                  <h3
                    className={`font-semibold ${a.status === "COMPLETED" ? "line-through muted" : ""}`}
                  >
                    {a.title}
                  </h3>
                  <p className="text-sm muted mt-1">
                    {formatDate(a.dueDate, timezone)} · {a.estimatedHours} hours
                    · {a.priority.toLowerCase()} priority
                  </p>
                  <p className="text-sm text-primary mt-1">
                    {a.status.replaceAll("_", " ")}
                    {a.status !== "COMPLETED" &&
                      ` · ${a.dueDate < new Date() ? "Overdue" : countdown(a.dueDate, timezone)}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 items-start">
                  <CompleteAssignment
                    id={a.id}
                    completed={a.status === "COMPLETED"}
                  />
                  <EntityForm
                    kind="assignment"
                    initial={{
                      id: a.id,
                      title: a.title,
                      description: a.description,
                      dueDate: a.dueDate.toISOString(),
                      status: a.status,
                      priority: a.priority,
                      estimatedHours: a.estimatedHours,
                    }}
                  />
                  <DeleteItem kind="assignment" id={a.id} />
                </div>
              </div>
              {a.description && (
                <p className="text-sm muted mt-3 whitespace-pre-wrap">
                  {a.description}
                </p>
              )}
            </article>
          ))
        ) : (
          <EmptyState
            title="No assignments yet"
            description="Add a deadline and an estimate to keep your workload visible."
          />
        )}
      </section>
      <section className="panel mb-6">
        <div className="flex justify-between items-center gap-3">
          <h2>Exams</h2>
          <EntityForm kind="exam" courseId={id} />
        </div>
        {course.exams.length ? (
          course.exams.map((e) => (
            <article key={e.id} className="py-5 border-b last:border-0">
              <div className="flex justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="font-semibold">{e.title}</h3>
                  <p className="text-sm muted mt-1">
                    {formatDate(e.examDate, timezone)}
                  </p>
                  <p className="text-sm text-primary mt-1">
                    {countdown(e.examDate, timezone)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <EntityForm
                    kind="exam"
                    initial={{
                      id: e.id,
                      title: e.title,
                      examDate: e.examDate.toISOString(),
                      topics: e.topics,
                      notes: e.notes,
                    }}
                  />
                  <DeleteItem kind="exam" id={e.id} />
                </div>
              </div>
              {!!e.topics.length && (
                <p className="text-sm mt-3">Topics: {e.topics.join(" · ")}</p>
              )}
              {e.notes && (
                <p className="text-sm muted mt-3 whitespace-pre-wrap">
                  {e.notes}
                </p>
              )}
            </article>
          ))
        ) : (
          <EmptyState
            title="No exams yet"
            description="Add your exam date and the topics you want to prepare."
          />
        )}
      </section>
      <div className="grid md:grid-cols-2 gap-6">
        <section className="panel">
          <DocumentLibrary
            courses={[course]}
            courseId={id}
            initial={documents.map((d) => ({
              ...d,
              createdAt: d.createdAt.toISOString(),
              updatedAt: d.updatedAt.toISOString(),
            }))}
          />
        </section>
        <section className="panel">
          <h2>Progress</h2>
          <EmptyState
            title="Learning progress is coming later"
            description="Topic mastery and practice results will appear here once learning tools are available."
          />
        </section>
      </div>
    </>
  );
}
