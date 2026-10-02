import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import type {
  AIProvider,
  AIStructuredRequest,
} from "@/server/ai/types";
import type { PlanningBrief } from "@/server/agents/study-planner/types";
import { QuizAgentService } from "@/server/agents/quiz/service";
import { createStudentAgentRegistry } from "@/server/agents/student-service";
import { IntelligentDispatcher } from "@/server/dispatcher";
import { embeddingProvider } from "@/server/documents/embeddings";
import { getLearningTopicStates } from "@/server/learning";
import { WorkflowService } from "@/server/workflows";
import type { WorkflowResult } from "@/server/workflows/types";

const DAY = 86_400_000;
const passage =
  "Mathematical induction proves statements over natural numbers. Establish the base case, assume P(k) as the inductive hypothesis, and prove P(k+1). A common error is using the inductive hypothesis before proving the base case.";

type Actor = { id: string; headers: Headers };
let student: Actor;
let courseId: string;
let examId: string;
let documentId: string;

async function createActor(): Promise<Actor> {
  const response = await auth().api.signUpEmail({
    body: {
      name: "Journey Student",
      email: `journey-${randomUUID()}@example.test`,
      password: "Journey-test-passphrase!",
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  return {
    id: body.user.id,
    headers: new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    }),
  };
}

function executionParameters(request: AIStructuredRequest<unknown>) {
  const marker = "Execution parameters: ";
  const content = request.messages[0].content;
  const start = content.lastIndexOf(marker);
  if (start < 0) return {};
  const raw = content.slice(start + marker.length);
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(raw.split("\n").at(-1)!);
  }
}

function referenceData(request: AIStructuredRequest<unknown>) {
  const message = request.messages.find((item) =>
    item.content.startsWith("Additional reference data"),
  );
  return message
    ? JSON.parse(message.content.split("\n").slice(1).join("\n"))
    : {};
}

function providerBoundary() {
  const calls: string[] = [];
  const usage = { inputTokens: 100, outputTokens: 25, totalTokens: 125 };
  const provider: AIProvider = {
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      calls.push(request.schemaName);
      const params = executionParameters(
        request as AIStructuredRequest<unknown>,
      ) as Record<string, unknown>;
      let data: unknown;
      if (request.schemaName === "study_notes") {
        data = {
          title: "Lecture 4 induction notes",
          focusCovered: true,
          topics: ["Mathematical Induction"],
          concepts: [
            {
              topic: "Mathematical Induction",
              complexity: "intermediate",
              keyIdea: "Prove a base case, then prove the successor step.",
              definitions: ["P(k) is the inductive hypothesis."],
              formulasOrProcedures: ["P(1), P(k) implies P(k+1)"],
              notes: "Verify the base case before using the hypothesis.",
              sourceIndices: [0],
            },
          ],
        };
      } else if (request.schemaName === "lecture_explanation") {
        data = {
          explanations: [
            {
              topic: "Mathematical Induction",
              explanation:
                "The base case anchors the proof; the inductive step advances it.",
              workedExample: "Show P(1), assume P(k), then derive P(k+1).",
              understandingCheck: "Why must the base case come first?",
              sourceIndices: [0],
            },
          ],
        };
      } else if (request.schemaName === "quiz_generation") {
        const reference = referenceData(
          request as AIStructuredRequest<unknown>,
        ) as { practiceTopics?: string[] };
        const count = Number(params.count ?? 5);
        const topics = reference.practiceTopics?.length
          ? reference.practiceTopics
          : String(params.topic ?? "Mathematical Induction")
              .split(",")
              .map((value) => value.trim());
        const difficulty =
          params.difficulty === "adaptive"
            ? "medium"
            : String(params.difficulty ?? "medium");
        data = {
          quizTitle: "Induction practice",
          topic: topics.join(", "),
          difficulty,
          questions: Array.from({ length: count }, (_, index) => ({
            type: index % 2 ? "short-answer" : "true-false",
            prompt: `Induction question ${index + 1}: explain the base case.`,
            choices: index % 2 ? null : ["True", "False"],
            correctAnswer: "true",
            explanation: "A valid induction proof needs a base case.",
            topics: [topics[index % topics.length]],
          })),
        };
      } else if (request.schemaName === "quiz_answer_evaluation") {
        const answer = JSON.parse(request.messages[1].content) as {
          userAnswer: string;
        };
        const correct = answer.userAnswer === "true";
        data = {
          correct,
          score: correct ? 1 : 0,
          feedback: correct ? "Correct." : "Review the base case.",
          explanation: "The base case anchors the induction argument.",
        };
      } else if (request.schemaName === "academic_manager") {
        data = {
          summary:
            "Prioritize induction practice, then follow the current exam plan.",
        };
      } else if (request.schemaName.startsWith("study_plan")) {
        const brief = params as unknown as PlanningBrief;
        const slot = brief.availability.find(
          (item) => item.availableMinutes >= 15,
        )!;
        const signal =
          brief.signals.find((item) => item.linkedExamId) ?? brief.signals[0];
        const duration = Math.min(
          45,
          slot.availableMinutes,
          brief.maximumSessionMinutes,
        );
        data = {
          title: "MATH 1240 midterm plan",
          startDate: brief.startDate,
          endDate: brief.endDate,
          summary: "Repair induction first and retain time for mixed review.",
          totalPlannedMinutes: duration,
          days: [
            {
              date: slot.date,
              totalMinutes: duration,
              sessions: [
                {
                  signalId: signal.id,
                  title: "Practice mathematical induction",
                  topic: signal.topic,
                  activityType: signal.suggestedActivity,
                  durationMinutes: duration,
                },
              ],
            },
          ],
        };
      } else {
        throw new Error(`Unexpected structured call: ${request.schemaName}`);
      }
      return {
        id: `journey-${request.schemaName}`,
        model: "journey-fixture",
        text: JSON.stringify(data),
        data: data as T,
        usage,
      };
    },
    async generateText() {
      calls.push("tutor");
      return {
        id: "journey-tutor",
        model: "journey-fixture",
        text: "Start with P(1), assume P(k), and prove P(k+1).",
        usage,
      };
    },
    streamText() {
      throw new Error("Streaming is outside this journey.");
    },
    generateEmbedding() {
      throw new Error("Course RAG uses the existing local embedding provider.");
    },
  };
  return { provider, calls, getProvider: () => provider };
}

