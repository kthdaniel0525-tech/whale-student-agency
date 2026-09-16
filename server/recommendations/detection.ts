import "server-only";
import { normalizeTopicName } from "../learning/normalization";
import { RECOMMENDATION_CONFIG } from "./config";
import type {
  RecommendationCandidate,
  RecommendationDetectionInput,
  RecommendationPriority,
  RecommendationPrioritySignals,
} from "./types";

const DAY = 86_400_000;

function bounded(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function daysUntil(date: Date, now: Date): number {
  return Math.ceil((date.getTime() - now.getTime()) / DAY);
}

function daysSince(date: Date | null, now: Date): number {
  return date ? Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY)) : 365;
}

function urgencyBucket(days: number): string {
  if (days <= 1) return "immediate";
  if (days <= 3) return "three-days";
  if (days <= 7) return "one-week";
  return "two-weeks";
}

function evidenceBucket(value: number): string {
  return String(Math.max(0, Math.min(10, Math.floor(value / 10))));
}

function deadlineUrgency(days: number): number {
  if (days < 0) return 40;
  if (days <= 1) return 38;
  if (days <= 3) return 32;
  if (days <= 7) return 24;
  return 12;
}

export function calculateRecommendationPriority(
  signals: RecommendationPrioritySignals,
): number {
  return bounded(Object.values(signals).reduce((sum, value) => sum + (value ?? 0), 0));
}

export function recommendationPriorityLevel(score: number): RecommendationPriority {
  if (score >= 90) return "critical";
  if (score >= 70) return "high";
  if (score >= 45) return "medium";
  return "low";
}

