import { describe, expect, it } from "vitest";
import { evaluateRecovery, recoveryEntry, recoveryQuizSettings, recoveryPriority, selectRecoveryTopic, shouldTutorAgain, RECOVERY_CONFIG } from "@/server/workflows/recovery-policy";
import type { RecoverySnapshot, RecoveryState } from "@/server/workflows/recovery-policy";
import type { LearningTopicSummary } from "@/server/learning/types";
const state = (mastery = 40, confidence = 80, extra: Partial<RecoverySnapshot> = {}): RecoverySnapshot => ({ mastery, confidence, recentAccuracy: 40, questionsAttempted: 20, lastPracticedAt: "2026-09-10T12:00:00Z", trend: "stable", ...extra });
function topic(id: string, mastery: number, confidence: number, extra: Partial<LearningTopicSummary> = {}): LearningTopicSummary {
  return { id, topic: id, courseId: "math", courseName: "Mathematics", courseCode: "MATH", practiceSessions: 4, evidence: "sufficient", status: "developing", ...state(mastery, confidence), ...extra };
}
const recovery = (extra: Partial<RecoveryState> = {}): RecoveryState => ({ topicId: "induction", topicName: "Induction", courseId: "math", startingState: state(), currentState: state(), entry: "tutor", tutorAttempts: 0, quizAttempts: 0, quizzes: [], evaluation: null, stop: false, ...extra });
describe("deterministic recovery policy", () => {
  it.each([[38, 88, "tutor"], [41, 22, "diagnostic"], [91, 95, "skip"], [91, 15, "diagnostic"]] as const)("mastery %s confidence %s starts with %s", (mastery, confidence, entry) => { expect(recoveryEntry(state(mastery, confidence))).toBe(entry); });
  it("uses trend and recent mistakes at medium mastery", () => {
    expect(recoveryEntry(state(65, 80, { recentAccuracy: 85 }))).toBe("practice");
    expect(recoveryEntry(state(65, 80, { trend: "declining", recentAccuracy: 85 }))).toBe("tutor");
    expect(recoveryEntry(state(65, 80, { recentAccuracy: 40 }))).toBe("tutor");
  });
  it("supports explicit high-mastery review without automatic remediation", () => { expect(recoveryEntry(state(95, 95), true)).toBe("review"); });
  it("does not infer reliable weakness from one answer", () => { expect(recoveryEntry(state(30, 80, { questionsAttempted: 1 }))).toBe("diagnostic"); });
  it.each([[70, 60, "recovered"], [64, 78, "improving"], [43, 88, "needs-more-practice"], [95, 25, "insufficient-evidence"]] as const)("evaluates mastery %s confidence %s as %s", (mastery, confidence, status) => {
    expect(evaluateRecovery(state(42, 78), state(mastery, confidence))).toEqual({ previousMastery: 42, currentMastery: mastery, previousConfidence: 78, currentConfidence: confidence, improvement: mastery - 42, status });
  });
  it("does not confirm recovery using only easy questions", () => { expect(evaluateRecovery(state(30), state(85), false).status).toBe("improving"); });
  it("ranks demonstrated weakness above a lower score with almost no evidence", () => { expect(selectRecoveryTopic([topic("uncertain", 5, 10), topic("induction", 42, 88)])?.id).toBe("induction"); });
  it("includes recent mistakes, trend and recency in ranking", () => {
    const basic = topic("basic", 40, 80);
    for (const changed of [{ recentAccuracy: 10 }, { trend: "declining" as const }, { lastPracticedAt: "2026-06-01T12:00:00Z" }, { confidence: 90 }]) {
      expect(recoveryPriority({ ...basic, ...changed }, new Date("2026-09-14"))).toBeGreaterThan(recoveryPriority(basic, new Date("2026-09-14")));
    }
  });
  it("falls back to diagnostics and leaves strong-only data alone", () => {
    expect(selectRecoveryTopic([topic("unknown", 50, 0)])?.id).toBe("unknown");
    expect(selectRecoveryTopic([topic("strong", 95, 90)])).toBeUndefined();
  });
  it("bounds quizzes and raises challenge beyond an easy warm-up", () => {
    expect(recoveryQuizSettings(recovery({ currentState: state(30) }))).toEqual({ mode: "practice", difficulty: "easy", count: 6 });
    expect(recoveryQuizSettings(recovery({ entry: "diagnostic" }))).toEqual({ mode: "diagnostic", difficulty: "medium", count: 5 });
    expect(recoveryQuizSettings(recovery({ quizAttempts: 1 }))).toEqual({ mode: "verification", difficulty: "medium", count: 5 });
    expect(recoveryQuizSettings(recovery({ quizAttempts: 1, currentState: state(75) })).difficulty).toBe("hard");
  });
  it("does not continue tutoring after improvement, insufficient evidence or the call limit", () => {
    for (const status of ["improving", "insufficient-evidence", "recovered"] as const) expect(shouldTutorAgain(recovery({ evaluation: { ...evaluateRecovery(state(), state()), status } }))).toBe(false);
    expect(shouldTutorAgain(recovery({ tutorAttempts: RECOVERY_CONFIG.maxTutorCalls, evaluation: evaluateRecovery(state(), state()) }))).toBe(false);
  });
});
