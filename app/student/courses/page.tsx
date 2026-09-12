import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { requirePageUser } from "@/server/auth/session";
import { listCourses } from "@/server/services/academic";
import { EntityForm } from "@/features/student/components/entity-form";
import { EmptyState } from "@/features/student/components/empty-state";
export default async function Courses() {
  const { user, profile } = await requirePageUser();
  const courses = await listCourses(user.id);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR SEMESTER</p>
          <h1 className="mt-2">Courses</h1>
          <p>A dedicated space for every subject.</p>
        </div>
        <EntityForm kind="course" semester={profile!.semester} />
      </div>
      {courses.length ? (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">
          {courses.map((course) => (
            <Link
              key={course.id}
              href={`/student/courses/${course.id}`}
              className="course-link"
            >
              <div className="flex justify-between">
                <span className="eyebrow">{course.courseCode}</span>
                <ArrowUpRight size={18} className="muted" />
              </div>
              <h2 className="font-semibold text-xl mt-4">
                {course.courseName}
              </h2>
              <p className="muted text-sm mt-2">
                {course.professor || "No professor added"} · {course.semester}
              </p>
              <p className="muted text-sm mt-6">
                {course._count.assignments} open assignments ·{" "}
                {course._count.exams} exams
              </p>
            </Link>
          ))}
        </div>
      ) : (
        <section className="panel">
          <EmptyState
            title="Every semester starts somewhere"
            description="Add your first course to organize assignments and exams."
          />
        </section>
      )}
    </>
  );
}
