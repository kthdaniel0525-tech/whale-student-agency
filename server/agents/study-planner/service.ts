import "server-only";
import { auth } from "../../auth/config";
import { db } from "../../db/client";
import { observeStudyTaskOutcome } from "../../memory";
import { recordAdaptiveOutcome } from "../../adaptive";
import { refreshRecommendationsBestEffort } from "../../recommendations";
import { AgentExecutor } from "../executor";
import type { AgentExecutorOptions } from "../executor";
import type { AgentRegistry } from "../registry";
import { AgentRouter } from "../router";
import type { AgentRouterOptions } from "../router";
import { createStudentAgentRegistry } from "../student-service";
import { STUDY_PLANNER_INSTRUCTIONS } from "./instructions";
import { createPlanningBrief } from "./priority";
import { calculatePlanningChanges } from "./replanning";
import {
  generatedStudyPlanSchema,
  studyNowRequestSchema,
  studyPlanRequestSchema,
  studyPlanUpdateRequestSchema,
  studyTaskStatusSchema,
  type GeneratedStudyPlan,
} from "./schemas";
import type {
  CurrentPlanTask,
  PlanningBrief,
  PlanningChanges,
  PlanningSignal,
  StoredStudyPlan,
  StoredStudyTask,
  StudyActivityType,
  StudyNowRecommendation,
  StudyNowRequest,
  StudyPlanRequest,
  StudyPlanUpdateRequest,
  StudyPlannerAgentErrorCode,
  StudyTaskStatus,
} from "./types";

export interface StudyPlannerAgentServiceOptions {
  readonly router?: AgentRouterOptions;
  readonly executor?: AgentExecutorOptions;
}

const errorMessages: Record<StudyPlannerAgentErrorCode, string> = {
  INVALID_REQUEST: "Check the planning request, dates, availability, and session length.",
  UNAUTHENTICATED: "Sign in to use study planning.",
  AUTHENTICATION_FAILURE: "Authentication could not be verified. Try again later.",
  NOT_STUDY_PLANNER_REQUEST: "This request was not selected for the Study Planner.",
  PLAN_NOT_FOUND: "This study plan was not found.",
  TASK_NOT_FOUND: "This study task was not found.",
  NO_AVAILABILITY: "Provide at least 15 available minutes in the planning range.",
  INVALID_PLAN_RESPONSE: "The generated study plan was invalid. Try again.",
  STORAGE_FAILURE: "The study plan could not be saved or loaded. Try again later.",
};

export class StudyPlannerAgentError extends Error {
  constructor(readonly code: StudyPlannerAgentErrorCode) {
    super(errorMessages[code]);
    this.name = "StudyPlannerAgentError";
  }
}

const activityToDatabase = {
  learn: "LEARN",
  review: "REVIEW",
  practice: "PRACTICE",
  quiz: "QUIZ",
  assignment: "ASSIGNMENT",
  "exam-review": "EXAM_REVIEW",
  "notes-review": "NOTES_REVIEW",
  "mixed-practice": "MIXED_PRACTICE",
} as const;
const activityFromDatabase = Object.fromEntries(
  Object.entries(activityToDatabase).map(([key, value]) => [value, key]),
) as Record<(typeof activityToDatabase)[StudyActivityType], StudyActivityType>;
const taskStatusToDatabase = {
  planned: "PLANNED",
  "in-progress": "IN_PROGRESS",
  completed: "COMPLETED",
  skipped: "SKIPPED",
} as const;
const taskStatusFromDatabase = Object.fromEntries(
  Object.entries(taskStatusToDatabase).map(([key, value]) => [value, key]),
) as Record<(typeof taskStatusToDatabase)[StudyTaskStatus], StudyTaskStatus>;
const planStatusFromDatabase = {
  ACTIVE: "active",
  COMPLETED: "completed",
  ARCHIVED: "archived",
} as const;

