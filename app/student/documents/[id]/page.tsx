import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/session";
import { NotFoundError } from "@/server/services/academic";
import { getDocument } from "@/server/documents/service";
import { DocumentDetail } from "@/features/documents/components/detail";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user } = await requirePageUser();
  const document = await getDocument(user.id, (await params).id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  return (
    <DocumentDetail
      initial={{
        ...document,
        createdAt: document.createdAt.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
      }}
    />
  );
}
