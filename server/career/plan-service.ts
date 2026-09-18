import "server-only";
import { auth } from "../auth/config";
import { db } from "../db/client";
import { NotFoundError } from "../services/academic";
import type { CareerPreparationState, ScheduledCareerTask } from "../workflows/career-policy";

export class CareerPlanError extends Error {
  constructor(readonly code: "UNAUTHENTICATED" | "INVALID_REQUEST" | "STORAGE_FAILURE") {
    super({ UNAUTHENTICATED: "Sign in to access a career plan.", INVALID_REQUEST: "Check the career plan reference.", STORAGE_FAILURE: "The career plan could not be saved." }[code]);
    this.name = "CareerPlanError";
  }
}

const category = (value: ScheduledCareerTask["category"]) => value.toUpperCase() as "SKILL" | "PROJECT" | "RESUME" | "PORTFOLIO" | "INTERVIEW" | "APPLICATION";

/** Internal persistence boundary. Inputs are already authenticated, validated
 * workflow state; database relations enforce plan/project ownership again. */
export async function persistCareerPlan(userId: string, state: CareerPreparationState, summary: string, tasks: readonly ScheduledCareerTask[]) {
  try {
    const totalPlannedMinutes = tasks.reduce((sum, task) => sum + task.durationMinutes, 0);
    return await db().careerPlan.create({
      data: {
        userId, targetRole: state.targetRole, targetIndustry: state.targetIndustry,
        startDate: new Date(`${state.timeline.startDate}T00:00:00Z`), targetDate: new Date(`${state.timeline.targetDate}T00:00:00Z`),
        weeklyAvailableMinutes: state.weeklyAvailableMinutes, totalPlannedMinutes, summary,
        tasks: { create: tasks.map((task) => ({ projectId: task.projectId, actionId: task.actionId, weekNumber: task.weekNumber,
          category: category(task.category), title: task.title, description: task.description, priority: task.priority,
          durationMinutes: task.durationMinutes, targetDate: new Date(`${task.targetDate}T00:00:00Z`) })) },
      },
      include: { tasks: { orderBy: [{ weekNumber: "asc" }, { priority: "desc" }, { id: "asc" }] } },
    });
  } catch {
    throw new CareerPlanError("STORAGE_FAILURE");
  }
}

export class CareerPlanService {
  async getPlan(id: string, headers: Headers) {
    if (!id || id.length > 100) throw new CareerPlanError("INVALID_REQUEST");
    try {
      const session = await auth().api.getSession({ headers, query: { disableRefresh: true } });
      if (!session) throw new CareerPlanError("UNAUTHENTICATED");
      const plan = await db().careerPlan.findFirst({ where: { id, userId: session.user.id },
        include: { tasks: { where: { userId: session.user.id }, orderBy: [{ weekNumber: "asc" }, { priority: "desc" }, { id: "asc" }], include: { project: { select: { id: true, userId: true, name: true } } } } } });
      if (!plan || plan.tasks.some((task) => task.project && task.project.userId !== session.user.id)) throw new NotFoundError();
      return plan;
    } catch (error) {
      if (error instanceof CareerPlanError || error instanceof NotFoundError) throw error;
      throw new CareerPlanError("STORAGE_FAILURE");
    }
  }

  async updateTaskStatus(id: string, status: "planned" | "in-progress" | "completed" | "skipped", headers: Headers) {
    if (!id || id.length > 100) throw new CareerPlanError("INVALID_REQUEST");
    const values = { planned: "PLANNED", "in-progress": "IN_PROGRESS", completed: "COMPLETED", skipped: "SKIPPED" } as const;
    try {
      const session = await auth().api.getSession({ headers, query: { disableRefresh: true } });
      if (!session) throw new CareerPlanError("UNAUTHENTICATED");
      const result = await db().careerTask.updateMany({
        where: { id, userId: session.user.id, careerPlan: { userId: session.user.id } },
        data: { status: values[status] },
      });
      if (!result.count) throw new NotFoundError();
      return db().careerTask.findFirstOrThrow({ where: { id, userId: session.user.id } });
    } catch (error) {
      if (error instanceof CareerPlanError || error instanceof NotFoundError) throw error;
      throw new CareerPlanError("STORAGE_FAILURE");
    }
  }
}