function examCandidates(
  input: RecommendationDetectionInput,
  coveredTopics: Set<string>,
): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];
  for (const exam of input.exams) {
    if (input.activeWorkflowSourceKeys.has(`exam:${exam.id}`)) continue;
    const days = daysUntil(exam.examDate, input.now);
    if (days < 0 || days > RECOMMENDATION_CONFIG.examWindowDays) continue;
    const names = new Set(exam.topics.map(normalizeTopicName));
    const topics = input.topics
      .filter((topic) => topic.courseId === exam.courseId && names.has(topic.normalizedName))
      .sort((a, b) => {
        const riskA = 100 - a.mastery + a.confidence / 5 + (a.trend === "DECLINING" ? 15 : 0);
        const riskB = 100 - b.mastery + b.confidence / 5 + (b.trend === "DECLINING" ? 15 : 0);
        return riskB - riskA || a.id.localeCompare(b.id);
      });
    const weak = topics.find((topic) =>
      topic.mastery <= RECOMMENDATION_CONFIG.weakMasteryMaximum &&
      topic.confidence >= RECOMMENDATION_CONFIG.weakConfidenceMinimum,
    );
    const diagnostic = topics.find((topic) =>
      topic.mastery <= RECOMMENDATION_CONFIG.diagnosticMasteryMaximum &&
      topic.confidence <= RECOMMENDATION_CONFIG.diagnosticConfidenceMaximum,
    );
    const target = weak ?? diagnostic ?? topics[0];
    const stronglyPrepared = topics.length > 0 && topics.every((topic) =>
      topic.mastery >= 85 && topic.confidence >= RECOMMENDATION_CONFIG.weakConfidenceMinimum,
    ) && (exam.planCompletion ?? 0) >= 80;
    if (stronglyPrepared && days > 3) continue;
    for (const topic of topics) coveredTopics.add(topic.id);
    const course = input.courses.find((item) => item.id === exam.courseId);
    const inactive = course && days > 7 && daysSince(course.lastActivityAt, input.now) >= RECOMMENDATION_CONFIG.courseInactivityDays;
    if (!target && inactive) {
      candidates.push({
        type: "course-inactivity",
        title: `Resume ${exam.courseCode} preparation`,
        message: `${exam.title} is in ${days} days, but no recent study activity is recorded for this course.`,
        sourceType: "course",
        sourceId: exam.courseId,
        recommendedAgentId: "study-planner",
        actionPayload: {
          courseId: exam.courseId,
          examId: exam.id,
          ...(exam.studyPlanId ? { studyPlanId: exam.studyPlanId } : {}),
        },
        reasonCode: "COURSE_INACTIVE_WITH_UPCOMING_EXAM",
        reasonData: {
          daysRemaining: days,
          inactiveDays: daysSince(course.lastActivityAt, input.now),
          ...(exam.planCompletion !== null ? { planCompletion: exam.planCompletion } : {}),
        },
        prioritySignals: { urgency: deadlineUrgency(days), impact: 22, missedWork: 10 },
        dedupeKey: `course-inactivity:${exam.courseId}:${exam.id}:study-planner`,
        supersessionKey: `exam:${exam.id}`,
        stateFingerprint: `${urgencyBucket(days)}:inactive`,
        expiresAt: new Date(exam.examDate.getTime() + DAY),
      });
      continue;
    }
    const reasonCode = weak
      ? "EXAM_SOON_WEAK_TOPIC"
      : diagnostic
        ? "EXAM_SOON_LOW_CONFIDENCE"
        : "EXAM_APPROACHING";
    const message = weak
      ? `${exam.courseCode} ${exam.title} is in ${days} days, and ${weak.name} mastery is ${Math.round(weak.mastery)} with ${Math.round(weak.confidence)} confidence.`
      : diagnostic
        ? `${exam.courseCode} ${exam.title} is in ${days} days, and ${diagnostic.name} needs diagnostic practice before its weakness is treated as certain.`
        : exam.planCompletion !== null
          ? `${exam.courseCode} ${exam.title} is in ${days} days. Continue the current plan, which is ${exam.planCompletion}% complete.`
          : `${exam.courseCode} ${exam.title} is in ${days} days. Start or update a distributed exam preparation plan.`;
    candidates.push({
      type: "exam-preparation",
      title: `Prepare for ${exam.courseCode} ${exam.title}`,
      message,
      sourceType: "exam",
      sourceId: exam.id,
      recommendedWorkflowId: "exam-preparation",
      actionPayload: {
        courseId: exam.courseId,
        examId: exam.id,
        ...(target ? { topicId: target.id } : {}),
        ...(exam.studyPlanId ? { studyPlanId: exam.studyPlanId } : {}),
      },
      reasonCode,
      reasonData: {
        daysRemaining: days,
        ...(target ? { mastery: Math.round(target.mastery), confidence: Math.round(target.confidence) } : {}),
        ...(exam.planCompletion !== null ? { planCompletion: exam.planCompletion } : {}),
      },
      prioritySignals: {
        urgency: deadlineUrgency(days),
        impact: exam.planCompletion !== null && exam.planCompletion >= 80 ? 15 : 25,
        weakness: target ? bounded((70 - target.mastery) / 70 * 25) : 0,
        confidence: weak ? 10 : diagnostic ? 5 : 0,
        trend: target?.trend === "DECLINING" ? 10 : 0,
      },
      dedupeKey: `exam-preparation:exam:${exam.id}:exam-preparation`,
      supersessionKey: `exam:${exam.id}`,
      stateFingerprint: [
        urgencyBucket(days),
        target ? evidenceBucket(target.mastery) : "none",
        target ? evidenceBucket(target.confidence) : "none",
        target?.trend ?? "none",
      ].join(":"),
      expiresAt: new Date(exam.examDate.getTime() + DAY),
    });
  }
  return candidates;
}

