import { describe, expect, it } from "vitest";
import { buildAcademicSnapshot, calculateExamReadiness } from "@/server/academic/snapshot";
import type { AcademicSnapshotInput } from "@/server/academic/types";
import type { ExamContext, LearningTopicContext } from "@/server/context/types";

const now = new Date("2026-09-14T12:00:00Z");
const course = { id: "math", courseCode: "MATH 1240", courseName: "Discrete Mathematics" };
const exam: ExamContext = { id: "exam", title: "Math midterm", examDate: "2026-09-16T12:00:00Z", daysRemaining: 2, topics: ["Induction"], course };
function topic(overrides: Partial<LearningTopicContext> = {}): LearningTopicContext {
  return { topicId: "induction", topic: "Induction", course, mastery: 42, confidence: 88,
    recentAccuracy: 40, questionsAttempted: 10, practiceSessions: 4, status: "developing", evidence: "sufficient",
    trend: "declining", lastPracticedAt: now.toISOString(), ...overrides };
}
function input(overrides: Partial<AcademicSnapshotInput> = {}): AcademicSnapshotInput {
  return {
    now, semester: "Fall 2026",
    counts: { totalActiveCourses: 1, overdueAssignments: 0, overdueHighPriorityAssignments: 0, assignmentsDueNext7Days: 0, examsNext14Days: 1 },
    courses: [{ ...course, overdueAssignments: 0, assignmentsDueNext7Days: 0, examsNext14Days: 1, missedStudyTasks: 0 }],
    assignments: [], exams: [exam],
    learning: { weakTopics: [topic()], strongTopics: [], recommendedTopics: [] },
    studyPlans: [], missedStudyTasks: 0, upcomingSessions: [], examPlanEvidence: [],
    ...overrides,
  };
}

