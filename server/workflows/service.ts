import { assertWorkflowAllowance } from "../entitlements/resources";
import { checkAIUsageAllowance } from "../entitlements/usage";
import "server-only";
import { withAIUsageContext } from "../ai/usage/context";
import { z } from "zod";
import { db } from "../db/client";
import { buildUserContext } from "../context/builder";
import { ContextReadCache } from "../context/cache";
import { NotFoundError } from "../services/academic";
import { normalizeTopicName } from "../learning/normalization";
import { createStudentAgentRegistry, createStudentAgentService } from "../agents/student-service";
import { StudyPlannerAgentService } from "../agents/study-planner/service";
import { QuizAgentService } from "../agents/quiz/service";
import type { AIEmbeddingProvider, AIProvider } from "../ai/types";
import type { AcademicManagerResponse } from "../agents/academic-manager/execution";
import { AgentExecutor } from "../agents/executor";
import { NOTES_INSTRUCTIONS } from "../agents/notes/instructions";
import { TUTOR_INSTRUCTIONS } from "../agents/tutor/instructions";
import { CAREER_INSTRUCTIONS } from "../agents/career/instructions";
import { lectureStudy, lectureState } from "./lecture-study";
import { LectureWorkflowAdapter, lectureInputSchema, initialLectureContext, validateLectureAttempt, validateLectureScope } from "./lecture-service";
import { workflowAnswerSchema, workflowResumeSchema } from "./quiz-input";
import { assignmentSupport, assignmentState } from "./assignment-support";
import { AssignmentWorkflowAdapter, assignmentInputSchema, initialAssignmentContext, studentWorkSchema, validateAssignmentScope } from "./assignment-service";
import { careerPreparation, careerPreparationState } from "./career-preparation";
import { CareerPreparationWorkflowAdapter, careerInputSchema, careerProvidedDataSchema, initialCareerContext, prepareCareerResume } from "./career-service";
import { WorkflowRegistry } from "./registry";
import { WorkflowEngine, workflowIdentity } from "./engine";
import { WorkflowError, workflowError } from "./errors";
import { weakTopicRecovery, recoveryState } from "./weak-topic-recovery";
import { RecoveryWorkflowAdapter, recoveryInputSchema, initialRecoveryContext, validateRecoveryAttempt } from "./recovery-service";
import { examDecisions, examPreparation } from "./exam-preparation";
import type { StepOutput, WorkflowContext, WorkflowInput } from "./types";
import { appendConversationMessage, ConversationError, getConversationScope } from "../conversations";

