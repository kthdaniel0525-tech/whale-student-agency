import "server-only";
import type { UserContext } from "../../context/types";
import type {
  CurrentPlanTask,
  PlanningChanges,
  PlanningContextIndex,
} from "./types";

function dateOnly(value: Date | string): string {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

export function createPlanningContextIndex(
  context: UserContext,
): PlanningContextIndex {
  const topics = new Map();
  if (context.learning) {
    for (const topic of [
      ...context.learning.recommendedTopics,
      ...context.learning.weakTopics,
      ...context.learning.strongTopics,
    ]) {
      if (!topics.has(topic.topicId)) topics.set(topic.topicId, topic);
    }
  }
  return {
    assignments: new Map(
      (context.assignments ?? []).map((assignment) => [assignment.id, assignment]),
    ),
    exams: new Map((context.exams ?? []).map((exam) => [exam.id, exam])),
    topics,
  };
}

/** Compares stored snapshots with the compact current Context Builder output. */
export function calculatePlanningChanges(
  tasks: readonly CurrentPlanTask[],
  context: UserContext,
  startDate: string,
  remainingMinutes: number,
): PlanningChanges {
  const index = createPlanningContextIndex(context);
  const missedTasks = tasks
    .filter(
      (task) =>
        (task.status === "PLANNED" || task.status === "IN_PROGRESS") &&
        dateOnly(task.date) < startDate,
    )
    .map((task) => ({
      id: task.id,
      title: task.title,
      date: dateOnly(task.date),
      durationMinutes: task.durationMinutes,
    }))
    .slice(0, 20);
  const completedTasks = tasks
    .filter((task) => task.status === "COMPLETED")
    .map((task) => ({
      id: task.id,
      title: task.title,
      date: dateOnly(task.date),
      durationMinutes: task.durationMinutes,
    }))
    .slice(-20);
  const changedDeadlines = tasks.flatMap((task) => {
    const current = task.examId
      ? index.exams.get(task.examId)?.examDate
      : task.assignmentId
        ? index.assignments.get(task.assignmentId)?.dueDate
        : undefined;
    if (
      !current ||
      !task.sourceDueDate ||
      dateOnly(current) === dateOnly(task.sourceDueDate)
    ) {
      return [];
    }
    return [
      {
        taskId: task.id,
        title: task.title,
        previousDate: dateOnly(task.sourceDueDate),
        currentDate: dateOnly(current),
      },
    ];
  });
  const masteryChanges = tasks.flatMap((task) => {
    if (!task.topicId || task.sourceMasteryScore === null) return [];
    const current = index.topics.get(task.topicId);
    if (!current || Math.abs(current.mastery - task.sourceMasteryScore) < 3) {
      return [];
    }
    return [
      {
        taskId: task.id,
        topic: current.topic,
        previousMastery: Math.round(task.sourceMasteryScore),
        currentMastery: Math.round(current.mastery),
        previousConfidence: Math.round(task.sourceConfidenceScore ?? 0),
        currentConfidence: Math.round(current.confidence),
      },
    ];
  });
  return {
    missedTasks,
    completedTasks,
    changedDeadlines: changedDeadlines.slice(0, 20),
    masteryChanges: masteryChanges.slice(0, 20),
    remainingMinutes,
  };
}
