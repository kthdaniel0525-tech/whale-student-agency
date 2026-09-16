import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { auth } from "../auth/config";
import { ContextReadCache } from "../context/cache";
import { observeWorkflowOutcome } from "../memory";
import { WorkflowError, workflowError } from "./errors";
import { recoveryResult } from "./recovery-policy";
import type { StepInput, StepOutput, WorkflowContext, WorkflowDefinition, WorkflowInput, WorkflowResult, WorkflowStep } from "./types";

type ExecuteStep = (step: WorkflowStep, input: StepInput, context: Readonly<WorkflowContext>, headers: Headers) => Promise<StepOutput>;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const patchKeys = new Set(["priorities", "topics", "studyPlanId", "planCurrent", "quizId", "quizCurrent", "quizMode", "tutorTopic", "targetTopics", "recovery", "lecture", "assignment", "careerPreparation"]);
const securityErrors = new Set(["UNAUTHENTICATED", "REFERENCE_NOT_FOUND", "CONTEXT_FAILURE", "AUTHENTICATION", "INVALID_REQUEST", "DOCUMENT_NOT_READY", "DOCUMENT_CHANGED", "ASSIGNMENT_CHANGED", "ASSIGNMENT_CONTEXT_UNAVAILABLE", "CAREER_DATA_CHANGED"]);

export async function workflowIdentity(headers: Headers) {
  const captured = new Headers(headers);
  const session = await auth().api.getSession({ headers: captured, query: { disableRefresh: true } });
  if (!session) throw new WorkflowError("UNAUTHENTICATED");
  return { userId: session.user.id, headers: captured };
}

/** Internal runner: definitions and initial context are supplied by trusted server
 * code after scope validation. Public callers use WorkflowService. No dynamic
 * step insertion, recursive agent calls, background runner or automatic replay. */
export class WorkflowEngine {
  constructor(private readonly execute: ExecuteStep, private readonly cache: ContextReadCache) {}

