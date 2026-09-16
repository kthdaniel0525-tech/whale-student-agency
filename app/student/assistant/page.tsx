import { requirePageUser } from "@/server/auth/session";
import { getAssistantBootstrap } from "@/server/assistant";
import { AssistantWorkspace } from "@/features/student/assistant/workspace";
import type { AssistantAgentId, AssistantLaunch } from "@/features/student/assistant/types";

const agentIds = new Set<Exclude<AssistantAgentId, "auto">>([
  "tutor", "notes", "quiz", "study-planner", "academic-manager", "career",
]);
const workflowIds = new Set([
  "exam-preparation", "weak-topic-recovery", "lecture-study",
  "assignment-support", "career-preparation",
]);

function one(value: string | string[] | undefined) {
  return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : undefined;
}

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requirePageUser();
  const query = await searchParams;
  const prompt = typeof query.prompt === "string" && query.prompt.trim().length <= 1000
    ? query.prompt.trim()
    : "";
  const agent = one(query.agent);
  const workflow = one(query.workflow);
  const documentId = one(query.documentId);
  const initialLaunch: AssistantLaunch | undefined = prompt ? {
    request: prompt,
    ...(one(query.courseId) ? { courseId: one(query.courseId) } : {}),
    ...(documentId ? { documentIds: [documentId] } : {}),
    ...(one(query.assignmentId) ? { assignmentId: one(query.assignmentId) } : {}),
    ...(one(query.examId) ? { examId: one(query.examId) } : {}),
    ...(one(query.topicId) ? { topicId: one(query.topicId) } : {}),
    ...(typeof query.topicName === "string" && query.topicName.trim().length <= 200 ? { topicName: query.topicName.trim() } : {}),
    ...(one(query.studyPlanId) ? { studyPlanId: one(query.studyPlanId) } : {}),
    ...(agent && agentIds.has(agent as Exclude<AssistantAgentId, "auto">) ? { preferredAgentId: agent as Exclude<AssistantAgentId, "auto"> } : {}),
    ...(workflow && workflowIds.has(workflow) ? { preferredWorkflowId: workflow } : {}),
  } : undefined;
  return <AssistantWorkspace initial={await getAssistantBootstrap(user.id)} initialLaunch={initialLaunch} />;
}