async function answerQuiz(
  service: WorkflowService,
  quiz: QuizAgentService,
  run: WorkflowResult,
  answer: string,
) {
  const saved = await quiz.getQuiz(run.waitingFor!.referenceId, student.headers);
  let quizAttemptId: string | undefined;
  for (const question of saved.questions) {
    quizAttemptId = (
      await service.submitWorkflowAnswer(
        {
          runId: run.runId,
          questionId: question.id,
          userAnswer: answer,
          ...(quizAttemptId ? { quizAttemptId } : {}),
        },
        student.headers,
      )
    ).quizAttemptId;
  }
  return quizAttemptId!;
}

beforeAll(async () => {
  student = await createActor();
  await db().profile.create({
    data: {
      userId: student.id,
      school: "Journey University",
      program: "Computer Science",
      currentYear: 2,
      semester: "Fall 2026",
      academicGoal: "Prepare for the MATH 1240 midterm",
      studySessionMinutes: 45,
      explanationDifficulty: "INTERMEDIATE",
      timezone: "UTC",
    },
  });
  const course = await db().course.create({
    data: {
      userId: student.id,
      courseCode: "MATH 1240",
      courseName: "Discrete Mathematics",
      semester: "Fall 2026",
    },
  });
  courseId = course.id;
  examId = (
    await db().exam.create({
      data: {
        userId: student.id,
        courseId,
        title: "MATH 1240 Midterm",
        examDate: new Date(Date.now() + 7 * DAY),
        topics: ["Mathematical Induction"],
      },
    })
  ).id;
  const document = await db().document.create({
    data: {
      userId: student.id,
      courseId,
      title: "Lecture 4: Mathematical Induction",
      originalFileName: "lecture-4.pdf",
      fileType: "PDF",
      fileSize: passage.length,
      storageKey: randomUUID(),
      processingStatus: "READY",
      embeddingModel: embeddingProvider.id,
      pageCount: 8,
    },
  });
  documentId = document.id;
  const vector = JSON.stringify(await embeddingProvider.generateEmbedding(passage));
  await db().$executeRaw`
    INSERT INTO "DocumentChunk" (id,"documentId","userId","courseId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata)
    VALUES (${randomUUID()},${documentId},${student.id},${courseId},0,${passage},4,4,45,${vector}::vector,${embeddingProvider.id},'{}'::jsonb)
  `;
}, 30_000);

afterAll(async () => {
  await db().user.deleteMany({ where: { id: student.id } });
  await db().fileDeletion.deleteMany({ where: { userId: student.id } });
  await db().$disconnect();
});