  async run(definition: WorkflowDefinition, input: WorkflowInput, initial: WorkflowContext, headers: Headers): Promise<WorkflowResult> {
    const identity = await workflowIdentity(headers);
    const userId = identity.userId;
    const scope = initial.careerPreparation ? createHash("sha256").update(JSON.stringify([initial.careerPreparation.targetRole, initial.careerPreparation.targetIndustry, initial.careerPreparation.targetCompanies, initial.careerPreparation.timeline, initial.careerPreparation.weeklyAvailableMinutes, initial.careerPreparation.selectedProjectIds, initial.careerPreparation.sourceFingerprint, initial.careerPreparation.provided, initial.goal])).digest("hex") : initial.assignment ? createHash("sha256").update(JSON.stringify([initial.assignment.id, initial.assignment.updatedAt, initial.assignment.documents, initial.assignment.path, initial.assignment.signals.availableMinutes, initial.assignment.specificQuestion, initial.assignment.userWork, initial.goal])).digest("hex") : initial.lecture ? createHash("sha256").update(JSON.stringify([initial.courseId, initial.lecture.documents.map((d) => [d.id, d.updatedAt]).sort((a, b) => a[0].localeCompare(b[0])), initial.lecture.mode, initial.lecture.topicFocus, initial.lecture.requestedDifficulty, initial.lecture.availableMinutes, initial.goal.trim().toLowerCase().replace(/\s+/g, " ")])).digest("hex") : initial.recovery?.topicId ?? initial.exam?.id;
    if (!scope) throw new WorkflowError("INVALID_REQUEST");
    const activeKey = `${userId}:${definition.id}:${scope}`;
    let run;
    try {
      run = await db().workflowRun.create({ data: {
        userId, workflowId: definition.id, activeKey, input: json(input), context: json(initial),
        steps: { create: definition.steps.map((step, position) => ({ stepId: step.id, agentId: step.agentId, position })) },
      } });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "P2002") {
        const existing = await db().workflowRun.findFirst({ where: { activeKey, userId }, select: { id: true } });
        if (existing) return this.get(existing.id, headers);
      }
      throw new WorkflowError("STORAGE_FAILURE");
    }
    return this.advance(definition, run.id, identity.headers);
  }

  /** Explicit continuation only. A compare-and-set claim prevents simultaneous
   * resumes from executing the next agent twice. prepare is trusted server code. */
  async resume(definition: WorkflowDefinition, id: string, headers: Headers,
    prepare: (context: Readonly<WorkflowContext>) => Promise<NonNullable<StepOutput["patch"]>>,
    expectedInput?: NonNullable<WorkflowContext["waitingFor"]>) {
    const { userId } = await workflowIdentity(headers);
    const run = await db().workflowRun.findFirst({ where: { id, userId } });
    if (!run) throw new WorkflowError("RUN_NOT_FOUND");
    if (run.workflowId !== definition.id) throw new WorkflowError("INVALID_REQUEST");
    const saved = run.context as unknown as WorkflowContext;
    if (expectedInput && (saved.waitingFor?.kind !== expectedInput.kind || saved.waitingFor.referenceId !== expectedInput.referenceId)) return this.get(id, headers);
    const claimed = await db().workflowRun.updateMany({ where: { id, userId, status: "WAITING_FOR_INPUT", updatedAt: run.updatedAt }, data: { status: "RUNNING" } });
    if (!claimed.count) return this.get(id, headers);
    this.cache.invalidate();
    return this.advance(definition, id, headers, prepare);
  }

  private async advance(definition: WorkflowDefinition, id: string, headers: Headers,
    prepare?: (context: Readonly<WorkflowContext>) => Promise<NonNullable<StepOutput["patch"]>>) {
    const identity = await workflowIdentity(headers);
    const userId = identity.userId;
    const run = await db().workflowRun.findFirstOrThrow({ where: { id, userId }, include: { steps: true } });
    const context = structuredClone(run.context) as unknown as WorkflowContext;
    const calls = new Map<string, number>();
    for (const step of run.steps) calls.set(step.agentId, (calls.get(step.agentId) ?? 0) + step.attempts);
    const started = Date.now();
    const expired = () => run.activeDurationMs + Date.now() - started >= definition.maxDurationMs;
    const warnings: string[] = [...run.warnings];
    let waiting = false;
    try {
      await db().workflowRun.updateMany({ where: { id: run.id, userId, status: "PENDING" }, data: { status: "RUNNING" } });
      if (prepare) {
        const patch = await prepare(structuredClone(context));
        if (Object.keys(patch).some((key) => !patchKeys.has(key))) throw new WorkflowError("INVALID_RESPONSE");
        Object.assign(context, patch, { waitingFor: null });
        if (JSON.stringify(context).length > 24000) throw new WorkflowError("INVALID_RESPONSE");
        await db().workflowRun.updateMany({ where: { id, userId, status: "RUNNING" }, data: { context: json(context) } });
      }
      if (definition.steps.length > definition.maxSteps || definition.maxSteps > 8) throw new WorkflowError("LIMIT_EXCEEDED");
      for (const step of definition.steps) {
        if (run.steps.some((saved) => saved.stepId === step.id && ["COMPLETED", "SKIPPED", "FAILED"].includes(saved.status))) continue;
        const current = await db().workflowRun.findFirstOrThrow({ where: { id: run.id, userId }, select: { status: true } });
        if (current.status === "CANCELLED") break;
        if (expired()) throw new WorkflowError("LIMIT_EXCEEDED");
        const where = { workflowRunId: run.id, userId, stepId: step.id };
        const condition = step.condition?.(structuredClone(context)) ?? { run: true, reason: step.purpose };
        if (!condition.run) {
          await db().workflowStepRun.updateMany({ where, data: { status: "SKIPPED", inputSummary: step.purpose, outputSummary: condition.reason.slice(0, 800), completedAt: new Date() } });
          continue;
        }
        const mapped = step.input(structuredClone(context));
        if (!mapped.request?.trim() || mapped.request.length > 1000) throw new WorkflowError("INVALID_REQUEST");
        await db().workflowRun.updateMany({ where: { id: run.id, userId, status: "RUNNING" }, data: { currentStep: step.id } });
        let completed = false;
        for (let attempt = 0; attempt <= definition.maxRetries; attempt++) {
          const cancelled = await db().workflowRun.findFirst({ where: { id: run.id, userId, status: "CANCELLED" }, select: { id: true } });
          if (cancelled) break;
          const count = (calls.get(step.agentId) ?? 0) + 1;
          if ((step.agentId !== "deterministic" && count > (definition.agentCallLimits?.[step.agentId] ?? definition.maxAgentCalls)) || expired()) throw new WorkflowError("LIMIT_EXCEEDED");
          calls.set(step.agentId, count);
          await db().workflowStepRun.updateMany({ where, data: { status: "RUNNING", attempts: { increment: 1 }, startedAt: new Date(), inputSummary: step.purpose, errorCode: null } });
          try {
            let output: StepOutput;
            try {
              output = await this.execute(step, mapped, structuredClone(context), identity.headers);
            } finally {
              // A domain operation can fail after committing a write. Optional
              // continuation must also discard potentially stale aggregates.
              if (step.invalidates) this.cache.invalidate(step.invalidates);
            }
            if (!output.summary?.trim() || output.summary.length > 800 || JSON.stringify(output).length > Math.min(definition.maxOutputCharacters ?? 14000, 48000) || Object.keys(output.patch ?? {}).some((key) => !patchKeys.has(key))) throw new WorkflowError("INVALID_RESPONSE");
            if (output.waitForInput && (!["quiz", "student-work", "career-data"].includes(output.waitForInput.kind) || !output.waitForInput.referenceId || output.waitForInput.referenceId.length > 100)) throw new WorkflowError("INVALID_RESPONSE");
            Object.assign(context, output.patch);
            if (output.waitForInput) context.waitingFor = output.waitForInput;
            context.previousStepSummaries.push({ stepId: step.id, summary: output.summary });
            if (JSON.stringify(context).length > 24000) throw new WorkflowError("INVALID_RESPONSE");
            await db().$transaction([
              db().workflowStepRun.updateMany({ where, data: { status: "COMPLETED", outputSummary: output.summary, output: json({ key: step.outputKey, data: output.data ?? output.patch ?? {} }), completedAt: new Date() } }),
              db().workflowRun.updateMany({ where: { id: run.id, userId }, data: { context: json(context) } }),
            ]);
            waiting = Boolean(output.waitForInput);
            completed = true;
            break;
          } catch (error) {
            const failure = workflowError(error);
            const transient = failure.code === "RATE_LIMIT" || failure.code === "PROVIDER_FAILURE";
            if (transient && attempt < definition.maxRetries) continue;
            const policy = step.failurePolicy ?? definition.failurePolicy;
            await db().workflowStepRun.updateMany({ where, data: { status: policy === "skip-step" && !securityErrors.has(failure.code) ? "SKIPPED" : "FAILED", errorCode: failure.code, completedAt: new Date() } });
            if (policy === "fail-workflow" || securityErrors.has(failure.code)) throw failure;
            if (policy === "continue-with-warning") warnings.push(`${step.id}: ${failure.code}`);
            break;
          }
        }
        if (completed && expired()) throw new WorkflowError("LIMIT_EXCEEDED");
        if (waiting) break;
      }
      if (!waiting) {
        const completed = await db().workflowRun.updateMany({ where: { id: run.id, userId, status: "RUNNING" }, data: { status: "COMPLETED", currentStep: null, completedAt: new Date(), warnings } });
        if (completed.count) {
          try {
            await observeWorkflowOutcome({
              userId,
              runId: run.id,
              workflowId: definition.id,
              improvement: context.recovery?.evaluation?.improvement,
              quizPercentage: context.lecture?.summary?.quizScore.percentage,
            });
          } catch {
            // Workflow results are authoritative; optional personalization
            // evidence must not turn a successful workflow into a failure.
          }
        }
      }
    } catch (error) {
      const failure = workflowError(error);
      const stopped = await db().workflowRun.findFirst({ where: { id: run.id, userId }, select: { currentStep: true } });
      await db().workflowStepRun.updateMany({ where: { workflowRunId: run.id, userId, stepId: stopped?.currentStep ?? "", status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", errorCode: failure.code, completedAt: new Date() } });
      await db().workflowRun.updateMany({ where: { id: run.id, userId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", errorCode: failure.code, failedAt: new Date(), warnings } });
    } finally {
      // Human response time is excluded, but active time and call counts survive
      // every pause. Publish WAITING only after checkpointing the execution budget.
      await db().workflowRun.updateMany({ where: { id: run.id, userId }, data: { activeDurationMs: { increment: Date.now() - started }, warnings } });
      if (waiting) await db().workflowRun.updateMany({ where: { id: run.id, userId, status: "RUNNING" }, data: { status: "WAITING_FOR_INPUT" } });
      const terminal = await db().workflowRun.findFirst({ where: { id: run.id, userId, status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } }, select: { id: true } });
      if (terminal) {
        // Hold the active key through in-flight cancellation and persistence.
        await db().workflowRun.updateMany({ where: { id: run.id, userId }, data: { activeKey: null } });
        await db().workflowStepRun.updateMany({ where: { workflowRunId: run.id, userId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "SKIPPED", outputSummary: "Workflow stopped before this step completed.", completedAt: new Date() } });
      }
    }
    return this.get(run.id, headers);
  }

  async get(id: string, headers: Headers): Promise<WorkflowResult> {
    const { userId } = await workflowIdentity(headers);
    if (!id || id.length > 100) throw new WorkflowError("INVALID_REQUEST");
    const run = await db().workflowRun.findFirst({ where: { id, userId }, include: { steps: { orderBy: { position: "asc" } } } });
    if (!run) throw new WorkflowError("RUN_NOT_FOUND");
    const context = run.context as unknown as WorkflowContext;
    const outputs: Record<string, unknown> = {};
    for (const step of run.steps) if (step.output) {
      const output = step.output as { key: string; data: unknown };
      outputs[output.key] = output.data;
    }
    const completedSteps = run.steps.filter((step) => step.status === "COMPLETED").map((step) => step.stepId);
    const career = context.careerPreparation;
    const careerResult = career ? {
      targetRole: career.targetRole, stage: career.stage, readiness: career.readiness,
      criticalGaps: career.analysis?.criticalGaps ?? [], selectedProjects: career.analysis?.projectPriorities ?? [],
      planId: career.planId, missingInputs: career.missingInputs,
      nextAction: run.status === "FAILED" ? "Review the saved analysis and error before starting a new career preparation run." : career.nextAction,
      limitations: career.limitations,
    } : undefined;
    const assignment = context.assignment;
    const feedback = outputs["assignment-feedback"] as import("./assignment-policy").AssignmentFeedback | undefined;
    const assignmentResult = assignment ? {
      assignmentId: assignment.id, stage: assignment.stage, assignmentSummary: assignment.analysis?.objective ?? assignment.title,
      completedSteps, remainingSteps: run.steps.filter((step) => step.status === "PENDING" || step.status === "FAILED").map((step) => step.stepId),
      ...(feedback ? { feedback } : {}),
      nextAction: run.status === "FAILED" ? "Review the saved work and error, then start a new support run with current assignment instructions." : assignment.nextAction,
      ...(assignment.stage === "learn" || assignment.stage === "work" ? { recommendedAgent: "tutor" as const } : {}),
    } : undefined;
    const lecture = context.lecture;
    const lectureSummary = run.status === "COMPLETED" ? lecture?.summary ?? null : null;
    const recovery = context.recovery ? recoveryResult(context.recovery, run.status, completedSteps) : undefined;
    return {
      ...(careerResult ? { careerPreparation: careerResult, waitingFor: run.status === "WAITING_FOR_INPUT" ? context.waitingFor : null } : {}),
      ...(assignmentResult ? { assignmentSupport: assignmentResult, waitingFor: run.status === "WAITING_FOR_INPUT" ? context.waitingFor : null } : {}),
      ...(lecture ? { lectureStudy: { mode: lecture.mode, estimatedEffort: lecture.effort, coverage: "Based on retrieved passages from the selected materials; full lecture coverage is not guaranteed.", summary: lectureSummary }, waitingFor: run.status === "WAITING_FOR_INPUT" ? context.waitingFor : null } : {}),
      ...(recovery ? { recovery, waitingFor: run.status === "WAITING_FOR_INPUT" ? context.waitingFor : null } : {}),
      runId: run.id, workflowId: run.workflowId as WorkflowResult["workflowId"], status: run.status.toLowerCase().replaceAll("_", "-") as WorkflowResult["status"],
      summary: careerResult ? `Career preparation is ${run.status.toLowerCase().replaceAll("_", " ")}. ${careerResult.nextAction}` : assignmentResult ? `Assignment support is ${run.status.toLowerCase().replaceAll("_", " ")}. ${assignmentResult.nextAction}` : lecture ? lectureSummary ? `Lecture study completed: ${lectureSummary.quizScore.percentage}% on the graded quiz. ${lectureSummary.recommendedNextAction}` : run.status === "WAITING_FOR_INPUT" ? "Notes and practice are ready. Complete the saved quiz to evaluate your learning." : `Lecture study is ${run.status.toLowerCase()}. Completed work remains available.` : recovery ? recovery.improvementSummary : run.status === "COMPLETED" ? "Exam preparation is ready. Follow the study plan and complete the selected practice." : `Exam preparation is ${run.status.toLowerCase()}.`,
      completedSteps: run.steps.filter((step) => step.status === "COMPLETED").map((step) => step.stepId),
      steps: run.steps.map((step) => ({ stepId: step.stepId, agentId: step.agentId, status: step.status.toLowerCase(), attempts: step.attempts, inputSummary: step.inputSummary, outputSummary: step.outputSummary, errorCode: step.errorCode })),
      outputs: { ...outputs, ...(recovery || lecture || assignment || career ? {} : { studyPlanId: context.studyPlanId }), ...(lecture ? { sources: lecture.sources } : {}), quizId: context.quizId }, warnings: run.warnings, errorCode: run.errorCode,
      recommendedNextAction: careerResult ? careerResult.nextAction : assignmentResult ? assignmentResult.nextAction : lecture ? lectureSummary?.recommendedNextAction ?? (run.status === "WAITING_FOR_INPUT" ? "Submit every quiz answer, then continue this study session." : "Review the workflow status and its completed work before continuing.") : recovery ? recovery.nextAction : run.status === "COMPLETED" ? context.quizId ? "Complete the quiz, then use its feedback for your next study session." : "Start the next session in your study plan." : "Review the workflow status and its completed work before trying again.",
    };
  }
  async cancel(id: string, headers: Headers) {
    const { userId } = await workflowIdentity(headers);
    await this.get(id, headers);
    const paused = await db().workflowRun.updateMany({ where: { id, userId, status: "WAITING_FOR_INPUT" }, data: { status: "CANCELLED", cancelledAt: new Date(), activeKey: null } });
    if (paused.count) await db().workflowStepRun.updateMany({ where: { workflowRunId: id, userId, status: "PENDING" }, data: { status: "SKIPPED", outputSummary: "Cancelled while waiting for input.", completedAt: new Date() } });
    await db().workflowRun.updateMany({ where: { id, userId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    return this.get(id, headers);
  }
}
