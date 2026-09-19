import "server-only";
import { normalizeTopicName } from "../learning/normalization";
import { calendarDayDifference, isUtcDateOnly } from "../time/local";
import { REMINDER_CONFIG } from "./config";
import type {
  RankedReminderCandidate,
  ReminderCandidate,
  ReminderDetectionInput,
  ReminderPriority,
  ReminderPrioritySignals,
} from "./types";

const HOUR = 3_600_000;
const DAY = 86_400_000;

function bounded(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function deadlineUrgency(days: number): number {
  if (days < 0) return Math.min(50, 40 + Math.abs(days));
  if (days === 0) return 46;
  if (days === 1) return 40;
  if (days <= 3) return 30;
  if (days <= 7) return 20;
  return 12;
}

function deadlineWindow(days: number, windows: readonly number[]): number | null {
  if (days < 0) return null;
  return [...windows].reverse().find((window) => days <= window) ?? null;
}

function overdueBucket(days: number): string {
  if (days >= -1) return "one-day";
  if (days >= -3) return "three-days";
  if (days >= -7) return "one-week";
  return "persistent";
}

function assignmentCandidates(input: ReminderDetectionInput): ReminderCandidate[] {
  return input.assignments.flatMap<ReminderCandidate>((assignment) => {
    if (assignment.status === "COMPLETED") return [];
    const days = calendarDayDifference(assignment.dueDate, input.now, input.timezone);
    const sourcePriority = assignment.priority === "HIGH" ? 22
      : assignment.priority === "MEDIUM" ? 13 : 6;
    const impact = Math.min(18, Math.round(assignment.estimatedHours * 4));
    if (days < 0) {
      if (days < -REMINDER_CONFIG.historicalOverdueDays) return [];
      const bucket = overdueBucket(days);
      return [{
        type: "assignment-overdue" as const,
        title: `${assignment.courseCode} assignment is overdue`,
        message: `${assignment.courseCode} ${assignment.title} is overdue and remains ${assignment.status === "TODO" ? "not started" : "in progress"}.`,
        sourceType: "assignment" as const,
        sourceId: assignment.id,
        scheduledFor: input.now,
        prioritySignals: {
          urgency: deadlineUrgency(days), academicImpact: impact,
          sourcePriority, missedWork: assignment.priority === "HIGH" ? 18 : 10,
        },
        reasonCode: "ASSIGNMENT_OVERDUE",
        reasonData: { daysOverdue: Math.abs(days), priority: assignment.priority.toLowerCase(), estimatedHours: assignment.estimatedHours },
        actionTargetType: "workflow" as const,
        actionTargetId: "assignment-support",
        actionPayload: { assignmentId: assignment.id, courseId: assignment.courseId },
        dedupeKey: `assignment-overdue:${assignment.id}:${bucket}`,
        supersessionKey: `assignment:${assignment.id}`,
        stateFingerprint: `overdue:${bucket}:${assignment.status}:${assignment.priority}`,
      }];
    }
    const window = deadlineWindow(days, REMINDER_CONFIG.assignmentWindowsDays);
    if (window === null) return [];
    if (window === 7 && (assignment.priority !== "HIGH" || assignment.estimatedHours < 2)) return [];
    if (window === 3 && assignment.priority === "LOW" && assignment.estimatedHours < 3) return [];
    return [{
      type: "assignment-due" as const,
      title: `${assignment.courseCode} assignment due ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}`,
      message: `${assignment.courseCode} ${assignment.title} is due ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}.`,
      sourceType: "assignment" as const,
      sourceId: assignment.id,
      scheduledFor: input.now,
      expiresAt: new Date(assignment.dueDate.getTime() + DAY),
      prioritySignals: { urgency: deadlineUrgency(days), academicImpact: impact, sourcePriority },
      reasonCode: days === 0 ? "ASSIGNMENT_DUE_TODAY" : days === 1 ? "ASSIGNMENT_DUE_TOMORROW" : "ASSIGNMENT_DUE_SOON",
      reasonData: { daysRemaining: days, priority: assignment.priority.toLowerCase(), estimatedHours: assignment.estimatedHours },
      actionTargetType: "workflow" as const,
      actionTargetId: "assignment-support",
      actionPayload: { assignmentId: assignment.id, courseId: assignment.courseId },
      dedupeKey: `assignment-due:${assignment.id}:${window}`,
      supersessionKey: `assignment:${assignment.id}`,
      stateFingerprint: `due:${window}:${assignment.status}:${assignment.priority}`,
    }];
  });
}

function examCandidates(input: ReminderDetectionInput): ReminderCandidate[] {
  const result: ReminderCandidate[] = [];
  for (const exam of input.exams) {
    const days = calendarDayDifference(exam.examDate, input.now, input.timezone);
    const window = deadlineWindow(days, REMINDER_CONFIG.examWindowsDays);
    if (window === null) continue;
    const related = new Set(exam.topics.map(normalizeTopicName));
    const topics = input.topics
      .filter((topic) => topic.courseId === exam.courseId && related.has(topic.normalizedName))
      .sort((a, b) => {
        const riskA = 100 - a.mastery + a.confidence / 5;
        const riskB = 100 - b.mastery + b.confidence / 5;
        return riskB - riskA || a.id.localeCompare(b.id);
      });
    const weak = topics.find((topic) => topic.mastery <= 59 && topic.confidence >= 60);
    const diagnostic = topics.find((topic) => topic.mastery <= 69 && topic.confidence <= 44);
    const concern = weak ?? diagnostic;
    const message = `${exam.courseCode} ${exam.title} is ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}.${concern ? ` ${concern.name} is the highest-priority remaining concern.` : ""}`;
    result.push({
      type: days === 1 ? "exam-tomorrow" : "exam-upcoming",
      title: `${exam.courseCode} ${exam.title} ${days === 0 ? "is today" : days === 1 ? "is tomorrow" : `is in ${days} days`}`,
      message,
      sourceType: "exam",
      sourceId: exam.id,
      scheduledFor: input.now,
      expiresAt: new Date(exam.examDate.getTime() + DAY),
      prioritySignals: {
        urgency: deadlineUrgency(days), academicImpact: 30,
        readiness: weak ? 14 : diagnostic ? 8 : 0,
        weakness: weak ? Math.min(12, Math.round((60 - weak.mastery) / 3)) : 0,
      },
      reasonCode: days === 0 ? "EXAM_TODAY" : days === 1 ? "EXAM_TOMORROW" : "EXAM_APPROACHING",
      reasonData: { daysRemaining: days, ...(concern ? { topic: concern.name, mastery: Math.round(concern.mastery), confidence: Math.round(concern.confidence) } : {}) },
      actionTargetType: "workflow",
      actionTargetId: "exam-preparation",
      actionPayload: { examId: exam.id, courseId: exam.courseId },
      dedupeKey: `exam:${exam.id}:${window}`,
      supersessionKey: `exam:${exam.id}`,
      stateFingerprint: `exam:${window}:${weak ? "weak" : diagnostic ? "diagnostic" : "general"}`,
    });
    if (days > REMINDER_CONFIG.weakTopicExamWindowDays) continue;
    if (weak) {
      result.push({
        type: "weak-topic-before-exam",
        title: `Review ${weak.name} before ${exam.title}`,
        message: `${weak.name} mastery is ${Math.round(weak.mastery)} with ${Math.round(weak.confidence)} confidence before ${exam.courseCode} ${exam.title}.`,
        sourceType: "learning-topic",
        sourceId: weak.id,
        scheduledFor: input.now,
        expiresAt: exam.examDate,
        prioritySignals: { urgency: deadlineUrgency(days), academicImpact: 22, weakness: Math.min(20, 70 - weak.mastery), readiness: 12 },
        reasonCode: "WEAK_TOPIC_BEFORE_EXAM",
        reasonData: { examId: exam.id, daysRemaining: days, mastery: Math.round(weak.mastery), confidence: Math.round(weak.confidence) },
        actionTargetType: "workflow",
        actionTargetId: "weak-topic-recovery",
        actionPayload: { examId: exam.id, courseId: exam.courseId, topicId: weak.id },
        dedupeKey: `weak-before-exam:${exam.id}:${weak.id}:${window}`,
        supersessionKey: `exam-topic:${exam.id}:${weak.id}`,
        stateFingerprint: `weak:${window}:${Math.floor(weak.mastery / 10)}:${Math.floor(weak.confidence / 10)}`,
      });
    } else if (diagnostic) {
      result.push({
        type: "diagnostic-practice",
        title: `Check ${diagnostic.name} before ${exam.title}`,
        message: `${diagnostic.name} has limited evidence (${Math.round(diagnostic.confidence)} confidence). A short diagnostic quiz will clarify what to review.`,
        sourceType: "learning-topic",
        sourceId: diagnostic.id,
        scheduledFor: input.now,
        expiresAt: exam.examDate,
        prioritySignals: { urgency: deadlineUrgency(days), academicImpact: 18, readiness: 8, userActionRequired: 8 },
        reasonCode: "DIAGNOSTIC_BEFORE_EXAM",
        reasonData: { examId: exam.id, daysRemaining: days, mastery: Math.round(diagnostic.mastery), confidence: Math.round(diagnostic.confidence) },
        actionTargetType: "agent",
        actionTargetId: "quiz",
        actionPayload: { examId: exam.id, courseId: exam.courseId, topicId: diagnostic.id },
        dedupeKey: `diagnostic-before-exam:${exam.id}:${diagnostic.id}:${window}`,
        supersessionKey: `exam-topic:${exam.id}:${diagnostic.id}`,
        stateFingerprint: `diagnostic:${window}:${Math.floor(diagnostic.confidence / 10)}`,
      });
    }
  }
  return result;
}

function studyCandidates(input: ReminderDetectionInput): ReminderCandidate[] {
  const result: ReminderCandidate[] = [];
  const examDates = new Map(input.exams.map((exam) => [exam.id, exam.examDate]));
  for (const plan of input.studyPlans) {
    if (plan.status !== "ACTIVE") continue;
    let missedImportant = 0;
    let remaining = 0;
    for (const task of plan.tasks) {
      const sessionDate = task.scheduledStart ?? task.date;
      if (["PLANNED", "IN_PROGRESS"].includes(task.status)) remaining++;
      const days = calendarDayDifference(sessionDate, input.now, input.timezone);
      const linkedExamDays = task.examId && examDates.get(task.examId)
        ? calendarDayDifference(examDates.get(task.examId)!, input.now, input.timezone)
        : null;
      const important = task.priority >= REMINDER_CONFIG.missedTaskPriorityMinimum ||
        (linkedExamDays !== null && linkedExamDays >= 0 && linkedExamDays <= 7);
      const missed = (["PLANNED", "IN_PROGRESS"].includes(task.status) && days < 0) ||
        (task.status === "SKIPPED" && days >= -7);
      if (missed && important) {
        missedImportant++;
        result.push({
          type: "missed-study-task",
          title: `Missed study task: ${task.title}`,
          message: `${task.title} was missed${linkedExamDays !== null && linkedExamDays >= 0 ? ` with an exam in ${linkedExamDays} days` : ""}. Replan it before adding more work.`,
          sourceType: "study-task",
          sourceId: task.id,
          scheduledFor: input.now,
          prioritySignals: { urgency: linkedExamDays !== null ? deadlineUrgency(linkedExamDays) : 20, academicImpact: 18, sourcePriority: Math.round(task.priority / 5), missedWork: 18 },
          reasonCode: task.status === "SKIPPED" ? "IMPORTANT_STUDY_TASK_SKIPPED" : "IMPORTANT_STUDY_TASK_MISSED",
          reasonData: { taskPriority: task.priority, daysMissed: Math.abs(days), ...(linkedExamDays !== null ? { examDaysRemaining: linkedExamDays } : {}) },
          actionTargetType: "agent",
          actionTargetId: "study-planner",
          actionPayload: { studyPlanId: plan.id, studyTaskId: task.id },
          dedupeKey: `missed-study-task:${task.id}:${task.status}`,
          supersessionKey: `study-task:${task.id}`,
          stateFingerprint: `missed:${task.status}:${linkedExamDays ?? "none"}`,
        });
        continue;
      }
      const untilTaskMs = sessionDate.getTime() - input.now.getTime();
      if (!["PLANNED", "IN_PROGRESS"].includes(task.status) || (!task.scheduledStart && isUtcDateOnly(sessionDate)) ||
        untilTaskMs <= 0 || untilTaskMs > REMINDER_CONFIG.studySessionLookaheadHours * HOUR) continue;
      const reminderTime = new Date(sessionDate.getTime() - input.leadTimeMinutes * 60_000);
      const time = new Intl.DateTimeFormat("en", {
        timeZone: input.timezone, hour: "numeric", minute: "2-digit",
      }).format(sessionDate);
      result.push({
        type: "study-session",
        title: `Study session at ${time}`,
        message: `${task.title} is planned for ${time}.`,
        sourceType: "study-task",
        sourceId: task.id,
        scheduledFor: reminderTime < input.now ? input.now : reminderTime,
        expiresAt: new Date(sessionDate.getTime() + Math.max(HOUR, task.durationMinutes * 60_000)),
        prioritySignals: { urgency: 24, academicImpact: 15, sourcePriority: Math.round(task.priority / 8) },
        reasonCode: "STUDY_SESSION_STARTING_SOON",
        reasonData: { leadTimeMinutes: input.leadTimeMinutes, taskPriority: task.priority },
        actionTargetType: "resource",
        actionTargetId: "study-task",
        actionPayload: { studyPlanId: plan.id, studyTaskId: task.id },
        dedupeKey: `study-session:${task.id}:${sessionDate.toISOString()}:${input.leadTimeMinutes}`,
        supersessionKey: `study-task:${task.id}`,
        stateFingerprint: `session:${sessionDate.toISOString()}:${input.leadTimeMinutes}`,
      });
    }
    const endedBehind = plan.endDate < input.now && remaining > 0;
    if (missedImportant >= REMINDER_CONFIG.studyPlanMissedTaskMinimum || endedBehind) {
      result.push({
        type: "study-plan-behind",
        title: `${plan.title} is falling behind`,
        message: endedBehind
          ? `${plan.title} ended with ${remaining} unfinished tasks.`
          : `${missedImportant} important tasks in ${plan.title} were missed.`,
        sourceType: "study-plan",
        sourceId: plan.id,
        scheduledFor: input.now,
        prioritySignals: { urgency: endedBehind ? 25 : 18, academicImpact: 20, missedWork: Math.min(30, missedImportant * 10), userActionRequired: 10 },
        reasonCode: endedBehind ? "STUDY_PLAN_ENDED_BEHIND" : "MULTIPLE_IMPORTANT_TASKS_MISSED",
        reasonData: { missedImportantTasks: missedImportant, remainingTasks: remaining },
        actionTargetType: "agent",
        actionTargetId: "study-planner",
        actionPayload: { studyPlanId: plan.id },
        dedupeKey: `study-plan-behind:${plan.id}:${endedBehind ? "ended" : missedImportant >= 4 ? "four-plus" : "two-plus"}`,
        supersessionKey: `study-plan:${plan.id}`,
        stateFingerprint: `behind:${endedBehind}:${missedImportant}:${remaining}`,
      });
    }
  }
  return result;
}

function workflowCandidates(input: ReminderDetectionInput): ReminderCandidate[] {
  return input.workflows.flatMap((workflow) => {
    const waitingHours = Math.floor((input.now.getTime() - workflow.updatedAt.getTime()) / HOUR);
    if (waitingHours < REMINDER_CONFIG.workflowWaitingHours) return [];
    const bucket = waitingHours >= 72 ? "three-days" : waitingHours >= 48 ? "two-days" : "one-day";
    return [{
      type: "workflow-waiting" as const,
      title: "A study workflow needs your input",
      message: `Your ${workflow.workflowId.replaceAll("-", " ")} workflow is waiting for you to continue.`,
      sourceType: "workflow-run" as const,
      sourceId: workflow.id,
      scheduledFor: input.now,
      prioritySignals: { urgency: waitingHours >= 72 ? 30 : 20, academicImpact: 15, userActionRequired: 18 },
      reasonCode: "WORKFLOW_WAITING_FOR_INPUT",
      reasonData: { waitingHours, workflowId: workflow.workflowId, currentStep: workflow.currentStep },
      actionTargetType: "resource" as const,
      actionTargetId: "workflow-run",
      actionPayload: { workflowRunId: workflow.id },
      dedupeKey: `workflow-waiting:${workflow.id}:${bucket}`,
      supersessionKey: `workflow:${workflow.id}`,
      stateFingerprint: `waiting:${bucket}:${workflow.currentStep ?? "unknown"}`,
    }];
  });
}

export function calculateReminderPriority(signals: ReminderPrioritySignals): number {
  return bounded(Object.values(signals).reduce((sum, value) => sum + (value ?? 0), 0));
}

export function reminderPriorityLevel(score: number): ReminderPriority {
  if (score >= 95) return "critical";
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export function detectReminderCandidates(input: ReminderDetectionInput): ReminderCandidate[] {
  return [
    ...assignmentCandidates(input),
    ...examCandidates(input),
    ...studyCandidates(input),
    ...workflowCandidates(input),
  ];
}

export function rankReminderCandidates(
  candidates: readonly ReminderCandidate[],
): RankedReminderCandidate[] {
  const ranked = candidates.map((candidate) => {
    const priorityScore = calculateReminderPriority(candidate.prioritySignals);
    return { ...candidate, priorityScore, priority: reminderPriorityLevel(priorityScore) };
  }).sort((a, b) => b.priorityScore - a.priorityScore ||
    a.scheduledFor.getTime() - b.scheduledFor.getTime() ||
    a.dedupeKey.localeCompare(b.dedupeKey));
  const seen = new Set<string>();
  return ranked.filter((candidate) => {
    if (seen.has(candidate.supersessionKey)) return false;
    seen.add(candidate.supersessionKey);
    return true;
  }).slice(0, REMINDER_CONFIG.maximumActiveReminders);
}
