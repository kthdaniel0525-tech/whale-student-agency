import { z } from "zod";

export const AGENTS = ["tutor", "notes", "quiz", "study-planner", "academic-manager", "career"] as const;
export const WORKFLOWS = ["exam-preparation", "weak-topic-recovery", "lecture-study", "assignment-support", "career-preparation"] as const;
export const FEATURES = ["dashboard", "course-workspace", "documents", "assistant", "progress", "career", "integrations", "billing", "onboarding", "study-plan", "workflow", "feedback"] as const;
export const PAGES = ["dashboard", "courses", "course-workspace", "assistant", "documents", "progress", "career", "settings", "study-plan", "plans", "onboarding", "other"] as const;
export const EVENTS = [
  "signup_completed", "onboarding_completed", "course_created", "assignment_created", "exam_created", "document_uploaded", "document_ready",
  "ai_request_sent", "ai_request_completed", "agent_used", "workflow_started", "workflow_step_completed", "workflow_waiting", "workflow_completed", "workflow_failed",
  "quiz_started", "quiz_completed", "study_plan_created", "study_task_completed", "career_task_completed",
  "recommendation_shown", "recommendation_clicked", "recommendation_dismissed", "recommended_action_completed",
  "next_best_action_clicked", "study_now_clicked", "upcoming_deadline_opened", "course_opened", "assignment_support_started", "exam_preparation_started", "document_study_started", "weak_topic_recovery_started",
  "progress_page_viewed", "weak_topic_action_clicked", "exam_readiness_action_clicked", "career_profile_created", "project_added", "resume_improvement_used", "career_plan_created",
  "integration_connect_started", "integration_connected", "integration_failed", "integration_disconnected", "calendar_sync_success", "drive_import_success",
  "plans_viewed", "checkout_started", "checkout_completed", "subscription_started", "subscription_cancelled", "feature_failed", "ai_feedback_submitted", "product_feedback_submitted", "beta_survey_submitted",
] as const;
export type ProductEventName = typeof EVENTS[number];
const ref = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const fields = {
  agentId: z.enum(AGENTS), workflowId: z.enum(WORKFLOWS), feature: z.enum(FEATURES), page: z.enum(PAGES),
  provider: z.enum(["google", "canvas", "moodle", "blackboard"]),
  requestId: z.string().uuid(), step: z.number().int().min(0).max(8),
  recommendationKey: z.string().regex(/^[a-f0-9]{64}$/),
  success: z.boolean(), rating: z.union([z.literal(-1), z.literal(1)]),
  errorCode: z.enum(["UNAVAILABLE", "RATE_LIMIT", "TIMEOUT", "INVALID_REQUEST", "ACCESS_DENIED"]),
};
// Event-specific allowlists: arbitrary strings/objects and resource titles are forbidden.
const allowed: Partial<Record<ProductEventName, (keyof typeof fields)[]>> = {
  ai_request_sent: ["requestId"], ai_request_completed: ["requestId", "agentId"], agent_used: ["agentId", "requestId", "success"],
  workflow_started: ["workflowId"], workflow_step_completed: ["workflowId", "step"], workflow_waiting: ["workflowId", "step"], workflow_completed: ["workflowId"], workflow_failed: ["workflowId"],
  recommendation_shown: ["page", "recommendationKey"], recommendation_clicked: ["page", "recommendationKey"],
  recommendation_dismissed: ["recommendationKey"], recommended_action_completed: ["recommendationKey"],
  ai_feedback_submitted: ["agentId", "workflowId", "requestId", "rating"],
  product_feedback_submitted: ["feature"], feature_failed: ["feature", "errorCode", "requestId"],
  integration_connect_started: ["provider"], integration_connected: ["provider"], integration_failed: ["provider"], integration_disconnected: ["provider"],
};
export function parseEvent(event: unknown, properties: unknown = {}) {
  const name = z.enum(EVENTS).parse(event);
  return { name, properties: z.object(Object.fromEntries((allowed[name] ?? []).map(key => [key, fields[key].optional()]))).strict().parse(properties) };
}
export const CLIENT_EVENTS = ["recommendation_shown", "next_best_action_clicked", "study_now_clicked", "upcoming_deadline_opened", "course_opened", "assignment_support_started", "exam_preparation_started", "document_study_started", "weak_topic_recovery_started", "progress_page_viewed", "weak_topic_action_clicked", "exam_readiness_action_clicked", "plans_viewed"] as const;
export const clientEventSchema = z.object({ event: z.enum(CLIENT_EVENTS), eventId: z.string().uuid(), page: z.enum(PAGES).optional(), recommendationId: ref.optional() }).strict();
export type ClientEvent = z.infer<typeof clientEventSchema>;
export const DEFAULT_MEANINGFUL_EVENTS: ProductEventName[] = ["ai_request_completed", "quiz_completed", "study_task_completed", "workflow_completed", "career_task_completed", "course_created", "assignment_created", "exam_created", "document_uploaded"];
