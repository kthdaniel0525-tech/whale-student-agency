import { requirePageUser } from "@/server/auth/session";
import { listCourses } from "@/server/services/academic";
import { getDocument, listDocuments } from "@/server/documents/service";
import { RagPlayground } from "@/features/documents/components/playground";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ documentId?: string }>;
}) {
  const { user } = await requirePageUser();
  const { documentId } = await searchParams;
  if (documentId) await getDocument(user.id, documentId);
  const [courses, documents] = await Promise.all([
    listCourses(user.id),
    listDocuments(user.id),
  ]);
  return (
    <RagPlayground
      courses={courses}
      documentId={documentId}
      documents={documents.map((d) => ({
        ...d,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      }))}
    />
  );
}