type DatabaseTask = {
  id: string;
  date: Date;
  title: string;
  courseId: string | null;
  topicId: string | null;
  topic: string | null;
  examId: string | null;
  assignmentId: string | null;
  activityType: keyof typeof activityFromDatabase;
  durationMinutes: number;
  priority: number;
  status: keyof typeof taskStatusFromDatabase;
  reason: string;
  sourceDueDate: Date | null;
  sourceMasteryScore: number | null;
  sourceConfidenceScore: number | null;
  course: { courseCode: string; courseName: string } | null;
};

type DatabasePlan = {
  id: string;
  title: string;
  startDate: Date;
  endDate: Date;
  summary: string;
  assumptions: string[];
  totalPlannedMinutes: number;
  status: keyof typeof planStatusFromDatabase;
  tasks: DatabaseTask[];
};

function dateOnly(value: Date | string): string {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

function databaseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function planningDocumentsRequested(
  request: string,
  documentIds: readonly string[] | undefined,
): boolean {
  return Boolean(documentIds?.length) ||
    /\b(?:based on|using|from)\s+(?:my\s+)?(?:lecture|class|course|uploaded|document|pdf|notes?)\b|\blecture coverage\b|\bcovered in (?:class|lecture)\b/i.test(
      request,
    );
}

function currentTask(task: DatabaseTask): CurrentPlanTask {
  return {
    id: task.id,
    date: task.date,
    title: task.title,
    topicId: task.topicId,
    topic: task.topic,
    examId: task.examId,
    assignmentId: task.assignmentId,
    durationMinutes: task.durationMinutes,
    status: task.status,
    sourceDueDate: task.sourceDueDate,
    sourceMasteryScore: task.sourceMasteryScore,
    sourceConfidenceScore: task.sourceConfidenceScore,
  };
}

function validateGeneratedPlan(plan: GeneratedStudyPlan, brief: PlanningBrief): void {
  if (plan.startDate !== brief.startDate || plan.endDate !== brief.endDate) {
    throw new StudyPlannerAgentError("INVALID_PLAN_RESPONSE");
  }
  const availability = new Map(
    brief.availability.map((item) => [item.date, item.availableMinutes]),
  );
  const signals = new Map(brief.signals.map((signal) => [signal.id, signal]));
  for (const day of plan.days) {
    if (
      day.date < brief.startDate ||
      day.date > brief.endDate ||
      day.totalMinutes > (availability.get(day.date) ?? 0)
    ) {
      throw new StudyPlannerAgentError("INVALID_PLAN_RESPONSE");
    }
    for (const session of day.sessions) {
      const signal = signals.get(session.signalId);
      if (
        !signal ||
        session.durationMinutes > brief.maximumSessionMinutes ||
        !signal.allowedActivities.includes(session.activityType)
      ) {
        throw new StudyPlannerAgentError("INVALID_PLAN_RESPONSE");
      }
    }
  }
  if (plan.totalPlannedMinutes > brief.totalAvailableMinutes) {
    throw new StudyPlannerAgentError("INVALID_PLAN_RESPONSE");
  }
  if (brief.mode === "now" && (plan.days.length !== 1 || plan.days[0].sessions.length > 3)) {
    throw new StudyPlannerAgentError("INVALID_PLAN_RESPONSE");
  }
  const horizonDays =
    Math.round(
      (databaseDate(brief.endDate).getTime() -
        databaseDate(brief.startDate).getTime()) /
        86_400_000,
    ) + 1;
  const finalMinutes =
    plan.days.find((day) => day.date === brief.endDate)?.totalMinutes ?? 0;
  if (
    horizonDays >= 4 &&
    plan.totalPlannedMinutes > 240 &&
    finalMinutes > plan.totalPlannedMinutes * 0.5
  ) {
    throw new StudyPlannerAgentError("INVALID_PLAN_RESPONSE");
  }
}

function materializedTasks(plan: GeneratedStudyPlan, brief: PlanningBrief) {
  const signals = new Map(brief.signals.map((signal) => [signal.id, signal]));
  return plan.days.flatMap((day) =>
    day.sessions.map((session) => {
      const signal = signals.get(session.signalId);
      if (!signal) throw new StudyPlannerAgentError("INVALID_PLAN_RESPONSE");
      return {
        date: databaseDate(day.date),
        title: session.title,
        courseId: signal.courseId,
        topicId: signal.topicId,
        topic: signal.topic,
        examId: signal.linkedExamId,
        assignmentId: signal.linkedAssignmentId,
        activityType: activityToDatabase[session.activityType],
        durationMinutes: session.durationMinutes,
        priority: signal.priorityScore,
        reason: signal.reason.slice(0, 500),
        sourceDueDate: signal.sourceDueDate
          ? new Date(signal.sourceDueDate)
          : null,
        sourceMasteryScore: signal.sourceMasteryScore,
        sourceConfidenceScore: signal.sourceConfidenceScore,
      };
    }),
  );
}

function currentPlanSignals(
  tasks: readonly DatabaseTask[],
  startDate: string,
): PlanningSignal[] {
  return tasks.map((task) => {
    const scheduledToday = dateOnly(task.date) <= startDate;
    const score = Math.max(task.priority, scheduledToday ? 95 : 60);
    const activity = activityFromDatabase[task.activityType];
    return {
      id: `planned-task:${task.id}`,
      kind: "general",
      courseId: task.courseId,
      courseName: task.course
        ? `${task.course.courseCode} ${task.course.courseName}`.trim()
        : null,
      topicId: task.topicId,
      topic: task.topic,
      linkedExamId: task.examId,
      linkedAssignmentId: task.assignmentId,
      priorityScore: score,
      priority:
        score >= 80 ? "urgent" : score >= 60 ? "high" : score >= 35 ? "medium" : "low",
      urgency: scheduledToday ? 100 : 60,
      weakness: task.sourceMasteryScore === null ? 0 : 100 - task.sourceMasteryScore,
      confidenceNeed:
        task.sourceConfidenceScore === null ? 0 : 100 - task.sourceConfidenceScore,
      trend: 0,
      staleness: 0,
      importance: task.priority,
      suggestedActivity: activity,
      allowedActivities: [activity],
      reason: `Continue the current plan: ${task.reason}`.slice(0, 500),
      sourceDueDate: task.sourceDueDate?.toISOString() ?? null,
      sourceMasteryScore: task.sourceMasteryScore,
      sourceConfidenceScore: task.sourceConfidenceScore,
      targetMinutes: task.durationMinutes,
    } satisfies PlanningSignal;
  });
}

function publicTask(task: DatabaseTask): StoredStudyTask {
  return {
    id: task.id,
    date: dateOnly(task.date),
    title: task.title,
    courseId: task.courseId,
    courseName: task.course
      ? `${task.course.courseCode} ${task.course.courseName}`.trim()
      : null,
    topicId: task.topicId,
    topic: task.topic,
    examId: task.examId,
    assignmentId: task.assignmentId,
    activityType: activityFromDatabase[task.activityType],
    durationMinutes: task.durationMinutes,
    priority: task.priority,
    status: taskStatusFromDatabase[task.status],
    reason: task.reason,
  };
}

function publicPlan(
  plan: DatabasePlan,
  metadata: StoredStudyPlan["metadata"] = {},
): StoredStudyPlan {
  const byDate = new Map<string, StoredStudyTask[]>();
  for (const task of plan.tasks) {
    const value = publicTask(task);
    const tasks = byDate.get(value.date) ?? [];
    tasks.push(value);
    byDate.set(value.date, tasks);
  }
  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sessions]) => ({
      date,
      totalMinutes: sessions
        .filter((task) => task.status !== "skipped")
        .reduce((sum, task) => sum + task.durationMinutes, 0),
      sessions: sessions.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)),
    }));
  return {
    id: plan.id,
    title: plan.title,
    startDate: dateOnly(plan.startDate),
    endDate: dateOnly(plan.endDate),
    summary: plan.summary,
    assumptions: plan.assumptions,
    totalPlannedMinutes: plan.totalPlannedMinutes,
    status: planStatusFromDatabase[plan.status],
    days,
    metadata,
  };
}