function assignmentCandidates(input: RecommendationDetectionInput): RecommendationCandidate[] {
  return input.assignments.flatMap((assignment) => {
    if (assignment.status === "COMPLETED") return [];
    if (input.activeWorkflowSourceKeys.has(`assignment:${assignment.id}`)) return [];
    const days = daysUntil(assignment.dueDate, input.now);
    if (days > RECOMMENDATION_CONFIG.assignmentWindowDays) return [];
    const overdue = days < 0;
    const impact = assignment.priority === "HIGH" ? 25 : assignment.priority === "MEDIUM" ? 16 : 8;
    return [{
      type: "assignment-deadline" as const,
      title: overdue ? `Address overdue ${assignment.title}` : `Continue ${assignment.title}`,
      message: overdue
        ? `${assignment.courseCode} ${assignment.title} is overdue and remains ${assignment.status === "TODO" ? "not started" : "in progress"}.`
        : `${assignment.courseCode} ${assignment.title} is due in ${days} day${days === 1 ? "" : "s"} and is ${assignment.status === "TODO" ? "not started" : "in progress"}.`,
      sourceType: "assignment" as const,
      sourceId: assignment.id,
      recommendedWorkflowId: "assignment-support" as const,
      actionPayload: { courseId: assignment.courseId, assignmentId: assignment.id },
      reasonCode: overdue ? "ASSIGNMENT_OVERDUE" : "ASSIGNMENT_DUE_SOON",
      reasonData: { daysRemaining: days, priority: assignment.priority.toLocaleLowerCase(), estimatedHours: assignment.estimatedHours },
      prioritySignals: {
        urgency: deadlineUrgency(days),
        impact,
        missedWork: overdue ? (assignment.priority === "HIGH" ? 25 : 15)
          : assignment.status === "TODO" && days <= 1 ? 10 : 0,
      },
      dedupeKey: `assignment-deadline:assignment:${assignment.id}:assignment-support`,
      supersessionKey: `assignment:${assignment.id}`,
      stateFingerprint: `${urgencyBucket(days)}:${assignment.status}:${assignment.priority}`,
    } satisfies RecommendationCandidate];
  });
}

function topicCandidates(
  input: RecommendationDetectionInput,
  coveredTopics: ReadonlySet<string>,
): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];
  for (const topic of input.topics) {
    if (coveredTopics.has(topic.id) || topic.questionsAttempted === 0) continue;
    if (input.activeWorkflowSourceKeys.has(`topic:${topic.id}`)) continue;
    const repeated = topic.recentFailures >= RECOMMENDATION_CONFIG.repeatedFailureMinimum;
    const weak = topic.mastery <= RECOMMENDATION_CONFIG.weakMasteryMaximum &&
      topic.confidence >= RECOMMENDATION_CONFIG.weakConfidenceMinimum;
    const diagnostic = topic.mastery <= RECOMMENDATION_CONFIG.diagnosticMasteryMaximum &&
      topic.confidence <= RECOMMENDATION_CONFIG.diagnosticConfidenceMaximum;
    const declining = topic.trend === "DECLINING" &&
      topic.confidence >= RECOMMENDATION_CONFIG.weakConfidenceMinimum &&
      topic.questionsAttempted >= RECOMMENDATION_CONFIG.decliningEvidenceMinimum;
    if (!weak && !diagnostic && !declining && !repeated) continue;
    const type = diagnostic && !repeated ? "diagnostic-practice" as const : "weak-topic" as const;
    const workflow = type === "weak-topic" && (weak || repeated) ? "weak-topic-recovery" as const : undefined;
    const agent = workflow ? undefined : type === "diagnostic-practice" ? "quiz" as const : "tutor" as const;
    const reasonCode = repeated ? "REPEATED_WEAKNESS_AFTER_PRACTICE"
      : weak ? "WEAK_TOPIC_HIGH_CONFIDENCE"
      : diagnostic ? "LOW_CONFIDENCE_DIAGNOSTIC"
      : "DECLINING_MASTERY";
    const message = diagnostic && !repeated
      ? `${topic.courseCode} ${topic.name} has limited evidence (${Math.round(topic.confidence)} confidence). Use a short diagnostic quiz before treating it as a confirmed weakness.`
      : repeated
        ? `${topic.courseCode} ${topic.name} remains difficult after repeated practice. Use a bounded recovery sequence instead of repeating the same quiz.`
        : `${topic.courseCode} ${topic.name} mastery is ${Math.round(topic.mastery)} with ${Math.round(topic.confidence)} confidence${declining ? " and the trend is declining" : ""}.`;
    const target = workflow ?? agent!;
    candidates.push({
      type,
      title: type === "diagnostic-practice" ? `Check ${topic.name} understanding` : `Strengthen ${topic.name}`,
      message,
      sourceType: "learning-topic",
      sourceId: topic.id,
      ...(workflow ? { recommendedWorkflowId: workflow } : { recommendedAgentId: agent! }),
      actionPayload: { courseId: topic.courseId, topicId: topic.id },
      reasonCode,
      reasonData: {
        mastery: Math.round(topic.mastery),
        confidence: Math.round(topic.confidence),
        recentAccuracy: Math.round(topic.recentAccuracy),
        recentFailures: topic.recentFailures,
      },
      prioritySignals: {
        urgency: repeated ? 12 : 5,
        impact: 20,
        weakness: bounded((70 - topic.mastery) / 70 * 25),
        confidence: weak || declining ? 10 : 5,
        trend: declining ? 10 : 0,
      },
      dedupeKey: `${type}:learning-topic:${topic.id}:${target}`,
      supersessionKey: `learning-topic:${topic.id}`,
      stateFingerprint: `${evidenceBucket(topic.mastery)}:${evidenceBucket(topic.confidence)}:${topic.trend}:${repeated ? "repeated" : "normal"}`,
    });
  }
  return candidates;
}

