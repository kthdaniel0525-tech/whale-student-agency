import "server-only";
import type {
  AssistantAction,
  AssistantSource,
  AssistantWorkflow,
} from "@/features/student/assistant/types";

const agentTargets = new Set([
  "tutor",
  "notes",
  "quiz",
  "study-planner",
  "academic-manager",
  "career",
]);

type ActionContext = {
  courseId?: string;
  documentIds?: string[];
  assignmentId?: string;
  examId?: string;
  topicId?: string;
  topicName?: string;
  studyPlanId?: string;
  projectIds?: string[];
  targetRole?: string;
  targetIndustry?: string;
  targetCompanies?: string[];
  applicationTimeline?: string;
  availableWeeklyMinutes?: number;
};

function action(
  id: string,
  label: string,
  targetId: string,
  prompt: string,
  context?: ActionContext,
  style: AssistantAction["style"] = "secondary",
): AssistantAction {
  return {
    id,
    label,
    targetType: "agent",
    targetId,
    prompt,
    ...(context && Object.keys(context).length ? { payload: context } : {}),
    style,
  };
}

/** Builds bounded, deterministic UI actions from domain results. No model call
 * is used to turn structured output into buttons. */
export function buildAgentActions(
  targetId: string,
  structuredData?: unknown,
  context?: ActionContext,
): AssistantAction[] {
  if (targetId === "tutor") {
    return [
      action("tutor-simpler", "Explain more simply", "tutor", "Explain the previous answer more simply, using plain language.", context),
      action("tutor-example", "Another example", "tutor", "Give me another example of the concept from your previous answer.", context),
      action("tutor-check", "Test my understanding", "quiz", "Give me one quick question to test my understanding of the concept we just discussed.", context, "primary"),
      action("tutor-harder", "Make it harder", "tutor", "Build on the previous explanation with a more challenging example.", context, "quiet"),
      action("tutor-formal", "Formal version", "tutor", "Show the formal academic version of the previous explanation.", context, "quiet"),
    ];
  }
  if (targetId === "notes") {
    return [
      action("notes-shorter", "Make shorter", "notes", "Condense the previous notes into a short review sheet.", context),
      action("notes-detail", "Add detail", "notes", "Expand the previous notes with more detail and important steps.", context),
      action("notes-quiz", "Turn into quiz", "quiz", "Create a quiz from the notes you just prepared.", context, "primary"),
      action("notes-explain", "Explain a concept", "tutor", "Explain the most important concept from the previous notes.", context),
      action("notes-exam", "Create exam review", "notes", "Turn the previous notes into a focused exam review.", context, "quiet"),
    ];
  }
  if (targetId === "academic-manager" && structuredData && typeof structuredData === "object") {
    const value = structuredData as { recommendedActions?: unknown };
    if (!Array.isArray(value.recommendedActions)) return [];
    return value.recommendedActions.slice(0, 4).flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const target = typeof record.agentId === "string" && agentTargets.has(record.agentId)
        ? record.agentId
        : null;
      const label = typeof record.action === "string" ? record.action : null;
      if (!target || !label) return [];
      const reason = typeof record.reason === "string" ? record.reason : "";
      const courseId = typeof record.courseId === "string" ? record.courseId : context?.courseId;
      return [action(
        `manager-${index}-${target}`,
        label,
        target,
        `${label}${reason ? `. ${reason}` : ""}`,
        { ...context, ...(courseId ? { courseId } : {}) },
        index === 0 ? "primary" : "secondary",
      )];
    });
  }
  if (targetId === "career") {
    return [
      action("career-resume", "Improve resume", "career", "Help me improve my resume using only the evidence I provided.", context, "primary"),
      action("career-project", "Review a project", "career", "Review one of my projects and suggest the highest-impact improvements.", context),
      action("career-plan", "Build career plan", "career", "Create a practical career preparation plan from the gaps and next actions above.", context),
    ];
  }
  if (targetId === "study-planner") {
    return [action("plan-update", "Update plan", "study-planner", "Update this study plan using my current progress while preserving completed work.", context)];
  }
  return [];
}

export function buildWorkflowActions(
  workflow: AssistantWorkflow,
  context?: ActionContext,
): AssistantAction[] {
  if (workflow.status !== "completed") return [];
  const next: Record<string, AssistantAction> = {
    "exam-preparation": action("workflow-exam-plan", "Review study plan", "study-planner", "Show me the current exam study plan and what I should do next.", context, "primary"),
    "weak-topic-recovery": action("workflow-recovery-review", "Review the topic", "tutor", "Review the recovered topic and explain any remaining gaps.", context, "primary"),
    "lecture-study": action("workflow-lecture-quiz", "Try another quiz", "quiz", "Create another quiz from this lecture at an appropriate difficulty.", context, "primary"),
    "assignment-support": action("workflow-assignment-review", "Review revision", "tutor", "Review my revised assignment work and explain what to improve next.", context, "primary"),
    "career-preparation": action("workflow-career-next", "Continue career plan", "career", "Use the completed career preparation results to plan my next concrete step.", context, "primary"),
  };
  return next[workflow.workflowId] ? [next[workflow.workflowId]] : [];
}

export function serializeSources(sources: readonly AssistantSource[] | undefined) {
  if (!sources?.length) return undefined;
  return JSON.stringify(sources.slice(0, 12));
}

export function parseSources(value: unknown): AssistantSource[] {
  if (typeof value !== "string" || value.length > 20_000) return [];
  try {
    const items = JSON.parse(value) as unknown;
    if (!Array.isArray(items)) return [];
    return items.slice(0, 12).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const source = item as Record<string, unknown>;
      if (
        typeof source.documentId !== "string" ||
        typeof source.documentTitle !== "string" ||
        typeof source.chunkIndex !== "number"
      ) return [];
      return [{
        documentId: source.documentId,
        documentTitle: source.documentTitle,
        chunkIndex: source.chunkIndex,
        ...(typeof source.pageNumber === "number" || source.pageNumber === null ? { pageNumber: source.pageNumber as number | null } : {}),
        ...(typeof source.pageEnd === "number" || source.pageEnd === null ? { pageEnd: source.pageEnd as number | null } : {}),
        ...(typeof source.courseCode === "string" || source.courseCode === null ? { courseCode: source.courseCode as string | null } : {}),
      }];
    });
  } catch {
    return [];
  }
}

/** Non-canonical structured results may be stored once with the conversation so
 * their rich rendering survives reload. Quiz and Study Plan data use IDs. */
export function serializeStructuredPresentation(targetId: string, value: unknown) {
  if (value === undefined || targetId === "quiz" || targetId === "study-planner") return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= 24_000 ? serialized : undefined;
  } catch {
    return undefined;
  }
}

export function parseStructuredPresentation(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 24_000) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
