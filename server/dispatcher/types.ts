import type { StudentAgentId } from "../agents/types";
import type { AgentRequestResult } from "../agents/core/types";
import type { StudyAvailability } from "../agents/study-planner/types";
import type { LectureDifficulty, LectureStudyMode } from "../workflows/lecture-policy";
import type { WorkflowId, WorkflowResult } from "../workflows/types";
import type { RequestExecutionMetrics } from "../observability/request-metrics";

export type DispatchMethod = "explicit" | "rule" | "intent" | "llm-fallback" | "default";
export type DispatchTargetDecision =
  | { targetType: "agent"; targetId: StudentAgentId; confidence: number; method: DispatchMethod; reason?: string }
  | { targetType: "workflow"; targetId: WorkflowId; confidence: number; method: DispatchMethod; reason?: string };
export type DispatchClarification = {
  needsClarification: true;
  confidence: number;
  method: DispatchMethod;
  reason: string;
  clarificationQuestion: string;
  suggestedTarget?: { targetType: "agent" | "workflow"; targetId: StudentAgentId | WorkflowId };
};
export type DispatchDecision = DispatchTargetDecision | DispatchClarification;

export type DispatcherInput = {
  request: string;
  /** Optional owned conversation used by the unified workspace. */
  conversationId?: string;
  /** Client-generated idempotency key for the visible conversation turn. */
  turnId?: string;
  courseId?: string;
  examId?: string;
  assignmentId?: string;
  documentId?: string;
  documentIds?: string[];
  topicId?: string;
  topicName?: string;
  projectIds?: string[];
  preferredAgentId?: string;
  preferredWorkflowId?: string;
  studyPlanId?: string;
  quizId?: string;
  availability?: StudyAvailability[];
  userWork?: string;
  specificQuestion?: string;
  review?: boolean;
  topicFocus?: string;
  difficulty?: LectureDifficulty;
  mode?: LectureStudyMode;
  availableMinutes?: number;
  targetRole?: string;
  targetIndustry?: string;
  targetCompanies?: string[];
  applicationTimeline?: string;
  resumeData?: string;
  availableWeeklyMinutes?: number;
  availableWeeklyHours?: number;
};

export type UnifiedAIResult =
  | {
      needsClarification: false;
      mode: "agent";
      target: { id: StudentAgentId; name: string };
      dispatch: Pick<DispatchTargetDecision, "confidence" | "method" | "reason">;
      result: AgentRequestResult;
      metrics: RequestExecutionMetrics;
    }
  | {
      needsClarification: false;
      mode: "workflow";
      target: { id: WorkflowId; name: string };
      dispatch: Pick<DispatchTargetDecision, "confidence" | "method" | "reason">;
      result: WorkflowResult;
      metrics: RequestExecutionMetrics;
    }
  | (DispatchClarification & { metrics: RequestExecutionMetrics });
