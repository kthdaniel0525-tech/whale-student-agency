import "server-only";
import { recordMemoryObservation } from "./service";

export async function observeStudyTaskOutcome(input: {
  userId: string;
  taskId: string;
  durationMinutes: number;
  status: "completed" | "skipped";
}) {
  if (input.status === "completed") {
    return recordMemoryObservation({
      userId: input.userId,
      category: "preference",
      key: "studySessionMinutes",
      observedValue: Math.max(15, Math.min(180, Math.round(input.durationMinutes / 15) * 15)),
      source: "Repeated completed study sessions",
      evidenceKey: `study-task:${input.taskId}:completed`,
      evidenceType: "behavior",
      importance: 65,
    });
  }
  return recordMemoryObservation({
    userId: input.userId,
    category: "learning-pattern",
    key: "skipped-session-length",
    observedValue: `${Math.max(15, Math.min(180, Math.round(input.durationMinutes / 15) * 15))}-minute sessions were skipped`,
    source: "Repeated skipped study sessions",
    evidenceKey: `study-task:${input.taskId}:skipped`,
    evidenceType: "behavior",
    importance: 45,
  });
}

export async function observeWorkflowOutcome(input: {
  userId: string;
  runId: string;
  workflowId: string;
  improvement?: number;
  quizPercentage?: number;
}) {
  if (input.workflowId === "weak-topic-recovery" && (input.improvement ?? 0) >= 10) {
    return recordMemoryObservation({
      userId: input.userId,
      category: "successful-strategy",
      key: "weak-topic-recovery",
      observedValue: "Targeted explanation followed by a focused practice quiz",
      source: "Repeated successful weak-topic recovery workflows",
      evidenceKey: `workflow:${input.runId}`,
      evidenceType: "outcome",
      sourceType: "system-derived",
      importance: 80,
    });
  }
  if (input.workflowId === "lecture-study" && (input.quizPercentage ?? 0) >= 70) {
    return recordMemoryObservation({
      userId: input.userId,
      category: "successful-strategy",
      key: "lecture-study-cycle",
      observedValue: "Structured notes, targeted explanation, then a practice quiz",
      source: "Repeated successful lecture study workflows",
      evidenceKey: `workflow:${input.runId}`,
      evidenceType: "outcome",
      sourceType: "system-derived",
      importance: 75,
    });
  }
  return undefined;
}

