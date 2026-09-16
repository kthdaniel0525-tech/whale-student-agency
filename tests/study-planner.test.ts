import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import type {
  AIProvider,
  AIStructuredRequest,
  AIStructuredResponse,
} from "@/server/ai/types";
import {
  AGENT_CAPABILITIES,
  AgentRegistry,
  getStudentAgentDefinitions,
} from "@/server/agents";
import { AgentRouter } from "@/server/agents/router";
import {
  calculatePlanningSignals,
  createPlanningBrief,
  createStudyPlannerAgentService,
  getStudyPlannerAgentDefinition,
  type GeneratedStudyPlan,
  type PlanningBrief,
  type PlanningSignal,
} from "@/server/agents/study-planner";
import type {
  AssignmentContext,
  ExamContext,
  LearningTopicContext,
  UserContext,
} from "@/server/context/types";
import * as retrieval from "@/server/documents/retrieval";

type Actor = { id: string; email: string; headers: Headers };
type Boundary = ReturnType<typeof setupBoundary>;

const actors: Actor[] = [];
let owner: Actor;
let other: Actor;
let mathCourseId: string;
let csCourseId: string;
let otherCourseId: string;
let mathExamId: string;
let csExamId: string;
let assignmentId: string;
let inductionTopicId: string;
let relationsTopicId: string;
let logicTopicId: string;

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const day = (offset: number) =>
  new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const at = (date: string) => new Date(`${date}T12:00:00.000Z`);

