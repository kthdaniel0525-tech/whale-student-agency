import { describe, expect, it } from "vitest";
import { studyTaskStartAction, workflowPendingInteraction } from "@/features/student/assistant/interaction-contract";
import { buildAgentActions, buildWorkflowActions, parseSources, parseStructuredPresentation, serializeSources, serializeStructuredPresentation } from "@/server/assistant/presentation";
import type { AssistantStudyTask, AssistantWorkflow } from "@/features/student/assistant/types";

function task(activityType: string, extra: Partial<AssistantStudyTask> = {}): AssistantStudyTask {
  return {
    id: `task-${activityType}`,
    date: "2026-09-16",
    title: `Work on ${activityType}`,
    courseId: "course-one",
    courseName: "MATH 1240",
    topicId: "topic-one",
    topic: "Induction",
    examId: null,
    assignmentId: null,
    activityType,
    durationMinutes: 45,
    priority: 80,
    status: "planned",
    reason: "Induction needs practice.",
    ...extra,
  };
}

function workflow(overrides: Partial<AssistantWorkflow> = {}): AssistantWorkflow {
  return {
    runId: "run-one",
    workflowId: "assignment-support",
    status: "waiting-for-input",
    summary: "Add your draft.",
    completedSteps: ["understand"],
    steps: [{ stepId: "understand", agentId: "notes", status: "completed", outputSummary: "Requirements found.", errorCode: null }],
    warnings: [],
    errorCode: null,
    recommendedNextAction: "Add your draft.",
    waitingFor: { kind: "student-work", referenceId: "assignment-one" },
    ...overrides,
  };
}

describe("interactive Agent and Workflow contracts", () => {
  it("routes Tutor and Notes follow-ups through registered Agents", () => {
    const tutor = buildAgentActions("tutor");
    const notes = buildAgentActions("notes", undefined, { courseId: "course-one", documentIds: ["document-one"] });
    expect(tutor.map((item) => [item.label, item.targetId])).toEqual(expect.arrayContaining([["Explain more simply", "tutor"], ["Test my understanding", "quiz"]]));
    expect(notes).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Turn into quiz", targetId: "quiz", payload: { courseId: "course-one", documentIds: ["document-one"] } })]));
  });

  it("uses backend Academic Manager actions instead of rebuilding priorities in UI", () => {
    const actions = buildAgentActions("academic-manager", {
      recommendedActions: [
        { action: "Review Induction", reason: "The exam is close.", agentId: "tutor", courseId: "course-one" },
        { action: "Unknown action", reason: "No registered target.", agentId: null },
      ],
    });
    expect(actions).toEqual([expect.objectContaining({ label: "Review Induction", targetType: "agent", targetId: "tutor", payload: { courseId: "course-one" } })]);
  });

  it("maps study activity metadata to existing Agent and Workflow targets", () => {
    expect(studyTaskStartAction(task("learn"))).toMatchObject({ targetType: "agent", targetId: "tutor" });
    expect(studyTaskStartAction(task("quiz"))).toMatchObject({ targetType: "agent", targetId: "quiz" });
    expect(studyTaskStartAction(task("notes-review"))).toMatchObject({ targetType: "agent", targetId: "notes" });
    expect(studyTaskStartAction(task("exam-review", { examId: "exam-one" }))).toMatchObject({ targetType: "workflow", targetId: "exam-preparation", payload: { examId: "exam-one" } });
    expect(studyTaskStartAction(task("assignment", { assignmentId: "assignment-one" }))).toMatchObject({ targetType: "workflow", targetId: "assignment-support", payload: { assignmentId: "assignment-one" } });
  });

  it("normalizes existing Workflow checkpoints into a generic pending interaction", () => {
    expect(workflowPendingInteraction(workflow())).toMatchObject({ type: "long-text", kind: "student-work", submitLabel: "Continue workflow" });
    expect(workflowPendingInteraction(workflow({ waitingFor: { kind: "quiz", referenceId: "quiz-one" } }))).toMatchObject({ type: "quiz" });
    expect(workflowPendingInteraction(workflow({ waitingFor: { kind: "career-data", referenceId: "career-one" } }))).toMatchObject({ type: "long-text", kind: "career-data" });
  });

  it("offers completion actions only after a Workflow has completed", () => {
    expect(buildWorkflowActions(workflow())).toEqual([]);
    expect(buildWorkflowActions(workflow({ status: "completed", waitingFor: null }))).toEqual([expect.objectContaining({ targetId: "tutor" })]);
  });

  it("round-trips bounded sources and non-canonical structured results without AI", () => {
    const sources = [{ documentId: "document-one", documentTitle: "Lecture", pageNumber: 2, pageEnd: 3, courseCode: "MATH", chunkIndex: 0 }];
    expect(parseSources(serializeSources(sources))).toEqual(sources);
    const notes = { title: "Logic", concepts: [{ topic: "Statements", notes: "A proposition has a truth value." }] };
    expect(parseStructuredPresentation(serializeStructuredPresentation("notes", notes))).toEqual(notes);
    expect(serializeStructuredPresentation("quiz", notes)).toBeUndefined();
  });
});
