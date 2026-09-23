import { headers } from "next/headers";
import { requirePageUser } from "@/server/auth/session";
import { getCourseCards } from "@/server/course-workspace";
import { EntityForm } from "@/features/student/components/entity-form";
import { EmptyState } from "@/features/student/components/empty-state";
import { CourseList } from "@/features/student/courses/course-list";
export default async function Courses() {
  const { user, profile } = await requirePageUser();
  const courses = await getCourseCards(user.id, await headers());
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
        <CourseList courses={courses} />
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