function directive(brief: PlanningBrief): string {
  const result = JSON.stringify(brief);
  if (result.length > 12_000) {
    throw new StudyPlannerAgentError("INVALID_REQUEST");
  }
  return result;
}

/** Coordinates Context Builder, AgentExecutor, validation and owned plan storage. */
export class StudyPlannerAgentService {
  readonly #router: AgentRouter;
  readonly #executor: AgentExecutor;

  constructor(registry: AgentRegistry, options: StudyPlannerAgentServiceOptions = {}) {
    this.#router = new AgentRouter(registry, options.router);
    this.#executor = new AgentExecutor(registry, {
      ...options.executor,
      instructions: {
        "study-planner": STUDY_PLANNER_INSTRUCTIONS,
        ...options.executor?.instructions,
      },
    });
  }

  async createPlan(
    rawInput: StudyPlanRequest,
    requestHeaders: Headers,
  ): Promise<StoredStudyPlan> {
    const parsed = studyPlanRequestSchema.safeParse(rawInput);
    if (!parsed.success) throw new StudyPlannerAgentError("INVALID_REQUEST");
    const { userId, headers } = await this.authenticate(requestHeaders);
    await this.ensurePlannerRoute(parsed.data.request);
    let brief: PlanningBrief | undefined;
    const execution = await this.#executor.executeStructured(
      {
        agentId: "study-planner",
        request: parsed.data.request,
        ...(parsed.data.conversation ? { conversation: parsed.data.conversation } : {}),
        ...(parsed.data.examId ? { examId: parsed.data.examId } : {}),
        ...(parsed.data.courseId ? { courseId: parsed.data.courseId } : {}),
        ...(parsed.data.documentIds ? { documentIds: parsed.data.documentIds } : {}),
      },
      headers,
      {
        schemaName: "study_plan",
        schema: generatedStudyPlanSchema,
        maxOutputTokens: 4096,
        ...(planningDocumentsRequested(parsed.data.request, parsed.data.documentIds)
          ? { contextOverrides: { documents: true, limits: { documents: 5 } } }
          : {}),
        buildDirective(context, personalization, adaptiveStrategy) {
          brief = createPlanningBrief(context, { mode: "create", ...parsed.data }, personalization, adaptiveStrategy);
          if (brief.totalAvailableMinutes < 15) {
            throw new StudyPlannerAgentError("NO_AVAILABILITY");
          }
          return directive(brief);
        },
      },
    );
    if (!brief || !execution.structuredData) {
      throw new StudyPlannerAgentError("INVALID_PLAN_RESPONSE");
    }
    validateGeneratedPlan(execution.structuredData, brief);
    const tasks = materializedTasks(execution.structuredData, brief);
    try {
      const saved = await db().studyPlan.create({
        data: {
          userId,
          title: execution.structuredData.title,
          startDate: databaseDate(brief.startDate),
          endDate: databaseDate(brief.endDate),
          summary: execution.structuredData.summary,
          assumptions: [...brief.assumptions],
          totalPlannedMinutes: execution.structuredData.totalPlannedMinutes,
          tasks: {
            // The composite parent relation supplies both studyPlanId and userId.
            create: tasks,
          },
        },
        include: {
          tasks: { include: { course: true }, orderBy: [{ date: "asc" }, { priority: "desc" }] },
        },
      });
      return publicPlan(saved as DatabasePlan, {
        model: execution.metadata?.model,
        usage: execution.metadata?.usage,
        durationMs: execution.metadata?.durationMs,
      });
    } catch (error) {
      if (error instanceof StudyPlannerAgentError) throw error;
      throw new StudyPlannerAgentError("STORAGE_FAILURE");
    }
  }

  async updatePlan(
    rawInput: StudyPlanUpdateRequest,
    requestHeaders: Headers,
  ): Promise<StoredStudyPlan> {
    const parsed = studyPlanUpdateRequestSchema.safeParse(rawInput);
    if (!parsed.success) throw new StudyPlannerAgentError("INVALID_REQUEST");
    const { userId, headers } = await this.authenticate(requestHeaders);
    await this.ensurePlannerRoute(parsed.data.request);
    const existing = await this.loadOwnedPlan(parsed.data.planId, userId);
    // An explicitly scoped exam update must not replace another exam's sessions.
    const retained = existing.tasks.filter((task) => parsed.data.examId && task.examId !== parsed.data.examId && ["PLANNED", "IN_PROGRESS"].includes(task.status));
    let brief: PlanningBrief | undefined;
    let changes: PlanningChanges | undefined;
    const execution = await this.#executor.executeStructured(
      {
        agentId: "study-planner",
        request: parsed.data.request,
        ...(parsed.data.conversation ? { conversation: parsed.data.conversation } : {}),
        ...(parsed.data.examId ? { examId: parsed.data.examId } : {}),
        ...(parsed.data.courseId ? { courseId: parsed.data.courseId } : {}),
        ...(parsed.data.documentIds ? { documentIds: parsed.data.documentIds } : {}),
      },
      headers,
      {
        schemaName: "study_plan_update",
        schema: generatedStudyPlanSchema,
        maxOutputTokens: 4096,
        ...(planningDocumentsRequested(parsed.data.request, parsed.data.documentIds)
          ? { contextOverrides: { documents: true, limits: { documents: 5 } } }
          : {}),
        buildDirective(context, personalization, adaptiveStrategy) {
          const planningContext = retained.length ? { ...context, assignments: context.assignments?.filter((assignment) => !retained.some((task) => task.assignmentId === assignment.id)) } : context;
          const initial = createPlanningBrief(planningContext, { mode: "update", ...parsed.data }, personalization, adaptiveStrategy);
          const reservedMinutesByDate: Record<string, number> = {};
          for (const task of existing.tasks) {
            if (
              (task.status === "COMPLETED" || retained.some((item) => item.id === task.id)) &&
              dateOnly(task.date) >= initial.startDate &&
              dateOnly(task.date) <= initial.endDate
            ) {
              reservedMinutesByDate[dateOnly(task.date)] =
                (reservedMinutesByDate[dateOnly(task.date)] ?? 0) + task.durationMinutes;
            }
          }
          const rebuilt = createPlanningBrief(planningContext, {
            mode: "update",
            ...parsed.data,
            reservedMinutesByDate,
          }, personalization, adaptiveStrategy);
          changes = calculatePlanningChanges(
            existing.tasks.map(currentTask),
            context,
            rebuilt.startDate,
            rebuilt.totalAvailableMinutes,
          );
          brief = { ...rebuilt, changes };
          if (brief.totalAvailableMinutes < 15) {
            throw new StudyPlannerAgentError("NO_AVAILABILITY");
          }
          return directive(brief);
        },
      },
    );
    if (!brief || !changes || !execution.structuredData) {
      throw new StudyPlannerAgentError("INVALID_PLAN_RESPONSE");
    }
    const validatedBrief = brief;
    const generated = execution.structuredData;
    validateGeneratedPlan(generated, validatedBrief);
    const tasks = materializedTasks(generated, validatedBrief);
    try {
      const saved = await db().$transaction(async (transaction) => {
        const stillOwned = await transaction.studyPlan.findFirst({
          where: { id: existing.id, userId },
          select: { id: true },
        });
        if (!stillOwned) throw new StudyPlannerAgentError("PLAN_NOT_FOUND");
        await transaction.studyTask.updateMany({
          where: {
            studyPlanId: existing.id,
            userId,
            ...(parsed.data.examId ? { examId: parsed.data.examId } : {}),
            status: { in: ["PLANNED", "IN_PROGRESS"] },
          },
          data: { status: "SKIPPED" },
        });
        await transaction.studyTask.createMany({
          data: tasks.map((task) => ({
            userId,
            studyPlanId: existing.id,
            ...task,
          })),
        });
        const active = await transaction.studyTask.aggregate({
          where: { studyPlanId: existing.id, userId, status: { not: "SKIPPED" } },
          _sum: { durationMinutes: true },
        });
        const completedDates = existing.tasks
          .filter((task) => task.status === "COMPLETED" || retained.some((item) => item.id === task.id))
          .map((task) => dateOnly(task.date));
        const startDate = [validatedBrief.startDate, ...completedDates].sort()[0];
        const endDate = [validatedBrief.endDate, ...completedDates].sort().at(-1)!;
        await transaction.studyPlan.update({
          where: { id_userId: { id: existing.id, userId } },
          data: {
            title: generated.title,
            startDate: databaseDate(startDate),
            endDate: databaseDate(endDate),
            summary: generated.summary,
            assumptions: [...validatedBrief.assumptions],
            totalPlannedMinutes: active._sum.durationMinutes ?? 0,
            status: "ACTIVE",
          },
        });
        return transaction.studyPlan.findUniqueOrThrow({
          where: { id_userId: { id: existing.id, userId } },
          include: {
            tasks: { include: { course: true }, orderBy: [{ date: "asc" }, { priority: "desc" }] },
          },
        });
      });
      return publicPlan(saved as DatabasePlan, {
        model: execution.metadata?.model,
        usage: execution.metadata?.usage,
        durationMs: execution.metadata?.durationMs,
      });
    } catch (error) {
      if (error instanceof StudyPlannerAgentError) throw error;
      throw new StudyPlannerAgentError("STORAGE_FAILURE");
    }
  }

  async recommendNow(
    rawInput: StudyNowRequest,
    requestHeaders: Headers,
  ): Promise<StudyNowRecommendation> {
    const parsed = studyNowRequestSchema.safeParse(rawInput);
    if (!parsed.success) throw new StudyPlannerAgentError("INVALID_REQUEST");
    const { userId, headers } = await this.authenticate(requestHeaders);
    await this.ensurePlannerRoute(parsed.data.request);
    const currentTasks = await this.loadCurrentTasks(userId);
    let brief: PlanningBrief | undefined;
    const execution = await this.#executor.executeStructured(
      {
        agentId: "study-planner",
        request: parsed.data.request,
        ...(parsed.data.conversation ? { conversation: parsed.data.conversation } : {}),
        ...(parsed.data.courseId ? { courseId: parsed.data.courseId } : {}),
        ...(parsed.data.documentIds ? { documentIds: parsed.data.documentIds } : {}),
      },
      headers,
      {
        schemaName: "study_now",
        schema: generatedStudyPlanSchema,
        maxOutputTokens: 1536,
        ...(planningDocumentsRequested(parsed.data.request, parsed.data.documentIds)
          ? { contextOverrides: { documents: true, limits: { documents: 5 } } }
          : {}),
        buildDirective(context, personalization, adaptiveStrategy) {
          const base = createPlanningBrief(context, { mode: "now", ...parsed.data }, personalization, adaptiveStrategy);
          const signals = [
            ...currentPlanSignals(currentTasks, base.startDate),
            ...base.signals,
          ]
            .sort(
              (a, b) =>
                b.priorityScore - a.priorityScore || a.id.localeCompare(b.id),
            )
            .slice(0, 5);
          brief = { ...base, signals };
          if (brief.totalAvailableMinutes < 15) {
            throw new StudyPlannerAgentError("NO_AVAILABILITY");
          }
          return directive(brief);
        },
      },
    );
    if (!brief || !execution.structuredData) {
      throw new StudyPlannerAgentError("INVALID_PLAN_RESPONSE");
    }
    validateGeneratedPlan(execution.structuredData, brief);
    const signals = new Map(brief.signals.map((signal) => [signal.id, signal]));
    const sessions = execution.structuredData.days[0].sessions.map((session) => {
      const signal = signals.get(session.signalId) as PlanningSignal;
      return {
        date: brief!.startDate,
        title: session.title,
        courseId: signal.courseId,
        courseName: signal.courseName,
        topicId: signal.topicId,
        topic: signal.topic,
        examId: signal.linkedExamId,
        assignmentId: signal.linkedAssignmentId,
        activityType: session.activityType,
        durationMinutes: session.durationMinutes,
        priority: signal.priorityScore,
        reason: signal.reason,
      };
    });
    return {
      date: brief.startDate,
      summary: execution.structuredData.summary,
      totalMinutes: execution.structuredData.totalPlannedMinutes,
      sessions,
      assumptions: brief.assumptions,
    };
  }

  async getPlan(planId: string, requestHeaders: Headers): Promise<StoredStudyPlan> {
    if (!planId || planId.length > 100) {
      throw new StudyPlannerAgentError("INVALID_REQUEST");
    }
    const { userId } = await this.authenticate(requestHeaders);
    return publicPlan(await this.loadOwnedPlan(planId, userId));
  }

  /** Resolves the most recently updated active plan for natural-language
   * workspace replanning without trusting a client-supplied user identity. */
  async getCurrentPlan(
    requestHeaders: Headers,
    courseId?: string,
  ): Promise<StoredStudyPlan | undefined> {
    const { userId } = await this.authenticate(requestHeaders);
    const plan = await db().studyPlan.findFirst({
      where: {
        userId,
        status: "ACTIVE",
        ...(courseId ? { tasks: { some: { userId, courseId } } } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      include: {
        tasks: {
          include: { course: true },
          orderBy: [{ date: "asc" }, { priority: "desc" }],
        },
      },
    });
    return plan ? publicPlan(plan as DatabasePlan) : undefined;
  }

  async updateTaskStatus(
    taskId: string,
    status: StudyTaskStatus,
    requestHeaders: Headers,
  ): Promise<StoredStudyPlan> {
    const parsed = studyTaskStatusSchema.safeParse(status);
    if (!taskId || taskId.length > 100 || !parsed.success) {
      throw new StudyPlannerAgentError("INVALID_REQUEST");
    }
    const { userId } = await this.authenticate(requestHeaders);
    try {
      const outcome = await db().$transaction(async (transaction) => {
        const task = await transaction.studyTask.findFirst({
          where: { id: taskId, userId, studyPlan: { userId } },
          select: { studyPlanId: true, durationMinutes: true, courseId: true, topicId: true },
        });
        if (!task) throw new StudyPlannerAgentError("TASK_NOT_FOUND");
        await transaction.studyTask.update({
          where: { id: taskId },
          data: { status: taskStatusToDatabase[parsed.data] },
        });
        const [remaining, completed, total] = await Promise.all([
          transaction.studyTask.count({
            where: {
              studyPlanId: task.studyPlanId,
              userId,
              status: { in: ["PLANNED", "IN_PROGRESS"] },
            },
          }),
          transaction.studyTask.count({
            where: { studyPlanId: task.studyPlanId, userId, status: "COMPLETED" },
          }),
          transaction.studyTask.aggregate({
            where: { studyPlanId: task.studyPlanId, userId, status: { not: "SKIPPED" } },
            _sum: { durationMinutes: true },
          }),
        ]);
        await transaction.studyPlan.update({
          where: { id_userId: { id: task.studyPlanId, userId } },
          data: {
            status: remaining === 0 && completed > 0 ? "COMPLETED" : "ACTIVE",
            totalPlannedMinutes: total._sum.durationMinutes ?? 0,
          },
        });
        return {
          planId: task.studyPlanId,
          durationMinutes: task.durationMinutes,
          courseId: task.courseId,
          topicId: task.topicId,
        };
      });
      if (parsed.data === "completed" || parsed.data === "skipped") {
        try {
          await observeStudyTaskOutcome({
            userId,
            taskId,
            durationMinutes: outcome.durationMinutes,
            status: parsed.data,
          });
          await recordAdaptiveOutcome({
            userId,
            agentId: "study-planner",
            ...(outcome.courseId ? { courseId: outcome.courseId } : {}),
            ...(outcome.topicId ? { topicId: outcome.topicId } : {}),
            strategyKey: `study-session:${outcome.durationMinutes}`,
            strategy: { recommendedSessionMinutes: outcome.durationMinutes },
            outcomeType:
              parsed.data === "completed"
                ? "study-task-completed"
                : "study-task-skipped",
            successful: parsed.data === "completed",
            evidenceKey: `study-task:${taskId}:${parsed.data}`,
          });
        } catch {
          // Personalization evidence is optional and must never make a valid
          // study-task update fail.
        }
        await refreshRecommendationsBestEffort(userId);
      }
      return publicPlan(await this.loadOwnedPlan(outcome.planId, userId));
    } catch (error) {
      if (error instanceof StudyPlannerAgentError) throw error;
      throw new StudyPlannerAgentError("STORAGE_FAILURE");
    }
  }

  private async ensurePlannerRoute(request: string): Promise<void> {
    const routing = await this.#router.routeAgent({ request });
    if (routing.agentId !== "study-planner") {
      throw new StudyPlannerAgentError("NOT_STUDY_PLANNER_REQUEST");
    }
  }

  private async loadOwnedPlan(planId: string, userId: string): Promise<DatabasePlan> {
    try {
      const plan = await db().studyPlan.findFirst({
        where: { id: planId, userId },
        include: {
          tasks: { include: { course: true }, orderBy: [{ date: "asc" }, { priority: "desc" }] },
        },
      });
      if (!plan) throw new StudyPlannerAgentError("PLAN_NOT_FOUND");
      return plan as DatabasePlan;
    } catch (error) {
      if (error instanceof StudyPlannerAgentError) throw error;
      throw new StudyPlannerAgentError("STORAGE_FAILURE");
    }
  }

  private async loadCurrentTasks(userId: string): Promise<DatabaseTask[]> {
    try {
      const tasks = await db().studyTask.findMany({
        where: {
          userId,
          status: { in: ["PLANNED", "IN_PROGRESS"] },
          studyPlan: { userId, status: "ACTIVE" },
          date: { gte: new Date(Date.now() - 86_400_000) },
        },
        include: { course: true },
        orderBy: [{ date: "asc" }, { priority: "desc" }, { id: "asc" }],
        take: 10,
      });
      return tasks as DatabaseTask[];
    } catch {
      throw new StudyPlannerAgentError("STORAGE_FAILURE");
    }
  }

  private async authenticate(requestHeaders: Headers) {
    const headers = new Headers(requestHeaders);
    try {
      const session = await auth().api.getSession({
        headers,
        query: { disableRefresh: true },
      });
      if (!session?.user.id) throw new StudyPlannerAgentError("UNAUTHENTICATED");
      return { userId: session.user.id, headers };
    } catch (error) {
      if (error instanceof StudyPlannerAgentError) throw error;
      throw new StudyPlannerAgentError("AUTHENTICATION_FAILURE");
    }
  }
}

export function createStudyPlannerAgentService(
  options: StudyPlannerAgentServiceOptions = {},
): StudyPlannerAgentService {
  return new StudyPlannerAgentService(createStudentAgentRegistry(), options);
}
