import { headers } from "next/headers";
import { requirePageUser } from "@/server/auth/session";
import { getAssistantBootstrap, getAssistantConversation } from "@/server/assistant";
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

function many(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= 120))].slice(0, 10);
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
  const conversationId = one(query.conversationId);
  const projectId = one(query.projectId);
  const targetRole = typeof query.targetRole === "string" && query.targetRole.trim().length <= 160 ? query.targetRole.trim() : undefined;
  const targetIndustry = typeof query.targetIndustry === "string" && query.targetIndustry.trim().length <= 120 ? query.targetIndustry.trim() : undefined;
  const applicationTimeline = typeof query.applicationTimeline === "string" && query.applicationTimeline.trim().length <= 100 ? query.applicationTimeline.trim() : undefined;
  const targetCompanies = many(query.targetCompanies);
  const initialLaunch: AssistantLaunch | undefined = prompt ? {
    request: prompt,
    ...(one(query.courseId) ? { courseId: one(query.courseId) } : {}),
    ...(documentId ? { documentIds: [documentId] } : {}),
    ...(one(query.assignmentId) ? { assignmentId: one(query.assignmentId) } : {}),
    ...(one(query.examId) ? { examId: one(query.examId) } : {}),
    ...(one(query.topicId) ? { topicId: one(query.topicId) } : {}),
    ...(typeof query.topicName === "string" && query.topicName.trim().length <= 200 ? { topicName: query.topicName.trim() } : {}),
    ...(one(query.studyPlanId) ? { studyPlanId: one(query.studyPlanId) } : {}),
    ...(projectId ? { projectIds: [projectId] } : {}),
    ...(targetRole ? { targetRole } : {}),
    ...(targetIndustry ? { targetIndustry } : {}),
    ...(applicationTimeline ? { applicationTimeline } : {}),
    ...(targetCompanies.length ? { targetCompanies } : {}),
    ...(agent && agentIds.has(agent as Exclude<AssistantAgentId, "auto">) ? { preferredAgentId: agent as Exclude<AssistantAgentId, "auto"> } : {}),
    ...(workflow && workflowIds.has(workflow) ? { preferredWorkflowId: workflow } : {}),
  } : undefined;
  const requestHeaders = await headers();
  const [bootstrap, initialConversation] = await Promise.all([
    getAssistantBootstrap(user.id),
    conversationId
      ? getAssistantConversation(conversationId, requestHeaders).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  return <AssistantWorkspace initial={bootstrap} initialLaunch={initialLaunch} initialConversation={initialConversation} />;
}