function studyPlanCandidates(input: RecommendationDetectionInput): RecommendationCandidate[] {
  return input.studyPlans.flatMap((plan) => {
    if (plan.status !== "ACTIVE" || !plan.remainingTasks) return [];
    const overduePlan = plan.endDate.getTime() < input.now.getTime();
    if (!plan.missedTasks && !overduePlan) return [];
    const missedBucket = plan.missedTasks >= 3 ? "persistent" : "limited";
    return [{
      type: plan.missedTasks ? "missed-study-task" as const : "study-plan" as const,
      title: `Adjust ${plan.title}`,
      message: plan.missedTasks
        ? `${plan.missedTasks} study session${plan.missedTasks === 1 ? " is" : "s are"} missed. Rebalance remaining work without adding overload.`
        : `${plan.title} ended with ${plan.remainingTasks} unfinished tasks. Update only the remaining work.`,
      sourceType: "study-plan" as const,
      sourceId: plan.id,
      recommendedAgentId: "study-planner" as const,
      actionPayload: {
        studyPlanId: plan.id,
        suggestedSessionMinutes: input.preferences.studySessionMinutes,
      },
      reasonCode: plan.missedTasks ? "MISSED_STUDY_TASKS" : "UNFINISHED_STUDY_PLAN",
      reasonData: { missedTasks: plan.missedTasks, remainingTasks: plan.remainingTasks },
      prioritySignals: { urgency: overduePlan ? 15 : 8, impact: 18, missedWork: Math.min(25, plan.missedTasks * 8) },
      dedupeKey: `study-plan:study-plan:${plan.id}:study-planner`,
      supersessionKey: `study-plan:${plan.id}`,
      stateFingerprint: `${missedBucket}:${plan.remainingTasks >= 5 ? "many" : "few"}:${overduePlan ? "ended" : "active"}`,
    } satisfies RecommendationCandidate];
  });
}