async function createActor(label: string): Promise<Actor> {
  const email = `planner-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({
    body: { name: label, email, password: "Planner-test-passphrase-2026!" },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const data = (await response.json()) as { user: { id: string } };
  const actor = {
    id: data.user.id,
    email,
    headers: new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    }),
  };
  actors.push(actor);
  await db().profile.create({
    data: {
      userId: actor.id,
      school: "Planner Test University",
      program: "Computer Science",
      currentYear: 2,
      semester: "Fall 2026",
      academicGoal: "Prepare efficiently",
      studySessionMinutes: 45,
      explanationDifficulty: "INTERMEDIATE",
      timezone: "UTC",
    },
  });
  return actor;
}

async function createCourse(userId: string, code: string, name: string) {
  return db().course.create({
    data: { userId, courseCode: code, courseName: name, semester: "Fall 2026" },
  });
}

async function createProgress(
  userId: string,
  courseId: string,
  name: string,
  values: {
    mastery: number;
    confidence: number;
    recent: number;
    attempts: number;
    correct: number;
    sessions: number;
    trend: "IMPROVING" | "STABLE" | "DECLINING" | "INSUFFICIENT_DATA";
  },
) {
  const topic = await db().learningTopic.create({
    data: {
      userId,
      courseId,
      name,
      normalizedName: name.toLowerCase(),
    },
  });
  const incorrect = values.attempts - values.correct;
  await db().learningProgress.create({
    data: {
      userId,
      courseId,
      topicId: topic.id,
      masteryScore: values.mastery,
      confidenceScore: values.confidence,
      recentAccuracy: values.recent,
      questionsAttempted: values.attempts,
      correctAnswers: values.correct,
      incorrectAnswers: incorrect,
      scoreTotal: values.correct,
      difficultyWeightedScore: values.correct,
      difficultyWeightTotal: values.attempts,
      practiceSessions: values.sessions,
      easyAttempts: 0,
      mediumAttempts: values.attempts,
      hardAttempts: 0,
      firstPracticedAt: new Date(Date.now() - 20 * DAY),
      lastPracticedAt: new Date(),
      trend: values.trend,
    },
  });
  return topic.id;
}

function parameters<T>(input: AIStructuredRequest<T>): PlanningBrief {
  const marker = "Execution parameters: ";
  const content = input.messages[0].content;
  const start = content.indexOf(marker);
  if (start < 0) throw new Error("Missing planning parameters.");
  return JSON.parse(content.slice(start + marker.length)) as PlanningBrief;
}

function generatedPlan(
  brief: PlanningBrief,
  select: (signals: readonly PlanningSignal[]) => PlanningSignal = (signals) =>
    signals[0],
): GeneratedStudyPlan {
  const slot = brief.availability.find((item) => item.availableMinutes >= 15);
  if (!slot) throw new Error("Test plan requires an available slot.");
  const signal = select(brief.signals);
  const duration =
    Math.floor(
      Math.min(
        slot.availableMinutes,
        brief.preferredSessionMinutes,
        brief.maximumSessionMinutes,
      ) / 15,
    ) * 15;
  return {
    title: "Adaptive study plan",
    startDate: brief.startDate,
    endDate: brief.endDate,
    summary: "Focuses available time on the highest-value current work.",
    totalPlannedMinutes: duration,
    days: [
      {
        date: slot.date,
        totalMinutes: duration,
        sessions: [
          {
            signalId: signal.id,
            title: signal.topic
              ? `Practice ${signal.topic}`
              : `Work on ${signal.courseName ?? "course review"}`,
            topic: signal.topic,
            activityType: signal.suggestedActivity,
            durationMinutes: duration,
          },
        ],
      },
    ],
  };
}

function setupBoundary(
  select?: (signals: readonly PlanningSignal[]) => PlanningSignal,
) {
  const briefs: PlanningBrief[] = [];
  let transform: ((plan: GeneratedStudyPlan, brief: PlanningBrief) => unknown) | undefined;
  const structured = vi.fn(
    async <T>(input: AIStructuredRequest<T>): Promise<AIStructuredResponse<T>> => {
      if (input.schemaName === "agent_route") {
        const data = { agentId: "study-planner", confidence: 0.9 } as T;
        return { id: "route", model: "planner-test", text: JSON.stringify(data), data };
      }
      const brief = parameters(input);
      briefs.push(brief);
      const plan = generatedPlan(brief, select);
      const data = (transform ? transform(plan, brief) : plan) as T;
      return {
        id: "study-plan",
        model: "planner-test",
        text: JSON.stringify(data),
        data,
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      };
    },
  );
  const provider: AIProvider = {
    async generateStructuredOutput<T>(input: AIStructuredRequest<T>) {
      return structured(input) as Promise<AIStructuredResponse<T>>;
    },
    generateText() {
      throw new Error("Study Planner must use structured output.");
    },
    streamText() {
      throw new Error("Study Planner does not stream.");
    },
    generateEmbedding() {
      throw new Error("Study Planner does not embed.");
    },
  };
  const getProvider = vi.fn(() => provider);
  return {
    briefs,
    structured,
    getProvider,
    service: createStudyPlannerAgentService({
      router: { getProvider },
      executor: { getProvider },
    }),
    setTransform(next: typeof transform) {
      transform = next;
    },
  };
}

function contextFixture(input: {
  assignments?: AssignmentContext[];
  exams?: ExamContext[];
  topics?: LearningTopicContext[];
}): UserContext {
  const learning = input.topics
    ? { weakTopics: input.topics, strongTopics: [], recommendedTopics: [] }
    : undefined;
  return {
    profile: {
      name: "Student",
      school: "University",
      program: "Math",
      currentYear: 2,
      semester: "Fall",
      academicGoal: "Improve grades",
      explanationDifficulty: "INTERMEDIATE",
      studySessionMinutes: 45,
      timezone: "UTC",
    },
    assignments: input.assignments ?? [],
    exams: input.exams ?? [],
    learning,
    metadata: {
      generatedAt: `${today()}T12:00:00.000Z`,
      requestedCategories: ["profile", "assignments", "exams", "learning"],
      unavailableCategories: [],
      truncatedCategories: [],
      estimatedContextSize: 1,
      estimatedTokens: 1,
      maxCharacters: 24000,
    },
  };
}

function topicFixture(overrides: Partial<LearningTopicContext> = {}): LearningTopicContext {
  return {
    topicId: "topic-fixture",
    topic: "Induction",
    course: { id: "math", courseCode: "MATH 1240", courseName: "Discrete Math" },
    mastery: 42,
    confidence: 88,
    recentAccuracy: 40,
    questionsAttempted: 10,
    practiceSessions: 4,
    status: "developing",
    evidence: "sufficient",
    trend: "declining",
    lastPracticedAt: `${day(-10)}T12:00:00.000Z`,
    ...overrides,
  };
}

beforeAll(async () => {
  owner = await createActor("Planner Owner");
  other = await createActor("Other Planner Student");
  const math = await createCourse(owner.id, "MATH 1240", "Discrete Math");
  const cs = await createCourse(owner.id, "COMP 2140", "Data Structures");
  const privateCourse = await createCourse(other.id, "PRIVATE 999", "Private Course");
  mathCourseId = math.id;
  csCourseId = cs.id;
  otherCourseId = privateCourse.id;
  mathExamId = (
    await db().exam.create({
      data: {
        userId: owner.id,
        courseId: math.id,
        title: "Discrete Math Midterm",
        examDate: at(day(6)),
        topics: ["Mathematical Induction", "Logic"],
      },
    })
  ).id;
  csExamId = (
    await db().exam.create({
      data: {
        userId: owner.id,
        courseId: cs.id,
        title: "Data Structures Exam",
        examDate: at(day(12)),
        topics: ["Linked Lists"],
      },
    })
  ).id;
  assignmentId = (
    await db().assignment.create({
      data: {
        userId: owner.id,
        courseId: math.id,
        title: "Proof Assignment",
        dueDate: at(day(1)),
        priority: "HIGH",
        estimatedHours: 3,
      },
    })
  ).id;
  await db().assignment.create({
    data: {
      userId: owner.id,
      courseId: math.id,
      title: "Already Finished",
      dueDate: at(day(1)),
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
  inductionTopicId = await createProgress(
    owner.id,
    math.id,
    "Mathematical Induction",
    { mastery: 42, confidence: 88, recent: 40, attempts: 10, correct: 4, sessions: 4, trend: "DECLINING" },
  );
  relationsTopicId = await createProgress(owner.id, math.id, "Relations", {
    mastery: 45,
    confidence: 15,
    recent: 50,
    attempts: 2,
    correct: 1,
    sessions: 1,
    trend: "INSUFFICIENT_DATA",
  });
  logicTopicId = await createProgress(owner.id, math.id, "Logic", {
    mastery: 91,
    confidence: 95,
    recent: 90,
    attempts: 10,
    correct: 9,
    sessions: 5,
    trend: "STABLE",
  });
  await db().exam.create({
    data: {
      userId: other.id,
      courseId: privateCourse.id,
      title: "Private Exam",
      examDate: at(day(2)),
      topics: ["Private Topic"],
    },
  });
}, 30_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const actor of actors) {
    await db().user.deleteMany({ where: { id: actor.id, email: actor.email } });
  }
  await db().$disconnect();
});

describe.sequential("Study Planner registration, routing, and priority", () => {
  it("registers the Study Planner with the required shared capabilities and context", () => {
    const definition = getStudyPlannerAgentDefinition();
    expect(getStudentAgentDefinitions().filter((agent) => agent.id === "study-planner")).toEqual([definition]);
    expect(definition.capabilities).toEqual([
      "create-study-plan",
      "update-study-plan",
      "prioritize-deadlines",
      "prioritize-weak-topics",
      "allocate-study-time",
      "rebalance-study-plan",
      "create-daily-plan",
      "create-weekly-plan",
      "exam-preparation",
    ]);
    definition.capabilities.forEach((capability) => expect(AGENT_CAPABILITIES).toContain(capability));
    expect(definition.contextRequirements).toMatchObject({
      profile: true,
      course: true,
      assignments: true,
      exams: true,
      learning: true,
      memories: true,
      memoryKeys: ["academicGoal", "studySessionMinutes", "planningIntensity", "preferredStudyTime"],
    });
    expect(definition.contextRequirements.documents).toBeUndefined();
  });

  it.each([
    "Make me a study plan for my MATH 1240 exam",
    "What should I study tonight?",
    "Update my study schedule",
    "I missed yesterday's study session. Adjust my plan",
    "I have three exams next week. Help me prioritize",
    "I only have two hours tonight",
    "Focus more on my weak topics",
  ])("routes '%s' through the existing Router", async (request) => {
    const registry = new AgentRegistry();
    getStudentAgentDefinitions().forEach((agent) => registry.register(agent));
    const boundary = setupBoundary();
    const route = await new AgentRouter(registry, { getProvider: boundary.getProvider }).routeAgent({ request });
    expect(route).toMatchObject({ agentId: "study-planner", method: "rule" });
  });

  it("prioritizes a nearer exam with larger learning gaps instead of splitting equally", () => {
    const exams: ExamContext[] = [
      {
        id: "near",
        title: "Near exam",
        examDate: `${day(3)}T12:00:00.000Z`,
        topics: ["Induction"],
        daysRemaining: 3,
        course: { id: "math", courseCode: "MATH", courseName: "Math" },
      },
      {
        id: "far",
        title: "Far exam",
        examDate: `${day(20)}T12:00:00.000Z`,
        topics: ["Arrays"],
        daysRemaining: 20,
        course: { id: "cs", courseCode: "CS", courseName: "CS" },
      },
    ];
    const signals = calculatePlanningSignals({
      assignments: [],
      exams,
      learning: {
        weakTopics: [topicFixture()],
        strongTopics: [],
        recommendedTopics: [],
      },
      startDate: today(),
      totalAvailableMinutes: 240,
    });
    expect(signals.find((signal) => signal.id === "exam:near")!.priorityScore).toBeGreaterThan(
      signals.find((signal) => signal.id === "exam:far")!.priorityScore,
    );
    expect(signals.find((signal) => signal.id === "exam:near")!.targetMinutes).toBeGreaterThan(
      signals.find((signal) => signal.id === "exam:far")!.targetMinutes,
    );
  });

  it("uses confidence to choose intensive repair versus diagnostic evidence", () => {
    const highConfidence = topicFixture({ topicId: "known-weak", confidence: 90, mastery: 35 });
    const lowConfidence = topicFixture({ topicId: "uncertain", confidence: 15, mastery: 35 });
    const signals = calculatePlanningSignals({
      assignments: [],
      exams: [],
      learning: { weakTopics: [highConfidence, lowConfidence], strongTopics: [], recommendedTopics: [] },
      startDate: today(),
      totalAvailableMinutes: 120,
    });
    expect(signals.find((signal) => signal.id === "topic:known-weak")!.suggestedActivity).toBe("learn");
    expect(signals.find((signal) => signal.id === "topic:uncertain")!.suggestedActivity).toBe("quiz");
    expect(signals.find((signal) => signal.id === "topic:uncertain")!.reason).toContain("diagnostic");
  });

  it("builds a bounded weekly horizon from profile session preferences", () => {
    const brief = createPlanningBrief(contextFixture({ topics: [topicFixture()] }), {
      mode: "create",
      request: "Plan my week",
    });
    expect(brief).toMatchObject({
      startDate: today(),
      endDate: day(6),
      preferredSessionMinutes: 45,
      maximumSessionMinutes: 90,
      totalAvailableMinutes: 630,
    });
    expect(brief.availability).toHaveLength(7);
  });

  it("infers a stated two-hour limit for tonight without calendar data", () => {
    const brief = createPlanningBrief(contextFixture({ topics: [topicFixture()] }), {
      mode: "create",
      request: "I only have two hours tonight",
    });
    expect(brief).toMatchObject({ startDate: today(), endDate: today(), totalAvailableMinutes: 120 });
    expect(brief.availability).toEqual([{ date: today(), availableMinutes: 120 }]);
    expect(brief.assumptions).toEqual([]);
  });

  it("raises overdue and high-priority assignments above distant low-priority work", () => {
    const course = { id: "math", courseCode: "MATH", courseName: "Math" };
    const assignments: AssignmentContext[] = [
      {
        id: "urgent",
        title: "Urgent proof",
        dueDate: `${day(-1)}T12:00:00.000Z`,
        status: "TODO",
        priority: "HIGH",
        estimatedHours: 3,
        overdue: true,
        course,
      },
      {
        id: "later",
        title: "Later worksheet",
        dueDate: `${day(25)}T12:00:00.000Z`,
        status: "TODO",
        priority: "LOW",
        estimatedHours: 1,
        overdue: false,
        course,
      },
    ];
    const signals = calculatePlanningSignals({ assignments, exams: [], startDate: today(), totalAvailableMinutes: 90 });
    expect(signals[0]).toMatchObject({ id: "assignment:urgent", priority: "urgent", suggestedActivity: "assignment" });
    expect(signals[0].reason).toContain("overdue");
  });
});

describe.sequential("Study Planner generation and persistence", () => {
  it("creates and persists a one-exam plan from real Context Builder data", async () => {
    const boundary = setupBoundary();
    const plan = await boundary.service.createPlan(
      {
        request: "Make me a study plan for my MATH 1240 exam",
        courseId: mathCourseId,
        startDate: today(),
        endDate: day(5),
        availability: [{ date: today(), availableMinutes: 90 }],
      },
      owner.headers,
    );
    expect(plan).toMatchObject({ status: "active", totalPlannedMinutes: 45, metadata: { model: "planner-test" } });
    expect(plan.days[0].sessions[0].reason).toMatch(/due|mastery|exam/i);
    expect(await db().studyPlan.count({ where: { id: plan.id, userId: owner.id } })).toBe(1);
    expect(boundary.briefs[0].signals.some((signal) => signal.linkedExamId === mathExamId)).toBe(true);
    expect(boundary.briefs[0].signals.some((signal) => signal.linkedAssignmentId === assignmentId)).toBe(true);
    expect(JSON.stringify(boundary.briefs[0].signals)).not.toContain("Already Finished");
    expect(boundary.briefs[0].signals.some((signal) => signal.topicId === inductionTopicId)).toBe(true);
    expect(boundary.briefs[0].signals.some((signal) => signal.topicId === logicTopicId)).toBe(true);
  });

  it("passes both exams and gives them distinct deterministic priorities", async () => {
    const boundary = setupBoundary();
    await boundary.service.createPlan(
      {
        request: "I have three exams next week. Help me prioritize",
        startDate: today(),
        endDate: day(6),
        availability: [{ date: today(), availableMinutes: 120 }],
      },
      owner.headers,
    );
    const exams = boundary.briefs[0].signals.filter((signal) => signal.kind === "exam");
    expect(exams.map((signal) => signal.linkedExamId)).toEqual(expect.arrayContaining([mathExamId, csExamId]));
    expect(exams.some((signal) => signal.courseId === csCourseId)).toBe(true);
    expect(new Set(exams.map((signal) => signal.priorityScore)).size).toBeGreaterThan(1);
  });

  it("uses weak and strong learning state while keeping uncertain topics diagnostic", async () => {
    const boundary = setupBoundary((signals) => signals.find((signal) => signal.topicId === relationsTopicId)!);
    const plan = await boundary.service.createPlan(
      {
        request: "Create a study plan focused on my weak topics",
        courseId: mathCourseId,
        startDate: today(),
        endDate: day(2),
        availability: [{ date: today(), availableMinutes: 120 }],
      },
      owner.headers,
    );
    const signal = boundary.briefs[0].signals.find((item) => item.topicId === relationsTopicId)!;
    expect(signal).toMatchObject({ suggestedActivity: "quiz", sourceConfidenceScore: expect.any(Number) });
    expect(plan.days[0].sessions[0]).toMatchObject({ topicId: relationsTopicId, activityType: "quiz" });
    expect(boundary.briefs[0].signals.find((item) => item.topicId === logicTopicId)!.priorityScore).toBeLessThan(
      boundary.briefs[0].signals.find((item) => item.topicId === inductionTopicId)!.priorityScore,
    );
  });

  it("respects exact availability and realistic session bounds", async () => {
    const boundary = setupBoundary();
    const plan = await boundary.service.createPlan(
      {
        request: "I only have two hours tonight",
        startDate: today(),
        endDate: today(),
        availability: [{ date: today(), availableMinutes: 50 }],
        preferredSessionMinutes: 45,
      },
      owner.headers,
    );
    expect(plan.totalPlannedMinutes).toBe(45);
    expect(plan.days[0].totalMinutes).toBeLessThanOrEqual(50);
    expect(plan.days[0].sessions[0].durationMinutes).toBeGreaterThanOrEqual(15);
    expect(plan.days[0].sessions[0].durationMinutes).toBeLessThanOrEqual(90);
  });

  it("identifies the availability assumption when no schedule is supplied", async () => {
    const boundary = setupBoundary();
    const plan = await boundary.service.createPlan(
      { request: "Plan my week", startDate: today(), endDate: day(2) },
      owner.headers,
    );
    expect(plan.assumptions).toEqual([expect.stringContaining("90 available study minutes per day")]);
    expect(boundary.briefs[0].totalAvailableMinutes).toBe(270);
  });

  it("rejects structured output that exceeds a day's availability before storage", async () => {
    const boundary = setupBoundary();
    boundary.setTransform((plan) => ({
      ...plan,
      totalPlannedMinutes: 90,
      days: [
        {
          ...plan.days[0],
          totalMinutes: 90,
          sessions: [{ ...plan.days[0].sessions[0], durationMinutes: 90 }],
        },
      ],
    }));
    const before = await db().studyPlan.count({ where: { userId: owner.id } });
    await expect(
      boundary.service.createPlan(
        {
          request: "What should I study today?",
          availability: [{ date: today(), availableMinutes: 30 }],
        },
        owner.headers,
      ),
    ).rejects.toMatchObject({ code: "INVALID_PLAN_RESPONSE" });
    expect(await db().studyPlan.count({ where: { userId: owner.id } })).toBe(before);
  });

  it("does not retrieve documents for normal scheduling", async () => {
    const retrieve = vi.spyOn(retrieval, "retrieveAcademicContext");
    const boundary = setupBoundary();
    await boundary.service.createPlan(
      {
        request: "Plan my week",
        availability: [{ date: today(), availableMinutes: 45 }],
      },
      owner.headers,
    );
    expect(retrieve).not.toHaveBeenCalled();
    expect(boundary.briefs).toHaveLength(1);
  });

  it("enables bounded document context when lecture coverage is requested", async () => {
    const retrieve = vi.spyOn(retrieval, "retrieveAcademicContext").mockResolvedValue([]);
    const boundary = setupBoundary();
    await boundary.service.createPlan(
      {
        request: "Plan based on my lecture coverage",
        courseId: mathCourseId,
        availability: [{ date: today(), availableMinutes: 45 }],
      },
      owner.headers,
    );
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("never includes another student's exams, course, or topics", async () => {
    const boundary = setupBoundary();
    await boundary.service.createPlan(
      {
        request: "Plan my week",
        availability: [{ date: today(), availableMinutes: 45 }],
      },
      owner.headers,
    );
    expect(JSON.stringify(boundary.briefs[0])).not.toMatch(/Private Exam|Private Topic|PRIVATE 999/);
  });
});

describe.sequential("Study Planner replanning, study-now, and ownership", () => {
  async function createForReplanning(boundary: Boundary, selectExam = false) {
    if (selectExam) {
      boundary = setupBoundary((signals) => signals.find((signal) => signal.linkedExamId === mathExamId && signal.kind === "exam")!);
    }
    const plan = await boundary.service.createPlan(
      {
        request: "Make me a study plan for my exam",
        courseId: mathCourseId,
        startDate: today(),
        endDate: day(5),
        availability: [{ date: today(), availableMinutes: 120 }],
      },
      owner.headers,
    );
    return { boundary, plan };
  }

  it("preserves completed tasks and deducts their minutes during replanning", async () => {
    const initial = await createForReplanning(setupBoundary());
    const completedId = initial.plan.days[0].sessions[0].id;
    await initial.boundary.service.updateTaskStatus(completedId, "completed", owner.headers);
    const updated = await initial.boundary.service.updatePlan(
      {
        planId: initial.plan.id,
        request: "Update my study plan",
        courseId: mathCourseId,
        startDate: today(),
        endDate: day(2),
        availability: [{ date: today(), availableMinutes: 120 }],
      },
      owner.headers,
    );
    expect(updated.days.flatMap((item) => item.sessions)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: completedId, status: "completed" })]),
    );
    expect(initial.boundary.briefs[1].totalAvailableMinutes).toBe(75);
    expect(initial.boundary.briefs[1].changes?.completedTasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: completedId })]),
    );
  });

  it("detects missed work, skips the stale task, and schedules replacement work", async () => {
    const initial = await createForReplanning(setupBoundary());
    const missedId = initial.plan.days[0].sessions[0].id;
    await db().studyTask.update({ where: { id: missedId }, data: { date: at(day(-1)) } });
    const updated = await initial.boundary.service.updatePlan(
      {
        planId: initial.plan.id,
        request: "I missed yesterday's study session. Adjust my plan",
        courseId: mathCourseId,
        startDate: today(),
        endDate: day(2),
        availability: [{ date: today(), availableMinutes: 90 }],
      },
      owner.headers,
    );
    expect(initial.boundary.briefs[1].changes?.missedTasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: missedId })]),
    );
    expect(updated.days.flatMap((item) => item.sessions).find((item) => item.id === missedId)?.status).toBe("skipped");
    expect(updated.days.flatMap((item) => item.sessions).some((item) => item.status === "planned")).toBe(true);
  });

  it("reports an exam-date delta before generating an updated plan", async () => {
    const initial = await createForReplanning(setupBoundary(), true);
    const originalExam = await db().exam.findUniqueOrThrow({ where: { id: mathExamId } });
    await db().exam.update({ where: { id: mathExamId }, data: { examDate: at(day(8)) } });
    try {
      await initial.boundary.service.updatePlan(
        {
          planId: initial.plan.id,
          request: "Update my study schedule because the exam date changed",
          courseId: mathCourseId,
          startDate: today(),
          endDate: day(7),
          availability: [{ date: today(), availableMinutes: 90 }],
        },
        owner.headers,
      );
      expect(initial.boundary.briefs[1].changes?.changedDeadlines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            previousDate: dateOnlyForTest(originalExam.examDate),
            currentDate: day(8),
          }),
        ]),
      );
    } finally {
      await db().exam.update({ where: { id: mathExamId }, data: { examDate: originalExam.examDate } });
    }
  });

  it("returns a highest-value study-now action without persisting a new plan", async () => {
    const boundary = setupBoundary();
    const before = await db().studyPlan.count({ where: { userId: owner.id } });
    const result = await boundary.service.recommendNow(
      { request: "What should I study right now?", courseId: mathCourseId, availableMinutes: 35 },
      owner.headers,
    );
    expect(result).toMatchObject({ date: today(), totalMinutes: 30 });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].reason.length).toBeGreaterThan(10);
    expect(boundary.briefs[0].signals.some((signal) => signal.id.startsWith("planned-task:"))).toBe(true);
    expect(await db().studyPlan.count({ where: { userId: owner.id } })).toBe(before);
  });

  it("updates task and plan status without losing persisted task history", async () => {
    const initial = await createForReplanning(setupBoundary());
    const taskId = initial.plan.days[0].sessions[0].id;
    const completed = await initial.boundary.service.updateTaskStatus(taskId, "completed", owner.headers);
    expect(completed.status).toBe("completed");
    expect(completed.days[0].sessions[0]).toMatchObject({ id: taskId, status: "completed" });
  });

  it("protects plans and tasks from cross-user reads and writes", async () => {
    const initial = await createForReplanning(setupBoundary());
    const taskId = initial.plan.days[0].sessions[0].id;
    await expect(initial.boundary.service.getPlan(initial.plan.id, other.headers)).rejects.toMatchObject({
      code: "PLAN_NOT_FOUND",
    });
    await expect(
      initial.boundary.service.updateTaskStatus(taskId, "completed", other.headers),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(
      initial.boundary.service.createPlan(
        {
          request: "Plan my week",
          courseId: otherCourseId,
          availability: [{ date: today(), availableMinutes: 45 }],
        },
        owner.headers,
      ),
    ).rejects.toBeTruthy();
  });

  it("detects material mastery changes from stored task snapshots", async () => {
    const boundary = setupBoundary((signals) => signals.find((signal) => signal.topicId === inductionTopicId)!);
    const initial = await createForReplanning(boundary);
    const original = await db().learningProgress.findUniqueOrThrow({
      where: { userId_courseId_topicId: { userId: owner.id, courseId: mathCourseId, topicId: inductionTopicId } },
    });
    await db().learningProgress.update({ where: { id: original.id }, data: { masteryScore: 62 } });
    try {
      await boundary.service.updatePlan(
        {
          planId: initial.plan.id,
          request: "Update my study plan",
          courseId: mathCourseId,
          startDate: today(),
          endDate: day(2),
          availability: [{ date: today(), availableMinutes: 90 }],
        },
        owner.headers,
      );
      expect(boundary.briefs[1].changes?.masteryChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ topic: "Mathematical Induction", previousMastery: 42, currentMastery: 62 }),
        ]),
      );
    } finally {
      await db().learningProgress.update({ where: { id: original.id }, data: { masteryScore: original.masteryScore } });
    }
  });
});

function dateOnlyForTest(value: Date): string {
  return value.toISOString().slice(0, 10);
}
