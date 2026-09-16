import { describe, expect, it } from "vitest";
import { lectureStudySettings, selectLectureTargets, summarizeLecture } from "@/server/workflows/lecture-policy";
import type { LectureState } from "@/server/workflows/lecture-policy";
import type { LearningTopicSummary } from "@/server/learning/types";
function state(): LectureState {
  return { ...lectureStudySettings({ goal: "Study this lecture" }), documents: [], sources: [], concepts: [
    { topic: "Induction", keyIdea: "Base and step", complexity: "intermediate", sourceRefs: [] },
    { topic: "Logic", keyIdea: "Inference", complexity: "basic", sourceRefs: [] },
    { topic: "Strong Induction", keyIdea: "All previous cases", complexity: "advanced", sourceRefs: [] },
  ], learningBefore: [
    { id: "induction", topic: "Induction", mastery: 45, confidence: 88, questionsAttempted: 20, recentAccuracy: 30, trend: "declining" },
    { id: "logic", topic: "Logic", mastery: 95, confidence: 95, questionsAttempted: 20, recentAccuracy: 95, trend: "stable" },
  ], tutorTargets: [], practiceTopics: [], quiz: null, summary: null };
}
const current = (extra: Partial<LearningTopicSummary> = {}): LearningTopicSummary => ({ id: "induction", topic: "Induction", courseId: "math", courseCode: "MATH", courseName: "Mathematics", mastery: 60, confidence: 90, questionsAttempted: 23, practiceSessions: 5, recentAccuracy: 70, trend: "improving", lastPracticedAt: null, status: "developing", evidence: "sufficient", ...extra });
describe("Lecture Study workload and learning decisions", () => {
  it.each([[20, "quick-review", 4], [60, "standard-study", 6], [120, "deep-study", 10]] as const)("adapts %s minutes to %s", (availableMinutes, mode, count) => {
    const result = lectureStudySettings({ goal: "Study this PDF", availableMinutes });
    expect(result.mode).toBe(mode); expect(result.effort.questionCount).toBe(count); expect(result.effort.totalMinutes).toBeLessThanOrEqual(availableMinutes);
  });
  it("respects an explicit mode and adapts workload within that mode", () => {
    const result = lectureStudySettings({ goal: "quick review", mode: "standard-study", availableMinutes: 30 });
    expect(result.mode).toBe("standard-study"); expect(result.effort).toEqual({ questionCount: 5, quizMinutes: 15, notesMinutes: 7, tutorMinutes: 8, totalMinutes: 30 });
  });
  it("does not silently overload or downgrade an explicit mode", () => {
    expect(() => lectureStudySettings({ goal: "Study", mode: "deep-study", availableMinutes: 20 })).toThrow();
    expect(() => lectureStudySettings({ goal: "Study", availableMinutes: 5 })).toThrow();
  });
  it("infers rapid/deep requests and written minute budgets without an AI call", () => {
    expect(lectureStudySettings({ goal: "Study this in 20 minutes" }).mode).toBe("quick-review");
    expect(lectureStudySettings({ goal: "Give me a deep study session" }).mode).toBe("deep-study");
    expect(lectureStudySettings({ goal: "간단히 복습", availableMinutes: 60 }).mode).toBe("quick-review");
  });
  it("prioritizes demonstrated weakness and complex unknown concepts", () => {
    const targets = selectLectureTargets(state()); expect(targets.tutorTargets).toEqual(["Induction", "Strong Induction"]);
    expect(targets.difficulty).toBe("medium"); expect(targets.practiceTopics).toContain("Logic");
  });
  it("skips a separate Tutor in quick review", () => { const s = state(); s.mode = "quick-review"; expect(selectLectureTargets(s).tutorTargets).toEqual([]); });
  it("does not make all deep-study questions hard by default", () => { const s = state(); s.mode = "deep-study"; expect(selectLectureTargets(s).difficulty).toBe("medium"); s.requestedDifficulty = "hard"; expect(selectLectureTargets(s).difficulty).toBe("hard"); });
  it("reports supported weakness/improvement using actual before/after evidence", () => {
    const result = summarizeLecture(state(), [current()], { percentage: 100, correctAnswers: 6, totalQuestions: 6 });
    expect(result.improvedTopics).toEqual([{ topic: "Induction", previousMastery: 45, currentMastery: 60, confidence: 90 }]);
    expect(result.identifiedWeakTopics).toHaveLength(1); expect(result.recommendedWorkflowId).toBe("weak-topic-recovery");
  });
  it("distinguishes untested lecture concepts from low-confidence learning estimates", () => {
    const result = summarizeLecture(state(), [current()], { percentage: 100, correctAnswers: 6, totalQuestions: 6 });
    expect(result.notPracticedTopics).toEqual(["Logic", "Strong Induction"]);
    expect(result.insufficientEvidenceTopics).not.toContain("Logic");
  });
  it("does not call unknown, unsupported or unpracticed topics improved or definitively weak", () => {
    for (const t of [current({ id: "new", confidence: 20 }), current({ questionsAttempted: 20 }), current({ mastery: 47 })]) {
      expect(summarizeLecture(state(), [t], { percentage: 50, correctAnswers: 3, totalQuestions: 6 }).improvedTopics).toEqual([]);
    }
    expect(summarizeLecture(state(), [current({ confidence: 20 })], { percentage: 50, correctAnswers: 3, totalQuestions: 6 }).identifiedWeakTopics).toEqual([]);
  });
});
