import "server-only";
import { z } from "zod";
import { calculatePlanningSignals } from "../agents/study-planner/priority";
import type { AssignmentContext } from "../context/types";

const text = (max: number) => z.string().trim().min(1).max(max);
const requirement = z.object({ text: text(350), instructionQuote: text(600) }).strict();
export const assignmentAnalysisSchema = z.object({
  objective: text(700), objectiveQuote: text(600),
  deliverables: z.array(requirement).min(1).max(12), constraints: z.array(requirement).max(12),
  requiredConcepts: z.array(text(120)).max(12),
  subtasks: z.array(z.object({ title: text(200), deliverableIndices: z.array(z.number().int().min(0)).min(1).max(12),
    estimatedMinutes: z.number().int().min(5).max(480) }).strict()).min(1).max(12),
  nextAction: text(500),
}).strict().refine((a) => JSON.stringify(a).length <= 10000, "Keep reusable analysis bounded without omitting requirements.");
export type AssignmentAnalysis = z.infer<typeof assignmentAnalysisSchema>;
export const assignmentFeedbackSchema = z.object({
  strengths: z.array(text(600)).max(8), issues: z.array(text(600)).max(8),
  missingRequirements: z.array(z.object({ deliverableIndex: z.number().int().min(0), feedback: text(600) }).strict()).max(12),
  conceptualErrors: z.array(text(600)).max(8), suggestedImprovements: z.array(text(600)).min(1).max(8),
  nextAction: text(500), sourceIndices: z.array(z.number().int().min(0)).max(10),
}).strict();
export type AssignmentFeedback = Omit<z.infer<typeof assignmentFeedbackSchema>, "sourceIndices">;
export type AssignmentStage = "understand" | "plan" | "learn" | "work" | "review";
type AssignmentWorkBlock = { subtaskIndex: number; title: string; minutes: number; estimatedMinutes: number; partial: boolean; reason: string };
export function assignmentPath(input: { goal: string; specificQuestion?: string; userWork?: string; availableMinutes?: number }) {
  const request = `${input.goal} ${input.specificQuestion ?? ""}`.toLowerCase();
  const review = /check (?:my |this |the )?(?:answer|work|proof|code)|review (?:my |this |the )?(?:answer|work|draft|proof|code)|검토|채점|확인해/.test(request);
  const understandOnly = !review && /don.?t understand|do not understand|what .*asking|understand.*assignment|이해가 안|뭘.*하|요구사항/.test(request);
  const notes = !understandOnly && !review && /(?:review|summarize|condense).*formula|formulas? (?:review|sheet)|key definitions|condensed|(?:make|give|create|summarize|review).*notes|pre-assignment review|공식.*정리|요약|정리/.test(input.goal.toLowerCase());
  const targeted = Boolean(input.specificQuestion) || /question\s*\d|problem|solve|explain|concept|문제|설명|풀어/.test(request);
  const plan = !understandOnly && !review && (!targeted || /plan|steps|start|계획|시작/.test(request));
  const help = !understandOnly && !review && !notes && !/help me start|help starting|시작/.test(request) && (targeted || (input.availableMinutes ?? 60) >= 60 && !/break.*steps|plan only|계획만/.test(request));
  return { understandOnly, plan, notes, help, review, helpStage: (input.specificQuestion || /solve|problem|question\s*\d|문제|풀어/.test(request) ? "work" : "learn") as "learn" | "work",
    waitForDraft: review || help || (!understandOnly && !/break.*steps|plan only|계획만|help me start|help starting|시작/.test(request)) };
}
export function assignmentSignals(assignment: AssignmentContext, availableMinutes?: number, now = new Date()) {
  const hoursRemaining = Math.round((new Date(assignment.dueDate).getTime() - now.getTime()) / 3600000 * 10) / 10;
  const active = assignment.status !== "COMPLETED";
  const priority = calculatePlanningSignals({ assignments: active ? [assignment] : [], exams: [], startDate: now.toISOString().slice(0, 10), totalAvailableMinutes: availableMinutes ?? 60 })[0];
  return { hoursRemaining, overdue: active && hoursRemaining < 0, dueSoon: active && hoursRemaining >= 0 && hoursRemaining <= 48,
    notStarted: assignment.status === "TODO", estimatedMinutes: Math.ceil(assignment.estimatedHours * 60),
    highEstimatedEffort: assignment.estimatedHours >= 8, priorityScore: active ? priority.priorityScore : 0,
    priorityReason: active ? priority.reason : "Assignment is already marked completed; feedback does not change its status.",
    strategy: active && hoursRemaining <= 48 ? "essentials-first" as const : "steady-progress" as const,
    availableMinutes: availableMinutes ?? 60, availabilityAssumed: availableMinutes === undefined };
}
/** Keep estimates intact: a partial work block does not mean the subtask is done.
 * Reserve review time, preserve dependency order and expose all deferred work. */