describe.sequential("complete student journey", () => {
  it("keeps RAG, grading, learning, recovery, planning and overview consistent", async () => {
    const ai = providerBoundary();
    const dispatcher = new IntelligentDispatcher({ getProvider: ai.getProvider });
    const workflow = new WorkflowService({ getProvider: ai.getProvider });
    const quiz = new QuizAgentService(createStudentAgentRegistry(), {
      getProvider: ai.getProvider,
    });

    const tutor = await dispatcher.handleUserAIRequest(
      {
        request: "Explain mathematical induction using my lecture.",
        courseId,
        documentId,
      },
      student.headers,
    );
    expect(tutor).toMatchObject({
      mode: "agent",
      target: { id: "tutor" },
      result: {
        ok: true,
        response: {
          sources: [
            {
              documentId,
              documentTitle: "Lecture 4: Mathematical Induction",
              pageNumber: 4,
            },
          ],
        },
      },
      metrics: { aiCalls: 1, ragCalls: 1, workflowSteps: 0, success: true },
    });

    const lectureResult = await dispatcher.handleUserAIRequest(
      {
        request: "Study this lecture with me and quiz me.",
        courseId,
        documentId,
      },
      student.headers,
    );
    expect(lectureResult).toMatchObject({
      mode: "workflow",
      target: { id: "lecture-study" },
      result: { status: "waiting-for-input", waitingFor: { kind: "quiz" } },
      metrics: {
        aiCalls: 3,
        ragCalls: expect.any(Number),
        workflowSteps: 3,
        success: true,
      },
    });
    if (!("mode" in lectureResult) || lectureResult.mode !== "workflow")
      throw new Error("Lecture workflow did not start.");
    expect(lectureResult.metrics.ragCalls).toBeGreaterThanOrEqual(3);
    expect(lectureResult.result.outputs.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId, pageNumber: 4 }),
      ]),
    );

    const weakAttemptId = await answerQuiz(
      workflow,
      quiz,
      lectureResult.result,
      "false",
    );
    const lectureDone = await workflow.resumeWorkflow(
      { runId: lectureResult.result.runId, quizAttemptId: weakAttemptId },
      student.headers,
    );
    expect(lectureDone.status).toBe("completed");
    let learning = await getLearningTopicStates({
      userId: student.id,
      courseId,
    });
    const weak = learning.find(
      (topic) => topic.topic === "Mathematical Induction",
    )!;
    expect(weak).toMatchObject({ questionsAttempted: 6 });
    expect(weak.mastery).toBeLessThan(50);

    const recoveryResult = await dispatcher.handleUserAIRequest(
      {
        request: "I keep getting induction wrong. Help me fix it.",
        courseId,
        topicId: weak.id,
      },
      student.headers,
    );
    expect(recoveryResult).toMatchObject({
      mode: "workflow",
      target: { id: "weak-topic-recovery" },
      result: { status: "waiting-for-input" },
    });
    if (!("mode" in recoveryResult) || recoveryResult.mode !== "workflow")
      throw new Error("Recovery workflow did not start.");
    let recovery = recoveryResult.result;
    for (let round = 0; round < 2 && recovery.status === "waiting-for-input"; round++) {
      const attemptId = await answerQuiz(workflow, quiz, recovery, "true");
      recovery = await workflow.resumeWorkflow(
        { runId: recovery.runId, quizAttemptId: attemptId },
        student.headers,
      );
    }
    expect(recovery.status).toBe("completed");
    learning = await getLearningTopicStates({ userId: student.id, courseId });
    const improved = learning.find((topic) => topic.id === weak.id)!;
    expect(improved.questionsAttempted).toBeGreaterThan(weak.questionsAttempted);
    expect(improved.mastery).toBeGreaterThan(weak.mastery);

    const today = new Date().toISOString().slice(0, 10);
    const examResult = await dispatcher.handleUserAIRequest(
      {
        request: "Prepare me for my MATH 1240 midterm.",
        courseId,
        examId,
        availability: [{ date: today, availableMinutes: 120 }],
      },
      student.headers,
    );
    expect(examResult, JSON.stringify(examResult)).toMatchObject({
      mode: "workflow",
      target: { id: "exam-preparation" },
      result: {
        status: "completed",
        outputs: { studyPlanId: expect.any(String) },
      },
      metrics: { success: true },
    });
    if (!("mode" in examResult) || examResult.mode !== "workflow")
      throw new Error("Exam preparation did not start.");
    const planId = examResult.result.outputs.studyPlanId as string;
    const plan = await db().studyPlan.findFirst({
      where: { id: planId, userId: student.id },
      include: { tasks: true },
    });
    expect(plan).not.toBeNull();
    expect(plan!.tasks).toContainEqual(
      expect.objectContaining({
        examId,
        courseId,
        durationMinutes: 45,
      }),
    );

    const overview = await dispatcher.handleUserAIRequest(
      { request: "How am I doing this semester?", courseId },
      student.headers,
    );
    expect(overview).toMatchObject({
      mode: "agent",
      target: { id: "academic-manager" },
      result: { ok: true },
      metrics: { aiCalls: 1, ragCalls: 0, workflowSteps: 0, success: true },
    });
    if (!("mode" in overview) || overview.mode !== "agent" || !overview.result.ok)
      throw new Error("Academic overview did not complete.");
    const snapshot = overview.result.response.structuredData as {
      academicSnapshot: { weakestTopics: { topic: string }[] };
    };
    expect(snapshot.academicSnapshot.weakestTopics).toContainEqual(
      expect.objectContaining({ topic: "Mathematical Induction" }),
    );
    expect(ai.calls.filter((call) => call === "intelligent_dispatch")).toHaveLength(0);
  }, 30_000);
});
