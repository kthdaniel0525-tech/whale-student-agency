import type { z } from "zod";

export const BACKGROUND_JOB_PRIORITIES = {
  low: -10,
  normal: 0,
  high: 10,
} as const;

export type BackgroundJobPriority = keyof typeof BACKGROUND_JOB_PRIORITIES;

export interface BackgroundJobRetryPolicy {
  readonly limit: number;
  readonly delaySeconds: number;
  readonly maximumDelaySeconds: number;
  readonly exponentialBackoff: boolean;
}

export interface BackgroundJobContext<Payload> {
  readonly payload: Payload;
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly jobRunId: string;
}

export type BackgroundJobResult = Readonly<Record<
  string,
  string | number | boolean | null
>>;

export interface BackgroundJob<Payload extends object> {
  readonly name: string;
  readonly version: number;
  readonly payloadSchema: z.ZodType<Payload>;
  readonly retryPolicy: BackgroundJobRetryPolicy;
  readonly timeoutSeconds: number;
  readonly priority: BackgroundJobPriority;
  readonly executionScope: "user" | "system";
  readonly concurrency: {
    readonly scope: "user" | "global";
    readonly limit: number;
  };
  readonly debounceSeconds: number;
  readonly handler: (
    context: BackgroundJobContext<Payload>,
  ) => Promise<BackgroundJobResult>;
}

export interface JobRunReference {
  readonly id: string;
  readonly queueJobId: string;
  readonly status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  readonly deduplicated: boolean;
}

export const DOMAIN_BACKGROUND_EVENTS = [
  "QUIZ_COMPLETED",
  "ASSIGNMENT_UPDATED",
  "EXAM_UPDATED",
  "STUDY_TASK_COMPLETED",
  "STUDY_TASK_SCHEDULED",
  "STUDY_TASK_UPDATED",
  "STUDY_PLAN_UPDATED",
  "DOCUMENT_READY",
  "LEARNING_PROGRESS_UPDATED",
  "WORKFLOW_WAITING_FOR_INPUT",
  "WORKFLOW_COMPLETED",
] as const;

export type DomainBackgroundEventName =
  (typeof DOMAIN_BACKGROUND_EVENTS)[number];