export function assignmentWorkPlan(analysis: AssignmentAnalysis, signals: ReturnType<typeof assignmentSignals>, conceptHelp = false) {
  const budget = signals.availableMinutes;
  const preparationMinutes = Math.min(conceptHelp ? 15 : 5, Math.floor(budget * .25));
  const reviewMinutes = Math.min(10, Math.max(1, Math.floor(budget * .15)));
  let remaining = Math.max(0, budget - preparationMinutes - reviewMinutes);
  let unfinishedDependency = false;
  const blocks = analysis.subtasks.flatMap((task, subtaskIndex) => {
    const taskBlocks: AssignmentWorkBlock[] = [];
    if (unfinishedDependency) return taskBlocks;
    let taskRemaining = task.estimatedMinutes;
    while (remaining > 0 && taskRemaining > 0) {
      const minutes = Math.min(taskRemaining, remaining, signals.strategy === "essentials-first" ? 30 : 60);
      remaining -= minutes; taskRemaining -= minutes;
      taskBlocks.push({ subtaskIndex, title: task.title, minutes, estimatedMinutes: task.estimatedMinutes,
        partial: taskRemaining > 0, reason: signals.strategy === "essentials-first" ? "The deadline is close or overdue; check progress frequently while completing required deliverables in dependency order." : "Build the required deliverable before moving to the next subtask." });
    }
    unfinishedDependency = taskRemaining > 0;
    return taskBlocks;
  });
  return { blocks, preparationMinutes, reviewMinutes, unallocatedMinutes: remaining,
    totalMinutes: blocks.reduce((sum, b) => sum + b.minutes, 0) + preparationMinutes + reviewMinutes,
    deferredSubtasks: analysis.subtasks.map((t, i) => ({ title: t.title, subtaskIndex: i, remainingMinutes: t.estimatedMinutes - blocks.filter((b) => b.subtaskIndex === i).reduce((sum, b) => sum + b.minutes, 0) })).filter((t) => t.remainingMinutes > 0),
    assumption: signals.availabilityAssumed ? "Assume 60 minutes for this work session; estimates are provisional, not a promise to finish the assignment." : "This plan covers the available work session; unfinished subtasks remain visible.",
    nextAction: blocks.length ? `Start ${blocks[0].title} for ${blocks[0].minutes} minutes, then check progress against its requirement.` : "Use this short window to identify the first required deliverable." };
}
export type AssignmentState = {
  id: string; title: string; updatedAt: string;
  documents: { id: string; updatedAt: string }[];
  path: ReturnType<typeof assignmentPath>; signals: ReturnType<typeof assignmentSignals>;
  specificQuestion?: string; userWork?: string;
  analysis: AssignmentAnalysis | null; stage: AssignmentStage; nextAction: string;
};
export type AssignmentSupportResult = {
  assignmentId: string; stage: AssignmentStage; assignmentSummary: string;
  completedSteps: string[]; remainingSteps: string[]; feedback?: AssignmentFeedback;
  nextAction: string; recommendedAgent?: "tutor" | "notes";
};