function lectureCandidates(input: RecommendationDetectionInput): RecommendationCandidate[] {
  return input.documents.flatMap((document) => {
    const age = daysSince(document.createdAt, input.now);
    if (input.studiedDocumentIds.has(document.id) ||
      input.activeWorkflowSourceKeys.has(`document:${document.id}`) ||
      age > RECOMMENDATION_CONFIG.lectureFreshnessDays) return [];
    return [{
      type: "lecture-study" as const,
      title: `Study ${document.title}`,
      message: `${document.courseCode ? `${document.courseCode} ` : ""}${document.title} is ready and has not yet been completed through Lecture Study.`,
      sourceType: "document" as const,
      sourceId: document.id,
      recommendedWorkflowId: "lecture-study" as const,
      actionPayload: {
        documentId: document.id,
        ...(document.courseId ? { courseId: document.courseId } : {}),
        availableMinutes: input.preferences.studySessionMinutes,
      },
      reasonCode: "LECTURE_READY_UNSTUDIED",
      reasonData: { daysSinceUpload: age },
      prioritySignals: { urgency: age <= 3 ? 8 : 3, impact: document.courseId ? 17 : 10 },
      dedupeKey: `lecture-study:document:${document.id}:lecture-study`,
      supersessionKey: `document:${document.id}`,
      stateFingerprint: document.createdAt.toISOString(),
      expiresAt: new Date(document.createdAt.getTime() + RECOMMENDATION_CONFIG.lectureFreshnessDays * DAY),
    } satisfies RecommendationCandidate];
  });
}

function careerCandidates(input: RecommendationDetectionInput): RecommendationCandidate[] {
  return input.careerPlans.flatMap((plan) => {
    if (plan.status !== "ACTIVE" || !plan.nextTask) return [];
    const due = plan.nextTask.targetDate ?? plan.targetDate;
    const days = due ? daysUntil(due, input.now) : RECOMMENDATION_CONFIG.careerWindowDays;
    if (days > RECOMMENDATION_CONFIG.careerWindowDays && plan.nextTask.priority < 70) return [];
    return [{
      type: "career-preparation" as const,
      title: `Continue ${plan.targetRole} preparation`,
      message: `${plan.nextTask.title} is the next unfinished high-value career milestone${due ? `, targeted within ${Math.max(0, days)} days` : ""}.`,
      sourceType: "career-plan" as const,
      sourceId: plan.id,
      recommendedAgentId: "career" as const,
      actionPayload: { careerPlanId: plan.id, careerTaskId: plan.nextTask.id },
      reasonCode: "CAREER_MILESTONE_PENDING",
      reasonData: { taskPriority: plan.nextTask.priority, daysRemaining: days },
      prioritySignals: { urgency: days <= 7 ? 20 : days <= 30 ? 10 : 4, impact: Math.min(18, Math.round(plan.nextTask.priority / 6)) },
      dedupeKey: `career-preparation:career-plan:${plan.id}:career`,
      supersessionKey: `career-plan:${plan.id}`,
      stateFingerprint: `${plan.nextTask.id}:${urgencyBucket(days)}`,
      ...(due ? { expiresAt: new Date(due.getTime() + DAY) } : {}),
    } satisfies RecommendationCandidate];
  });
}

/** Pure deterministic detection. It does not read storage or call an AI provider. */
export function detectRecommendationCandidates(
  input: RecommendationDetectionInput,
): RecommendationCandidate[] {
  const coveredTopics = new Set<string>();
  return [
    ...examCandidates(input, coveredTopics),
    ...assignmentCandidates(input),
    ...topicCandidates(input, coveredTopics),
    ...studyPlanCandidates(input),
    ...lectureCandidates(input),
    ...careerCandidates(input),
  ];
}

/** One candidate per supersession scope, highest explainable score first. */
export function rankRecommendationCandidates(
  candidates: readonly RecommendationCandidate[],
): readonly (RecommendationCandidate & { priorityScore: number; priority: RecommendationPriority })[] {
  const ranked = candidates.map((candidate) => {
    const priorityScore = calculateRecommendationPriority(candidate.prioritySignals);
    return { ...candidate, priorityScore, priority: recommendationPriorityLevel(priorityScore) };
  }).sort((a, b) => b.priorityScore - a.priorityScore || a.dedupeKey.localeCompare(b.dedupeKey));
  const seen = new Set<string>();
  return ranked.filter((candidate) => {
    if (seen.has(candidate.supersessionKey)) return false;
    seen.add(candidate.supersessionKey);
    return true;
  });
}