describe("deterministic academic snapshot and readiness", () => {
  it("uses reliable weak exam evidence for low readiness and high academic risk", () => {
    const snapshot = buildAcademicSnapshot(input());
    expect(snapshot.examReadiness[0]).toMatchObject({ readinessLevel: "low", confidence: 88, coverage: 100, weakTopics: ["Induction"] });
    expect(snapshot.risks).toContainEqual(expect.objectContaining({ id: "exam:exam", level: "high" }));
    expect(snapshot.overallStatus).toBe("high");
  });
  it("shrinks limited evidence rather than declaring high readiness", () => {
    const result = calculateExamReadiness(exam, [topic({ mastery: 95, confidence: 20, recentAccuracy: 95 })], now);
    expect(result.readinessLevel).toBe("insufficient-data");
    expect(result.readinessScore).toBeLessThan(65);
    expect(result.confidence).toBe(20);
  });
  it("requires actual topic evidence; missing topics never imply readiness", () => {
    const result = calculateExamReadiness({ ...exam, topics: ["Induction", "Logic", "Recursion"] }, [topic({ mastery: 95, confidence: 95 })], now);
    expect(result).toMatchObject({ readinessLevel: "insufficient-data", coverage: 33 });
  });
  it("does not confuse identically named topics in different courses", () => {
    const result = calculateExamReadiness(exam, [topic({ course: { ...course, id: "other" } })], now);
    expect(result).toMatchObject({ readinessScore: null, readinessLevel: "insufficient-data", confidence: 0 });
  });
  it("does not substitute course-wide mastery when exam metadata is missing", () => {
    expect(calculateExamReadiness({ ...exam, topics: [] }, [topic({ mastery: 100, confidence: 100 })], now))
      .toMatchObject({ readinessScore: null, readinessLevel: "insufficient-data" });
  });
  it("keeps readiness conservative when exam topic names were truncated", () => {
    const result = calculateExamReadiness({ ...exam, topicCount: 15 }, [topic({ mastery: 100, confidence: 100 })], now);
    expect(result.readinessLevel).toBe("insufficient-data");
    expect(result.coverage).toBe(7);
  });
  it("reflects stale practice without recalculating stored mastery", () => {
    const freshTopic = topic({ mastery: 95, recentAccuracy: 95, confidence: 95 });
    const fresh = calculateExamReadiness(exam, [freshTopic], now);
    const stale = calculateExamReadiness(exam, [{ ...freshTopic, lastPracticedAt: "2026-07-01T00:00:00Z" }], now);
    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(stale.readinessScore!).toBeLessThan(fresh.readinessScore!);
    expect(freshTopic.mastery).toBe(95);
  });
  it("gives linked plan completion a modest influence, not mastery replacement", () => {
    const evidence = [topic({ mastery: 90, confidence: 95, recentAccuracy: 90 })];
    const completed = calculateExamReadiness(exam, evidence, now, { examId: exam.id, completed: 10, total: 10 });
    const uncompleted = calculateExamReadiness(exam, evidence, now, { examId: exam.id, completed: 0, total: 10 });
    expect(completed.readinessScore!).toBeGreaterThan(uncompleted.readinessScore!);
    expect(completed.readinessScore! - uncompleted.readinessScore!).toBeLessThanOrEqual(5);
    expect(completed.readinessLevel).toBe("high");
  });
  it("treats an imminent uncertain exam as evidence risk, not proven weakness", () => {
    const snapshot = buildAcademicSnapshot(input({ learning: undefined }));
    expect(snapshot.examReadiness[0].readinessLevel).toBe("insufficient-data");
    expect(snapshot.risks[0]).toMatchObject({ level: "moderate" });
    expect(snapshot.actionCandidates[0].agentId).toBe("study-planner");
  });
  it("flags overdue high-priority assignments and makes the concrete task actionable", () => {
    const snapshot = buildAcademicSnapshot(input({
      counts: { ...input().counts, overdueAssignments: 1, overdueHighPriorityAssignments: 1 },
      assignments: [{ id: "proof", title: "Proof homework", dueDate: "2026-09-13T00:00:00Z", status: "TODO", priority: "HIGH", estimatedHours: 3, overdue: true, course }],
    }));
    expect(snapshot.risks).toContainEqual(expect.objectContaining({ id: "overdue-work", level: "high" }));
    expect(snapshot.actionCandidates[0]).toMatchObject({ id: "assignment:proof", agentId: null, action: "Work on Proof homework" });
  });
  it("ranks courses by concerns and workload rather than splitting attention equally", () => {
    const snapshot = buildAcademicSnapshot(input({ courses: [
      input().courses[0],
      { id: "cs", courseCode: "COMP", courseName: "Algorithms", overdueAssignments: 0, assignmentsDueNext7Days: 0, examsNext14Days: 0, missedStudyTasks: 0 },
    ] }));
    expect(snapshot.courses[0].id).toBe("math");
    expect(snapshot.courses[0].attentionScore).toBeGreaterThan(snapshot.courses[1].attentionScore);
    expect(snapshot.courses[0].reasons.join(" ")).toMatch(/mastery|midterm/);
  });
  it("recommends plan repair for repeated missed tasks without changing the plan", () => {
    const source = input({ missedStudyTasks: 3 });
    const original = structuredClone(source);
    const snapshot = buildAcademicSnapshot(source);
    expect(snapshot.risks).toContainEqual(expect.objectContaining({ id: "missed-study", level: "high" }));
    expect(snapshot.actionCandidates).toContainEqual(expect.objectContaining({ agentId: "study-planner", id: "missed-study" }));
    expect(source).toEqual(original);
  });
  it("distinguishes conceptual help, diagnostic quizzes and maintenance notes", () => {
    const snapshot = buildAcademicSnapshot(input({ learning: {
      weakTopics: [topic()], strongTopics: [topic({ topicId: "logic", topic: "Logic", mastery: 95, confidence: 95, trend: "stable" })],
      recommendedTopics: [{ ...topic({ topicId: "relations", topic: "Relations", confidence: 15 }), reasons: ["low-confidence"] }],
    } }));
    expect(snapshot.actionCandidates).toContainEqual(expect.objectContaining({ id: "topic:induction", agentId: "tutor" }));
    expect(snapshot.actionCandidates).toContainEqual(expect.objectContaining({ id: "topic:relations", agentId: "quiz" }));
    expect(snapshot.actionCandidates).toContainEqual(expect.objectContaining({ id: "topic:logic", agentId: "notes" }));
  });
  it("does not invent an academic problem or specialist when there is no evidence", () => {
    const snapshot = buildAcademicSnapshot(input({ courses: [], exams: [], learning: undefined,
      counts: { totalActiveCourses: 0, overdueAssignments: 0, overdueHighPriorityAssignments: 0, assignmentsDueNext7Days: 0, examsNext14Days: 0 } }));
    expect(snapshot.overallStatus).toBe("insufficient-data");
    expect(snapshot.risks).toEqual([]);
    expect(snapshot.actionCandidates).toHaveLength(1);
    expect(snapshot.actionCandidates[0].agentId).toBeNull();
    expect(snapshot.activeStudyPlanProgress).toBeNull();
  });
  it("keeps exact workload counts even when detailed rows are bounded", () => {
    const snapshot = buildAcademicSnapshot(input({ counts: { ...input().counts, assignmentsDueNext7Days: 25 }, assignments: [] }));
    expect(snapshot.assignmentsDueNext7Days).toBe(25);
    expect(snapshot.risks).toContainEqual(expect.objectContaining({ id: "workload-cluster" }));
  });
});
