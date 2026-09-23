import { requirePageUser } from "@/server/auth/session";
import { listCourses } from "@/server/services/academic";
import { listDocuments } from "@/server/documents/service";
import { DocumentLibrary } from "@/features/documents/components/library";
export default async function Documents() {
  const { user } = await requirePageUser();
  const [courses, documents] = await Promise.all([
    listCourses(user.id),
    listDocuments(user.id),
  ]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR KNOWLEDGE LIBRARY</p>
          <h1 className="mt-2">Documents</h1>
          <p>Keep course materials private, organized and searchable.</p>
        </div>
      </div>
      <DocumentLibrary
        courses={courses}
        initial={documents.map((d) => ({
          ...d,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        }))}
      />
    </>
  );
}
