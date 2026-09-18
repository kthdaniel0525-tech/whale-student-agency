import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/session";
import { NotFoundError } from "@/server/services/academic";
import { getDocument } from "@/server/documents/service";
import { DocumentDetail } from "@/features/documents/components/detail";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { user } = await requirePageUser();
  const document = await getDocument(user.id, (await params).id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const requestedPage = Number((await searchParams).page ?? 1);
  const initialPage = Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 200
    ? requestedPage
    : 1;
  return (
    <DocumentDetail
      initialPage={initialPage}
      initial={{
        ...document,
        createdAt: document.createdAt.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
      }}
    />
  );
}
