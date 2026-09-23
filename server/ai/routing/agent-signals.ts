import type { UserContext } from "../../context/types";
import type { AdaptiveStrategy } from "../../adaptive";
import { requestSignals } from "./complexity";
import type { ModelRoutingHints } from "./types";

/** Consumes the already-owned, filtered Context Builder result. No extra academic,
 * learning, memory, or document queries are introduced for model selection. */
export function agentRoutingHints(agentId: string, request: string, context: UserContext, adaptive: AdaptiveStrategy): ModelRoutingHints {
  const signals = requestSignals(request);
  const planning = agentId === "study-planner" || agentId === "academic-manager";
  const assignments = (context.assignments ?? []).filter(a => a.status !== "COMPLETED");
  const exams = context.exams ?? [];
  const deadlines = assignments.length + exams.length;
  return { signals: {
    ...signals, planning,
    sourceCount: new Set((context.documents ?? []).map(d => d.documentId)).size,
    ragChunkCount: context.documents?.length ?? 0,
    courseCount: Math.max(new Set([...assignments, ...exams].map(d => d.course.id)).size, context.academicOverview?.totalActiveCourses ?? 0),
    deadlineCount: Math.max(deadlines, (context.academicOverview?.assignmentsDueNext7Days ?? 0) + (context.academicOverview?.examsNext14Days ?? 0)),
    // A bounded availability summary can expose days with no room for study.
    calendarConflicts: planning && deadlines > 1 && !!context.availability?.days.some(day => day.availableMinutes === 0),
    repeatedMisunderstanding: signals.repeatedMisunderstanding || adaptive.retryStrategy === "switch-approach" || adaptive.feedbackStyle === "deep-remediation",
  } };
}
