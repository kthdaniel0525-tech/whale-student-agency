import "server-only";
import type { ExamContext, LearningTopicContext } from "../context/types";
import { normalizeTopicName } from "../learning/normalization";
import { calculatePlanningSignals } from "../agents/study-planner/priority";
import type {
  AcademicConcern, AcademicRisk, AcademicSnapshot, AcademicSnapshotInput,
  ExamPlanEvidence, ExamReadiness,
} from "./types";

const DAY = 86_400_000;
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const bounded = (score: number) => Math.round(Math.max(0, Math.min(100, score)));

export const READINESS_CONFIG = {
  masteryWeight: 0.8,
  recentAccuracyWeight: 0.15,
  planWeight: 0.05,
  minimumConfidence: 40,
  minimumCoverage: 0.6,
  highConfidence: 65,
  highCoverage: 0.8,
  recentPracticeDays: 30,
} as const;

/** Mastery is reused unchanged. This is readiness, not a new mastery estimate.
 * Observed evidence = 80% mastery + 15% recent quiz accuracy + 5% plan completion.
 * Without a plan, academic weights are renormalized. Shrink evidence toward 50 by
 * coverage-adjusted confidence; recent practice supports confidence in readiness.
 * Missing topic metadata, coverage, or confidence prevents a readiness claim.
 */
export function calculateExamReadiness(
  exam: ExamContext,
  topics: readonly LearningTopicContext[],
  now: Date,
  plan?: ExamPlanEvidence,
): ExamReadiness {
  const names = new Set(exam.topics.map(normalizeTopicName));
  const matched = new Map<string, LearningTopicContext>();
  for (const topic of topics) {
    const key = normalizeTopicName(topic.topic);
    if (topic.course.id === exam.course.id && names.has(key) && topic.questionsAttempted > 0) {
      matched.set(key, topic);
    }
  }
  const evidence = [...matched.values()];
  const totalTopics = Math.max(names.size, exam.topicCount ?? 0);
  const coverage = totalTopics ? Math.min(1, evidence.length / totalTopics) : 0;
  const recentFraction = evidence.length ? evidence.filter((topic) =>
    topic.lastPracticedAt && now.getTime() - new Date(topic.lastPracticedAt).getTime() <= READINESS_CONFIG.recentPracticeDays * DAY,
  ).length / evidence.length : 0;
  const confidence = evidence.length
    ? bounded(average(evidence.map((topic) => topic.confidence)) * coverage * (0.75 + 0.25 * recentFraction))
    : 0;
  const planCompletion = plan?.total ? bounded(100 * plan.completed / plan.total) : null;
  const recentAccuracy = evidence.length ? bounded(average(evidence.map((topic) => topic.recentAccuracy))) : null;
  const measured = evidence.length
    ? (READINESS_CONFIG.masteryWeight * average(evidence.map((topic) => topic.mastery)) +
       READINESS_CONFIG.recentAccuracyWeight * recentAccuracy! +
       (planCompletion === null ? 0 : READINESS_CONFIG.planWeight * planCompletion)) /
       (planCompletion === null ? 1 - READINESS_CONFIG.planWeight : 1)
    : null;
  const score = measured === null ? null : bounded(50 + (measured - 50) * confidence / 100);
  const insufficient = !evidence.length || coverage < READINESS_CONFIG.minimumCoverage || confidence < READINESS_CONFIG.minimumConfidence;
  const level = insufficient ? "insufficient-data"
    : score! >= 80 && confidence >= READINESS_CONFIG.highConfidence && coverage >= READINESS_CONFIG.highCoverage ? "high"
    : score! >= 60 ? "moderate" : "low";
  return {
    examId: exam.id,
    courseId: exam.course.id,
    title: exam.title,
    daysRemaining: Math.max(0, Math.ceil((new Date(exam.examDate).getTime() - now.getTime()) / DAY)),
    readinessScore: score,
    readinessLevel: level,
    confidence,
    coverage: bounded(coverage * 100),
    recentAccuracy,
    planCompletion,
    weakTopics: evidence.filter((topic) => topic.mastery < 70 && topic.confidence >= 40).map((topic) => topic.topic).slice(0, 5),
    explanation: insufficient
      ? `Insufficient evidence: ${evidence.length}/${totalTopics} exam topics practiced, readiness confidence ${confidence}%.`
      : `Based on ${evidence.length}/${totalTopics} exam topics, recent quiz performance${planCompletion === null ? "" : ` and ${planCompletion}% linked plan completion`}; confidence ${confidence}%.`,
  };
}