const id = z.string().min(1).max(100);
function calendarDate(value: Date, timezone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  return ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)!.value).join("-");
}
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => { const d = new Date(s + "T00:00:00Z"); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const examInputSchema = z.object({
  workflowId: z.literal("exam-preparation"), goal: z.string().trim().min(3).max(1000),
  conversationId: id.optional(),
  examId: id.optional(), courseId: id.optional(), studyPlanId: id.optional(), quizId: id.optional(),
  documentIds: z.array(id).min(1).max(10).optional(),
  availability: z.array(z.object({ date, availableMinutes: z.number().int().min(0).max(720) }).strict()).min(1).max(91).refine((a) => new Set(a.map((d) => d.date)).size === a.length).optional(),
}).strict();
export const workflowInputSchema = z.discriminatedUnion("workflowId", [examInputSchema, recoveryInputSchema, lectureInputSchema, assignmentInputSchema, careerInputSchema]);
const resumeInputSchema = z.union([workflowResumeSchema, z.object({ runId: id, userWork: studentWorkSchema }).strict(), z.object({ runId: id, careerData: careerProvidedDataSchema }).strict()]);
const planInclude = { tasks: { take: 201, orderBy: { date: "asc" as const }, include: {
  course: { select: { userId: true } }, topicRecord: { select: { userId: true } }, exam: { select: { userId: true } }, assignment: { select: { userId: true } },
} } };

/** Explicit user-initiated entry point; it never intercepts single-agent requests. */
export class WorkflowService {
  constructor(private readonly options: {
    getProvider?: () => AIProvider | Promise<AIProvider>;
    conversationEmbeddingProvider?: AIEmbeddingProvider | null;
  } = {}) {}

  private engine(cache = new ContextReadCache()) {
    const agents = createStudentAgentRegistry();
    const core = createStudentAgentService({ executor: { ...this.options, contextCache: cache } });
    const planner = new StudyPlannerAgentService(agents, { executor: { ...this.options, contextCache: cache }, router: { allowedAgentIds: ["study-planner"] } });
    const quiz = new QuizAgentService(agents, { executor: { ...this.options, contextCache: cache }, router: { allowedAgentIds: ["quiz"] } });
    const recovery = new RecoveryWorkflowAdapter(core, quiz, cache);
    const lecture = new LectureWorkflowAdapter(new AgentExecutor(agents, { ...this.options, contextCache: cache, instructions: { notes: NOTES_INSTRUCTIONS, tutor: TUTOR_INSTRUCTIONS } }), quiz, cache);
    const assignment = new AssignmentWorkflowAdapter(new AgentExecutor(agents, { ...this.options, contextCache: cache, instructions: { notes: NOTES_INSTRUCTIONS, tutor: TUTOR_INSTRUCTIONS } }), cache);
    const career = new CareerPreparationWorkflowAdapter(new AgentExecutor(agents, { ...this.options, contextCache: cache, instructions: { career: CAREER_INSTRUCTIONS } }));
    return new WorkflowEngine(async (step, input, context, headers): Promise<StepOutput> => {
      const { userId } = await workflowIdentity(headers);
      if (context.careerPreparation) return career.execute(step, input, context, headers);
      if (context.assignment) return assignment.execute(step, input, context, headers);
      if (context.lecture) return lecture.execute(step, input, context, headers);
      if (context.recovery) return recovery.execute(step, input, context, headers);
      if (!context.exam) throw new WorkflowError("INVALID_REQUEST");
      if (step.agentId === "academic-manager") {
        const result = await core.handleAgentRequest({ request: input.request, preferredAgentId: "academic-manager", courseId: context.courseId, examId: context.exam.id,
          ...(context.conversationId ? { conversation: { id: context.conversationId } } : {}) }, headers);
        if (!result.ok) throw new WorkflowError(result.error.code as import("./errors").WorkflowErrorCode);
        const analysis = result.response.structuredData as AcademicManagerResponse;
        const learning = await buildUserContext({ request: "Learning evidence for exam preparation", courseId: context.courseId, examId: context.exam.id, options: { learning: true, limits: { learning: 10 } } }, headers, cache);
        const topics = [...new Map([...(learning.learning?.examTopics ?? []), ...(learning.learning?.weakTopics ?? []), ...(learning.learning?.strongTopics ?? []), ...(learning.learning?.recommendedTopics ?? [])].map((t) => [t.topicId, t])).values()];
        const decisions = examDecisions(context as WorkflowContext, topics);
        const priorities = analysis.topPriorities.slice(0, 3).map((p) => ({ reason: p.reason.slice(0, 500), score: p.score }));
        const next = { ...context, ...decisions };
        // Recheck after claiming the run: another short run may have finished
        // between preflight and acquisition of this run's unique active key.
        const studyPlanId = context.studyPlanId ?? (await this.ownedPlan(undefined, userId, context.courseId, context.exam.id))?.id ?? null;
        const quizId = context.quizId ?? (await db().quiz.findFirst({ where: { userId, courseId: context.courseId, createdAt: { gte: new Date(Date.now() - 86400000) } }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? null;
        const planCurrent = studyPlanId ? await this.planCurrent(studyPlanId, userId, next) : false;
        const quizCurrent = quizId ? await this.quizCurrent(quizId, userId, next) : false;
        return { summary: "Analyzed exam readiness, recent performance, confidence and existing study work.", patch: { ...decisions, priorities, studyPlanId, quizId, planCurrent, quizCurrent }, data: { priorities, weakTopics: decisions.topics.filter((t) => t.mastery < 70).map((t) => ({ topic: t.topic, mastery: t.mastery, confidence: t.confidence, trend: t.trend, recentAccuracy: t.recentAccuracy })), daysRemaining: context.exam.daysRemaining, quizMode: decisions.quizMode } };
      }
      if (step.agentId === "study-planner") {
        const request = { request: input.request, courseId: context.courseId, examId: context.exam.id, endDate: calendarDate(new Date(context.exam.examDate), context.timezone),
          ...(context.conversationId ? { conversation: { id: context.conversationId } } : {}),
          ...(context.availability ? { availability: context.availability } : {}) };
        const plan = context.studyPlanId ? await planner.updatePlan({ ...request, planId: context.studyPlanId }, headers) : await planner.createPlan(request, headers);
        if (!await this.ownedPlan(plan.id, userId, context.courseId, context.exam.id)) throw new WorkflowError("REFERENCE_NOT_FOUND");
        return { summary: `${context.studyPlanId ? "Updated" : "Created"} the exam study plan, preserving completed work.`, patch: { studyPlanId: plan.id, planCurrent: true }, data: { studyPlanId: plan.id, assumptions: plan.assumptions, nextStudyTasks: plan.days.flatMap((d) => d.sessions).filter((s) => s.status === "planned" || s.status === "in-progress").slice(0, 5).map((s) => ({ title: s.title, date: s.date, durationMinutes: s.durationMinutes, reason: s.reason })) } };
      }
      if (step.agentId === "quiz") {
        const generated = await quiz.generateQuiz({ request: input.request, courseId: context.courseId, topic: input.topic, count: 5, questionType: "mixed", difficulty: context.quizMode === "diagnostic" ? "medium" : "adaptive",
          ...(context.conversationId ? { conversation: { id: context.conversationId } } : {}),
          ...(context.documentIds ? { documentIds: context.documentIds } : {}) }, headers);
        const covered = new Set(generated.questions.flatMap((q) => q.topics).map(normalizeTopicName));
        if (generated.courseId !== context.courseId || context.targetTopics.some((t) => !covered.has(normalizeTopicName(t)))) throw new WorkflowError("INVALID_RESPONSE");
        return { summary: `Created a 5-question ${context.quizMode} quiz using the selected learning targets.`, patch: { quizId: generated.id, quizCurrent: true }, data: { quizId: generated.id, targetTopics: context.targetTopics, questionCount: generated.questions.length, mode: context.quizMode } };
      }
      if (step.agentId === "tutor") {
        const result = await core.handleAgentRequest({ request: input.request, preferredAgentId: "tutor", courseId: context.courseId,
          ...(context.conversationId ? { conversation: { id: context.conversationId } } : {}),
          ...(context.documentIds ? { documentIds: context.documentIds } : {}) }, headers);
        if (!result.ok) throw new WorkflowError(result.error.code as import("./errors").WorkflowErrorCode);
        return { summary: `Explained ${input.topic?.slice(0, 160) ?? "the selected weak concept"}.`, data: { topic: input.topic, explanation: result.response.content.slice(0, 6000), truncated: result.response.content.length > 6000, sources: result.response.sources.slice(0, 5) } };
      }
      throw new WorkflowError("INVALID_DEFINITION");
    }, cache);
  }

  async runWorkflow(raw: WorkflowInput, requestHeaders: Headers) {
    try { return await withAIUsageContext({ workflowId: raw.workflowId }, () => this.start(raw, requestHeaders)); } catch (error) { throw workflowError(error); }
  }
  private async start(raw: WorkflowInput, requestHeaders: Headers) {
    const { userId, headers } = await workflowIdentity(requestHeaders);
    if (raw.workflowId === "career-preparation" && raw.targetRole !== undefined && !raw.targetRole.trim()) throw new WorkflowError("TARGET_ROLE_REQUIRED");
    const parsed = workflowInputSchema.safeParse(raw);
    if (!parsed.success) throw new WorkflowError("INVALID_REQUEST");
    const input = parsed.data;
    await db().$transaction(tx => assertWorkflowAllowance(userId, input.workflowId, tx, true));
    await checkAIUsageAllowance(userId, { workflowId: input.workflowId });
    const cache = new ContextReadCache();
    if (input.conversationId) {
      try { await getConversationScope(input.conversationId, headers); }
      catch (error) {
        if (error instanceof ConversationError) throw new WorkflowError("REFERENCE_NOT_FOUND");
        throw error;
      }
    }
    if (input.workflowId === "career-preparation") {
      const context = await initialCareerContext(input, headers, cache);
      const registry = new WorkflowRegistry(createStudentAgentRegistry()); registry.register(careerPreparation);
      return this.engine(cache).run(registry.get(input.workflowId), input, context, headers);
    }
    if (input.workflowId === "assignment-support") {
      const context = await initialAssignmentContext(input, headers, cache);
      const registry = new WorkflowRegistry(createStudentAgentRegistry()); registry.register(assignmentSupport);
      return this.engine(cache).run(registry.get(input.workflowId), input, context, headers);
    }
    if (input.workflowId === "weak-topic-recovery") {
      const context = await initialRecoveryContext(input, headers, cache);
      const registry = new WorkflowRegistry(createStudentAgentRegistry()); registry.register(weakTopicRecovery);
      return this.engine(cache).run(registry.get(input.workflowId), input, context, headers);
    }
    if (input.workflowId === "lecture-study") {
      const context = await initialLectureContext(input, headers);
      const registry = new WorkflowRegistry(createStudentAgentRegistry()); registry.register(lectureStudy);
      return this.engine(cache).run(registry.get(input.workflowId), input, context, headers);
    }
    let academic;
    try {
      academic = await buildUserContext({ request: input.goal, courseId: input.courseId, examId: input.examId, documentIds: input.documentIds,
        options: { profile: true, course: true, exams: true, deadlineWindowDays: 90, limits: { exams: 10 } } }, headers, cache);
    } catch (error) { if (error instanceof NotFoundError) throw new WorkflowError("REFERENCE_NOT_FOUND"); throw error; }
    const exams = academic.exams ?? [];
    const named = exams.filter((e) => input.goal.toLowerCase().includes(e.title.toLowerCase()));
    const exam = input.examId ? exams.find((e) => e.id === input.examId) : named.length === 1 ? named[0] : exams.length === 1 ? exams[0] : undefined;
    if (!exam) throw new WorkflowError(input.examId || !exams.length ? "EXAM_UNAVAILABLE" : "EXAM_SELECTION_REQUIRED");
    if (new Date(exam.examDate).getTime() > Date.now() + 90 * 86400000) throw new WorkflowError("EXAM_UNAVAILABLE");
    const timezone = academic.profile?.timezone ?? "UTC";
    if (input.availability?.some((d) => d.date > calendarDate(new Date(exam.examDate), timezone))) throw new WorkflowError("INVALID_REQUEST");
    const plan = await this.ownedPlan(input.studyPlanId, userId, exam.course.id, exam.id);
    let selectedQuiz;
    if (input.quizId) {
      selectedQuiz = await db().quiz.findFirst({ where: { id: input.quizId, userId, courseId: exam.course.id } });
      if (!selectedQuiz) throw new WorkflowError("REFERENCE_NOT_FOUND");
    } else selectedQuiz = await db().quiz.findFirst({ where: { userId, courseId: exam.course.id, createdAt: { gte: new Date(Date.now() - 86400000) } }, orderBy: { createdAt: "desc" } });
    const context: WorkflowContext = { goal: input.goal, conversationId: input.conversationId, courseId: exam.course.id, timezone, exam, availability: input.availability, documentIds: input.documentIds, priorities: [], topics: [], studyPlanId: plan?.id ?? null, planCurrent: false, quizId: selectedQuiz?.id ?? null, quizCurrent: false, quizMode: "diagnostic", tutorTopic: null, targetTopics: [], previousStepSummaries: [] };
    const registry = new WorkflowRegistry(createStudentAgentRegistry()); registry.register(examPreparation);
    return this.engine(cache).run(registry.get(input.workflowId), input, context, headers);
  }
  async getRun(id: string, headers: Headers) { try { return await this.engine().get(id, headers); } catch (error) { throw workflowError(error); } }
  async cancelRun(id: string, headers: Headers) { try { return await this.engine().cancel(id, headers); } catch (error) { throw workflowError(error); } }

  /** Continue the current checkpoint with an owned quiz attempt or student draft. */
  async resumeWorkflow(raw: { runId: string; quizAttemptId: string } | { runId: string; userWork: string } | { runId: string; careerData: z.infer<typeof careerProvidedDataSchema> }, requestHeaders: Headers) {
    try {
      const { userId, headers } = await workflowIdentity(requestHeaders);
      const parsed = resumeInputSchema.safeParse(raw);
      if (!parsed.success) throw new WorkflowError("INVALID_REQUEST");
      const row = await db().workflowRun.findFirst({ where: { id: parsed.data.runId, userId } });
      if (!row) throw new WorkflowError("RUN_NOT_FOUND");
      return await withAIUsageContext({ userId, workflowId: row.workflowId, workflowRunId: row.id }, async () => {
        const context = row.context as unknown as WorkflowContext;
        const input = parsed.data;
        if ("careerData" in input) {
          if (row.workflowId !== "career-preparation") throw new WorkflowError("INVALID_REQUEST");
          if (row.status !== "WAITING_FOR_INPUT") return this.getRun(row.id, headers);
          const state = careerPreparationState(context);
          if (context.waitingFor?.kind !== "career-data" || context.waitingFor.referenceId !== state.sourceFingerprint.slice(0, 64)) throw new WorkflowError("INVALID_REQUEST");
          await this.appendWorkflowInput(context, `workflow-resume:${row.id}:career-data`,
            `Career evidence provided: ${JSON.stringify(input.careerData)}`, headers);
          await prepareCareerResume(context, input.careerData, headers);
          return this.engine().resume(careerPreparation, row.id, headers, async (saved) => prepareCareerResume(saved, input.careerData, headers), context.waitingFor);
        }
        if ("userWork" in input) {
          if (row.workflowId !== "assignment-support") throw new WorkflowError("INVALID_REQUEST");
          if (row.status !== "WAITING_FOR_INPUT") return this.getRun(row.id, headers);
          if (context.waitingFor?.kind !== "student-work" || context.waitingFor.referenceId !== assignmentState(context).id) throw new WorkflowError("INVALID_REQUEST");
          await this.appendWorkflowInput(context, `workflow-resume:${row.id}:student-work`, input.userWork, headers);
          await validateAssignmentScope(context, headers);
          return this.engine().resume(assignmentSupport, row.id, headers, async (saved) => {
            await validateAssignmentScope(saved, headers);
            return { assignment: { ...structuredClone(assignmentState(saved)), userWork: input.userWork } };
          }, context.waitingFor);
        }
        const continuation = this.quizContinuation(row.workflowId, context);
        // Repeated continuation of an already consumed attempt is idempotent,
        // including when the workflow is now waiting for its second quiz.
        if (continuation.consumed(input.quizAttemptId) || row.status !== "WAITING_FOR_INPUT") return this.getRun(row.id, headers);
        await continuation.validate(context, userId, input.quizAttemptId);
        return this.engine().resume(continuation.definition, row.id, headers, async (saved) => {
          await continuation.validate(saved, userId, input.quizAttemptId);
          return continuation.patch(saved, input.quizAttemptId);
        }, context.waitingFor!);
      });
    } catch (error) { throw workflowError(error); }
  }

  /** Optional UI adapter: grading remains in QuizAgentService. Failed answers
   * leave the workflow paused and safely retryable; no recovery is inferred. */
  async submitRecoveryAnswer(raw: { runId: string; questionId: string; userAnswer: string; quizAttemptId?: string }, requestHeaders: Headers) {
    return this.submitWorkflowAnswer(raw, requestHeaders);
  }
  async submitWorkflowAnswer(raw: { runId: string; questionId: string; userAnswer: string; quizAttemptId?: string }, requestHeaders: Headers) {
    try { return await this.answerWorkflow(raw, requestHeaders); } catch (error) { throw workflowError(error); }
  }
  private async answerWorkflow(raw: { runId: string; questionId: string; userAnswer: string; quizAttemptId?: string }, requestHeaders: Headers) {
    const { userId, headers } = await workflowIdentity(requestHeaders);
    const parsed = workflowAnswerSchema.safeParse(raw);
    if (!parsed.success) throw new WorkflowError("INVALID_REQUEST");
    const row = await db().workflowRun.findFirst({ where: { id: parsed.data.runId, userId } });
    if (!row) throw new WorkflowError("RUN_NOT_FOUND");
    if (row.status !== "WAITING_FOR_INPUT") throw new WorkflowError("INVALID_REQUEST");
    const context = row.context as unknown as WorkflowContext;
    const continuation = this.quizContinuation(row.workflowId, context);
    if (context.lecture) await validateLectureScope(context, userId);
    const quizId = context.waitingFor?.referenceId;
    if (!quizId || context.waitingFor?.referenceId !== quizId) throw new WorkflowError("INVALID_REQUEST");
    if (parsed.data.quizAttemptId) await continuation.validate(context, userId, parsed.data.quizAttemptId, false);
    const question = await db().quizQuestion.findFirst({ where: { id: parsed.data.questionId, quizId, userId, quiz: { userId, courseId: context.courseId, course: { userId } }, topicMappings: { some: { ...(context.recovery ? { topicId: context.recovery.topicId } : {}), userId, topic: { userId } } } }, select: { id: true, prompt: true } });
    if (!question) throw new WorkflowError("REFERENCE_NOT_FOUND");
    return withAIUsageContext({ userId, workflowId: row.workflowId, workflowRunId: row.id, agentId: "quiz" }, async () => {
      const quiz = new QuizAgentService(createStudentAgentRegistry(), { getProvider: this.options.getProvider });
      let evaluation;
      try {
        evaluation = await quiz.evaluateAnswer({ quizId, questionId: parsed.data.questionId, userAnswer: parsed.data.userAnswer, quizAttemptId: parsed.data.quizAttemptId }, headers);
      } catch {
        await db().workflowRun.updateMany({ where: { id: row.id, userId, status: "WAITING_FOR_INPUT", NOT: { warnings: { has: "GRADING_FAILURE" } } }, data: { warnings: { push: "GRADING_FAILURE" } } });
        throw new WorkflowError("GRADING_FAILURE");
      }
      await this.appendWorkflowInput(
        context,
        `workflow-answer:${row.id}:${parsed.data.questionId}:${evaluation.quizAttemptId}`,
        `Quiz answer to ${JSON.stringify(question.prompt)}: ${parsed.data.userAnswer}`,
        headers,
      );
      return evaluation;
    });
  }

  /** Domain-specific references plug into one shared claim/resume/grading path. */
  private quizContinuation(workflowId: string, context: WorkflowContext) {
    if (workflowId === "weak-topic-recovery") {
      const state = recoveryState(context);
      return { definition: weakTopicRecovery, consumed: (id: string) => state.quizzes.some((q) => q.attemptId === id), validate: validateRecoveryAttempt,
        patch: (saved: Readonly<WorkflowContext>, id: string): NonNullable<StepOutput["patch"]> => {
          const recovery = structuredClone(recoveryState(saved)); recovery.quizzes[recovery.quizzes.length - 1].attemptId = id; return { recovery };
        } };
    }
    if (workflowId === "lecture-study") {
      const state = lectureState(context);
      return { definition: lectureStudy, consumed: (id: string) => state.quiz?.attemptId === id, validate: validateLectureAttempt,
        patch: (saved: Readonly<WorkflowContext>, id: string): NonNullable<StepOutput["patch"]> => {
          const lecture = structuredClone(lectureState(saved)); if (!lecture.quiz) throw new WorkflowError("INVALID_REQUEST"); lecture.quiz.attemptId = id; return { lecture };
        } };
    }
    throw new WorkflowError("INVALID_REQUEST");
  }

  private async appendWorkflowInput(
    context: Readonly<WorkflowContext>,
    turnId: string,
    content: string,
    headers: Headers,
  ) {
    if (!context.conversationId) return;
    try {
      await appendConversationMessage({
        conversationId: context.conversationId,
        role: "user",
        content,
        turnId,
        metadata: { workflow: true, workspaceVisible: false },
      }, headers, this.options.conversationEmbeddingProvider !== undefined
        ? { embeddingProvider: this.options.conversationEmbeddingProvider }
        : {});
    } catch (error) {
      if (error instanceof ConversationError) throw new WorkflowError("REFERENCE_NOT_FOUND");
      throw error;
    }
  }

  private async ownedPlan(id: string | undefined, userId: string, courseId: string, examId: string) {
    const plan = await db().studyPlan.findFirst({ where: { userId, ...(id ? { id } : { status: "ACTIVE", tasks: { some: { examId, userId } } }) }, include: planInclude, orderBy: { updatedAt: "desc" } });
    if (id && !plan) throw new WorkflowError("REFERENCE_NOT_FOUND");
    if (plan && (plan.tasks.length > 200 || !plan.tasks.some((task) => task.examId === examId && task.courseId === courseId) || plan.tasks.some((task) => task.userId !== userId || [task.course, task.topicRecord, task.exam, task.assignment].some((r) => r && r.userId !== userId)))) throw new WorkflowError("REFERENCE_NOT_FOUND");
    return plan;
  }
  private async planCurrent(id: string, userId: string, context: WorkflowContext) {
    const exam = context.exam;
    if (!exam) throw new WorkflowError("INVALID_REQUEST");
    const plan = await this.ownedPlan(id, userId, context.courseId, exam.id);
    if (!plan || plan.status !== "ACTIVE") return false;
    const today = calendarDate(new Date(), context.timezone);
    const remaining = plan.tasks.filter((t) => t.examId === exam.id && (t.status === "PLANNED" || t.status === "IN_PROGRESS"));
    if (!remaining.length || remaining.some((t) => t.date.toISOString().slice(0, 10) < today || t.date.toISOString().slice(0, 10) > calendarDate(new Date(exam.examDate), context.timezone) || t.sourceDueDate?.toISOString() !== exam.examDate)) return false;
    if (context.topics.some((topic) => topic.lastPracticedAt && new Date(topic.lastPracticedAt) > plan.updatedAt)) return false;
    if (remaining.some((task) => {
      const topic = context.topics.find((t) => t.topicId === task.topicId);
      return topic && (Math.abs(topic.mastery - (task.sourceMasteryScore ?? 50)) >= 10 || Math.abs(topic.confidence - (task.sourceConfidenceScore ?? 0)) >= 20);
    })) return false;
    if (context.availability) {
      const available = new Map(context.availability.map((d) => [d.date, d.availableMinutes]));
      const totals = new Map<string, number>();
      for (const task of plan.tasks.filter((t) => t.status !== "SKIPPED")) {
        const date = task.date.toISOString().slice(0, 10);
        if (date >= today) totals.set(date, (totals.get(date) ?? 0) + task.durationMinutes);
      }
      if ([...totals].some(([date, minutes]) => minutes > (available.get(date) ?? 0))) return false;
    }
    return true;
  }
  private async quizCurrent(id: string, userId: string, context: WorkflowContext) {
    const quiz = await db().quiz.findFirst({ where: { id, userId, courseId: context.courseId, createdAt: { gte: new Date(Date.now() - 86400000) }, attempts: { none: { completedAt: { not: null } } } }, include: { questions: { select: { topicNames: true } }, attempts: { where: { userId }, orderBy: { startedAt: "desc" }, take: 1, select: { questionAttempts: { select: { attemptedAt: true }, take: 20 } } } } });
    if (!quiz || quiz.questions.length < 5) return false;
    const names = new Set(quiz.questions.flatMap((q) => q.topicNames).map(normalizeTopicName));
    const observedThrough = Math.max(quiz.createdAt.getTime(), ...quiz.attempts.flatMap((a) => a.questionAttempts.map((q) => q.attemptedAt.getTime())));
    return context.targetTopics.length > 0 && context.targetTopics.every((t) => names.has(normalizeTopicName(t))) && context.topics.every((t) => !t.lastPracticedAt || new Date(t.lastPracticedAt).getTime() <= observedThrough);
  }
}
