import type {
  AssistantAction,
  AssistantPendingInteraction,
  AssistantStudyTask,
  AssistantWorkflow,
} from "./types";

export function studyTaskStartAction(task: AssistantStudyTask): AssistantAction {
  const shared = {
    ...(task.courseId ? { courseId: task.courseId } : {}),
    ...(task.topicId ? { topicId: task.topicId } : {}),
    ...(task.topic ? { topicName: task.topic } : {}),
    ...(task.examId ? { examId: task.examId } : {}),
    ...(task.assignmentId ? { assignmentId: task.assignmentId } : {}),
  };
  if (task.activityType === "quiz" || task.activityType === "practice" || task.activityType === "mixed-practice") {
    return { id: `task-${task.id}-quiz`, label: "Start", targetType: "agent", targetId: "quiz", prompt: `Start this study task: ${task.title}. Create practice for ${task.topic ?? task.courseName ?? "the planned material"}.`, payload: shared, style: "primary" };
  }
  if (task.activityType === "notes-review") {
    return { id: `task-${task.id}-notes`, label: "Start", targetType: "agent", targetId: "notes", prompt: `Start this study task: ${task.title}. Prepare focused review notes.`, payload: shared, style: "primary" };
  }
  if (task.activityType === "exam-review" && task.examId) {
    return { id: `task-${task.id}-exam`, label: "Start", targetType: "workflow", targetId: "exam-preparation", prompt: `Start this exam review task: ${task.title}.`, payload: shared, style: "primary" };
  }
  if (task.activityType === "assignment" && task.assignmentId) {
    return { id: `task-${task.id}-assignment`, label: "Start", targetType: "workflow", targetId: "assignment-support", prompt: `Start this assignment task: ${task.title}.`, payload: shared, style: "primary" };
  }
  return { id: `task-${task.id}-tutor`, label: "Start", targetType: "agent", targetId: "tutor", prompt: `Start this study task: ${task.title}. Teach me ${task.topic ?? task.courseName ?? "the planned material"}.`, payload: shared, style: "primary" };
}

export function workflowPendingInteraction(workflow: AssistantWorkflow): AssistantPendingInteraction | null {
  if (workflow.pendingInteraction) return workflow.pendingInteraction;
  if (workflow.waitingFor?.kind === "student-work") {
    return {
      type: "long-text",
      title: "Add your current draft",
      description: "Your completed workflow steps are saved. Add your work to continue the same run.",
      requiredFields: ["response"],
      submitLabel: "Continue workflow",
      kind: "student-work",
    };
  }
  if (workflow.waitingFor?.kind === "career-data") {
    return {
      type: "long-text",
      title: "Add career evidence",
      description: "Share resume, project, or experience details. The workflow will continue from this checkpoint.",
      requiredFields: ["response"],
      submitLabel: "Continue workflow",
      kind: "career-data",
    };
  }
  if (workflow.waitingFor?.kind === "quiz") {
    return {
      type: "quiz",
      title: "Complete the checkpoint quiz",
      description: "Answer the quiz below to continue this workflow.",
      submitLabel: "Continue workflow",
    };
  }
  return null;
}