/** Read-only composition over Context Builder data. No DB or LLM calls. */
export function buildAcademicSnapshot(input: AcademicSnapshotInput): AcademicSnapshot {
  const learning = input.learning;
  const topicMap = new Map([
    ...(learning?.recommendedTopics ?? []), ...(learning?.weakTopics ?? []),
    ...(learning?.strongTopics ?? []), ...(learning?.examTopics ?? []),
  ].map((topic) => [topic.topicId, topic]));
  const topics = [...topicMap.values()];
  const examReadiness = input.exams.map((exam) => calculateExamReadiness(
    exam, topics, input.now, input.examPlanEvidence.find((item) => item.examId === exam.id),
  ));
  const signals = calculatePlanningSignals({
    assignments: input.assignments.filter((item) => item.status !== "COMPLETED"),
    exams: input.exams, learning, startDate: input.now.toISOString().slice(0, 10),
    // Reuse ranking only; this service neither allocates time nor creates a plan.
    totalAvailableMinutes: 360,
  });
  const concerns: AcademicConcern[] = signals.filter((signal) => signal.kind !== "general").map((signal) => {
    const assignment = input.assignments.find((item) => item.id === signal.linkedAssignmentId);
    const exam = input.exams.find((item) => item.id === signal.linkedExamId);
    const needsDiagnosis = signal.sourceConfidenceScore !== null && signal.sourceConfidenceScore < 45;
    return {
      id: signal.id, courseId: signal.courseId, score: signal.priorityScore, reason: signal.reason,
      action: assignment ? `Work on ${assignment.title}`
        : signal.kind === "topic" ? `${needsDiagnosis ? "Check understanding of" : signal.sourceMasteryScore! < 70 ? "Review the concepts behind" : "Prepare a short review of"} ${signal.topic}`
        : `Review preparation for ${exam?.title ?? "the upcoming exam"}`,
      suggestedAgent: assignment ? null : signal.kind === "exam" ? "study-planner"
        : needsDiagnosis ? "quiz" : signal.sourceMasteryScore! < 70 ? "tutor" : "notes",
    };
  });
  const risks: AcademicRisk[] = [];
  if (input.counts.overdueAssignments) {
    risks.push({ id: "overdue-work", level: input.counts.overdueHighPriorityAssignments ? "high" : "moderate", courseId: null,
      reason: `${input.counts.overdueAssignments} overdue assignments, including ${input.counts.overdueHighPriorityAssignments} high-priority items.` });
    if (!concerns.some((item) => item.id.startsWith("assignment:"))) {
      concerns.push({ id: "overdue-work", courseId: null, score: 95, reason: risks[0].reason, action: "Review and address overdue assignments", suggestedAgent: null });
    }
  }
  for (const exam of examReadiness) {
    const declining = topics.some((topic) => topic.course.id === exam.courseId && topic.trend === "declining" &&
      input.exams.find((item) => item.id === exam.examId)?.topics.some((name) => normalizeTopicName(name) === normalizeTopicName(topic.topic)));
    if (exam.daysRemaining <= 7 && (exam.readinessLevel !== "high" || declining)) {
      const level = exam.daysRemaining <= 3 && (exam.readinessLevel === "low" || (declining && exam.confidence >= 40)) ? "high" : "moderate";
      risks.push({ id: `exam:${exam.examId}`, level, courseId: exam.courseId,
        reason: `${exam.title} is in ${exam.daysRemaining} days; readiness ${exam.readinessLevel}${declining ? ", with declining topic performance" : ""}.` });
    }
  }
  if (input.missedStudyTasks > 0) {
    const reason = `${input.missedStudyTasks} unfinished study tasks are past their scheduled dates.`;
    risks.push({ id: "missed-study", level: input.missedStudyTasks >= 3 ? "high" : "moderate", courseId: null, reason });
    concerns.push({ id: "missed-study", courseId: null, score: input.missedStudyTasks >= 3 ? 82 : 62,
      reason, action: "Adjust the existing study plan around missed sessions", suggestedAgent: "study-planner" });
  }
  if (input.counts.assignmentsDueNext7Days >= 3) {
    const reason = `${input.counts.assignmentsDueNext7Days} assignments are due in the next 7 days.`;
    risks.push({ id: "workload-cluster", level: "moderate", courseId: null, reason });
    concerns.push({ id: "workload-cluster", courseId: null, score: 68, reason,
      action: "Allocate study time around this week's assignment deadlines", suggestedAgent: "study-planner" });
  }
  for (const session of input.upcomingSessions.slice(0, 3)) {
    concerns.push({ id: `task:${session.id}`, courseId: session.courseId, score: 50,
      action: `Continue ${session.title}`, suggestedAgent: null,
      reason: `Already scheduled for ${session.date}, ${session.durationMinutes} minutes.` });
  }
  const priorities = concerns.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 8);
  if (!priorities.length) {
    priorities.push({ id: "check-evidence", courseId: null, score: 20, suggestedAgent: null,
      action: input.counts.totalActiveCourses ? "Check upcoming course deadlines and record recent practice" : "Add your current courses and upcoming deadlines",
      reason: "No urgent work or sufficient practice evidence appears in the available academic context." });
  }
  const courses = input.courses.map((course) => {
    const relevant = concerns.filter((item) => item.courseId === course.id);
    const score = Math.max(0, ...relevant.map((item) => item.score), course.overdueAssignments ? 85 : 0,
      course.missedStudyTasks >= 3 ? 80 : course.missedStudyTasks ? 55 : 0,
      course.assignmentsDueNext7Days >= 3 ? 65 : 0, course.examsNext14Days ? 40 : 0);
    const reasons = relevant.sort((a, b) => b.score - a.score).slice(0, 2).map((item) => item.reason);
    if (course.overdueAssignments) reasons.unshift(`${course.overdueAssignments} overdue assignments.`);
    if (!reasons.length) reasons.push("No urgent concern identified in the available evidence.");
    return { ...course, attentionScore: bounded(score), attention: score >= 75 ? "high" as const : score >= 40 ? "moderate" as const : "low" as const, reasons: reasons.slice(0, 3) };
  }).sort((a, b) => b.attentionScore - a.attentionScore || a.id.localeCompare(b.id));
  const completed = input.studyPlans.reduce((sum, plan) => sum + plan.completedTasks, 0);
  const total = input.studyPlans.reduce((sum, plan) => sum + plan.completedTasks + plan.remainingTasks, 0);
  const orderedRisks = risks.sort((a, b) => Number(b.level === "high") - Number(a.level === "high") || a.id.localeCompare(b.id));
  return {
    ...input.counts, semester: input.semester,
    overallStatus: orderedRisks.some((risk) => risk.level === "high") ? "high"
      : orderedRisks.length ? "moderate" : topics.some((topic) => topic.confidence >= 40) ? "low" : "insufficient-data",
    courses,
    weakestTopics: (learning?.weakTopics ?? []).slice(0, 5),
    strongestTopics: (learning?.strongTopics ?? []).slice(0, 5),
    decliningTopics: topics.filter((topic) => topic.trend === "declining").slice(0, 5),
    activeStudyPlans: input.studyPlans,
    activeStudyPlanProgress: total ? bounded(completed / total * 100) : null,
    missedStudyTasks: input.missedStudyTasks,
    upcomingSessions: input.upcomingSessions,
    priorities,
    risks: orderedRisks.slice(0, 8),
    examReadiness,
    actionCandidates: priorities.slice(0, 5).map((item) => ({
      id: item.id, agentId: item.suggestedAgent, action: item.action,
      priority: item.score >= 65 ? "high" : item.score >= 40 ? "medium" : "low",
      reason: item.reason, courseId: item.courseId,
    })),
    limitations: [
      ...(input.limitations ?? []),
      ...(!learning ? ["No learning evidence is available; readiness and academic strength cannot be confirmed."] : []),
      "Readiness estimates use recorded practice, not a predicted exam grade.",
    ],
  };
}
