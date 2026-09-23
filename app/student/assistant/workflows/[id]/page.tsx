import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/session";
import { getAssistantBootstrap, getAssistantWorkflowMessage } from "@/server/assistant";
import { AssistantWorkspace } from "@/features/student/assistant/workspace";
export default async function WorkflowResumePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requirePageUser();
  const { id } = await params;
  const message = await getAssistantWorkflowMessage(id, await headers()).catch((error) => {
    if (error instanceof Error && "code" in error && ["RUN_NOT_FOUND", "NOT_FOUND", "REFERENCE_NOT_FOUND"].includes(String(error.code))) notFound();
    throw error;
  });
  return <AssistantWorkspace initial={await getAssistantBootstrap(user.id)} initialWorkflow={message} />;
}
