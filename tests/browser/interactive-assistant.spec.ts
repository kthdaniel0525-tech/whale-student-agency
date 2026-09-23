import "dotenv/config";
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

for (const mobile of [false, true]) {
test(`uses interactive Agent and Workflow results without a second execution system (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
  test.setTimeout(120000);
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const email = `interactive-assistant-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const headers = { Origin: "http://localhost:3000" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", { headers, data: { name: "Interactive Student", email, password: "Interactive-assistant-passphrase-2026!" } });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id;
    expect((await page.request.put("/api/student/profile", { headers, data: { name: "Interactive Student", school: "Test University", program: "Mathematics", currentYear: 2, semester: "Fall 2026", academicGoal: "Master proofs", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "America/Winnipeg" } })).ok()).toBe(true);
    const courseResponse = await page.request.post("/api/student/courses", { headers, data: { courseCode: "MATH 1240", courseName: "Discrete Mathematics", semester: "Fall 2026", professor: "", description: "" } });
    const courseId = (await courseResponse.json()).id as string;

    const streamRequests: Array<Record<string, unknown>> = [];
    let sequence = 0;
    const quiz = {
      id: "interactive-quiz", title: "Induction check", topic: "Induction", difficulty: "medium",
      questions: [
        { id: "quiz-q1", type: "multiple-choice", prompt: "What starts an induction proof?", choices: ["Base case", "Conclusion", "Counterexample", "Recursion"], topics: ["Induction"] },
        { id: "quiz-q2", type: "short-answer", prompt: "What does the inductive step prove?", choices: null, topics: ["Induction"] },
      ],
    };
    const taskStatuses = new Map([["study-task-one", "planned"], ["study-task-two", "planned"]]);
    const studyPlan = () => ({
      id: "study-plan-one", title: "Proof review plan", startDate: "2026-09-16", endDate: "2026-09-16", summary: "Repair induction and verify logic.", totalPlannedMinutes: 75, assumptions: [],
      days: [{ date: "2026-09-16", totalMinutes: 75, sessions: [
        { id: "study-task-one", date: "2026-09-16", title: "Learn induction", courseId, courseName: "MATH 1240", topicId: "topic-one", topic: "Induction", examId: null, assignmentId: null, activityType: "learn", durationMinutes: 45, priority: 90, status: taskStatuses.get("study-task-one"), reason: "Induction needs focused repair." },
        { id: "study-task-two", date: "2026-09-16", title: "Quiz logic", courseId, courseName: "MATH 1240", topicId: "topic-two", topic: "Logic", examId: null, assignmentId: null, activityType: "quiz", durationMinutes: 30, priority: 70, status: taskStatuses.get("study-task-two"), reason: "Verify current understanding." },
      ] }],
    });

    await page.route("**/api/student/assistant/requests/stream", async (route) => {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      streamRequests.push(input);
      sequence++;
      const now = new Date().toISOString();
      const base = {
        conversation: { id: "interactive-conversation", title: String(input.request), courseId: input.courseId ?? null, courseName: "MATH 1240 Discrete Mathematics", messageCount: sequence * 2, lastMessageAt: now },
        userMessage: { id: `user-${sequence}`, turnId: input.turnId, role: "user", content: input.request, agentId: null, createdAt: now, metadata: { workspaceVisible: true } },
      };
      const request = String(input.request);
      let assistantMessage: Record<string, unknown>;
      if (input.preferredAgentId === "notes") {
        const data = { title: "Induction review", topics: ["Induction"], concepts: [{ topic: "Induction", complexity: "intermediate", keyIdea: "Prove a base case, then prove the implication.", definitions: ["Base case: the first verified statement."], formulasOrProcedures: ["P(k) → P(k+1)"], notes: "State the hypothesis before using it." }] };
        assistantMessage = { id: `assistant-${sequence}`, turnId: input.turnId, role: "assistant", content: "Your structured notes are ready.", agentId: "notes", createdAt: now, metadata: { workspaceVisible: true }, presentation: { mode: "agent", kind: "agent", targetId: "notes", targetName: "Notes", structuredData: data, actions: [{ id: "notes-quiz", label: "Turn into quiz", targetType: "agent", targetId: "quiz", prompt: "Create a quiz from the notes you just prepared.", payload: { courseId }, style: "primary" }] } };
      } else if (input.preferredAgentId === "quiz") {
        assistantMessage = { id: `assistant-${sequence}`, turnId: input.turnId, role: "assistant", content: "I created a focused quiz.", agentId: "quiz", createdAt: now, metadata: { workspaceVisible: true }, presentation: { mode: "agent", kind: "agent", targetId: "quiz", targetName: "Quiz", quiz } };
      } else if (input.preferredAgentId === "study-planner") {
        assistantMessage = { id: `assistant-${sequence}`, turnId: input.turnId, role: "assistant", content: "Your study plan is ready.", agentId: "study-planner", createdAt: now, metadata: { workspaceVisible: true }, presentation: { mode: "agent", kind: "agent", targetId: "study-planner", targetName: "Study Planner", studyPlan: studyPlan() } };
      } else if (input.preferredAgentId === "academic-manager") {
        const data = { overallStatus: "moderate", topPriorities: [{ reason: "The induction exam is approaching." }], risks: [{ reason: "Induction practice is behind schedule." }], examReadiness: [{ examId: "exam-one", title: "Midterm", readinessLevel: "moderate", explanation: "Core coverage is incomplete." }], recommendedActions: [{ action: "Review Induction", reason: "Repair the main gap.", agentId: "tutor", courseId }] };
        assistantMessage = { id: `assistant-${sequence}`, turnId: input.turnId, role: "assistant", content: "Focus on induction first.", agentId: "academic-manager", createdAt: now, metadata: { workspaceVisible: true }, presentation: { mode: "agent", kind: "agent", targetId: "academic-manager", targetName: "Academic Manager", structuredData: data, actions: [{ id: "manager-review", label: "Review Induction", targetType: "agent", targetId: "tutor", prompt: "Review Induction. Repair the main gap.", payload: { courseId }, style: "primary" }] } };
      } else if (input.preferredAgentId === "career") {
        const data = { strengths: ["Clear project documentation"], gaps: ["No deployment evidence yet"], recommendedSkills: ["Practice deployment"], recommendedProjects: [{ recommendation: "Deploy the current project" }], resumeBullets: [{ improved: "Built a structured academic planning platform" }], nextActions: ["Deploy and document one project"] };
        assistantMessage = { id: `assistant-${sequence}`, turnId: input.turnId, role: "assistant", content: "Here is your grounded career review.", agentId: "career", createdAt: now, metadata: { workspaceVisible: true }, presentation: { mode: "agent", kind: "agent", targetId: "career", targetName: "Career", structuredData: data, actions: [{ id: "career-resume", label: "Improve resume", targetType: "agent", targetId: "career", prompt: "Improve my resume from this evidence.", style: "primary" }] } };
      } else if (/assignment workflow/i.test(request)) {
        const workflow = { runId: "workflow-one", workflowId: "assignment-support", status: "waiting-for-input", summary: "Requirements identified. Add your draft.", completedSteps: ["understand"], steps: [{ stepId: "understand", agentId: "notes", status: "completed", outputSummary: "Three requirements identified.", errorCode: null }, { stepId: "review", agentId: "tutor", status: "pending", outputSummary: null, errorCode: null }], warnings: [], errorCode: null, recommendedNextAction: "Add your draft.", waitingFor: { kind: "student-work", referenceId: "assignment-one" } };
        assistantMessage = { id: `assistant-${sequence}`, turnId: input.turnId, role: "assistant", content: workflow.summary, agentId: null, createdAt: now, metadata: { workspaceVisible: true }, presentation: { mode: "workflow", kind: "workflow", targetId: "assignment-support", targetName: "Assignment Support", workflow } };
      } else {
        assistantMessage = { id: `assistant-${sequence}`, turnId: input.turnId, role: "assistant", content: request.includes("another example") ? "Here is another induction example." : request.startsWith("Start this study task") ? "Let’s begin the planned induction lesson." : "Induction proves a statement by establishing a base and a repeatable step.", agentId: "tutor", createdAt: now, metadata: { workspaceVisible: true }, presentation: { mode: "agent", kind: "agent", targetId: "tutor", targetName: "Tutor", sources: [{ documentId: "document-one", documentTitle: "Proof Lecture", pageNumber: 4, pageEnd: 4, chunkIndex: 0 }], actions: [{ id: "tutor-example", label: "Another example", targetType: "agent", targetId: "tutor", prompt: "Give me another example of the concept from your previous answer.", style: "secondary" }, { id: "tutor-check", label: "Test my understanding", targetType: "agent", targetId: "quiz", prompt: "Give me one quick question.", style: "primary" }] } };
      }
      await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "result", data: { ...base, assistantMessage } })}\n` });
    });

    let shortAnswerAttempts = 0;
    await page.route("**/api/student/assistant/quizzes/interactive-quiz/answers", async (route) => {
      const input = route.request().postDataJSON() as { questionId: string; userAnswer: string };
      const first = input.questionId === "quiz-q1";
      if (!first && shortAnswerAttempts++ === 0) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Grading is temporarily unavailable." }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ quizId: "interactive-quiz", questionId: input.questionId, quizAttemptId: "attempt-one", correct: first, score: first ? 1 : .5, feedback: first ? "Correct." : "Partially correct.", explanation: first ? "The base case starts induction." : "The step proves P(k) implies P(k+1)." }) });
    });
    await page.route("**/api/student/assistant/study-tasks/*", async (route) => {
      const taskId = route.request().url().split("/").pop()!;
      const input = route.request().postDataJSON() as { status: string };
      taskStatuses.set(taskId, input.status);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(studyPlan()) });
    });
    let resumeCount = 0;
    await page.route("**/api/student/assistant/workflows/workflow-one/resume", async (route) => {
      resumeCount++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const now = new Date().toISOString();
      const completed = { runId: "workflow-one", workflowId: "assignment-support", status: "completed", summary: "Assignment review complete.", completedSteps: ["understand", "review"], steps: [{ stepId: "understand", agentId: "notes", status: "completed", outputSummary: "Three requirements identified.", errorCode: null }, { stepId: "review", agentId: "tutor", status: "completed", outputSummary: "Draft reviewed with two improvements.", errorCode: null }], warnings: [], errorCode: null, recommendedNextAction: "Revise the introduction.", waitingFor: null };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ workflow: completed, userMessage: { id: "resume-user", turnId: "resume", role: "user", content: "My assignment draft", agentId: null, createdAt: now, metadata: {} }, assistantMessage: { id: "resume-assistant", turnId: "resume", role: "assistant", content: completed.summary, agentId: null, createdAt: now, metadata: {}, presentation: { mode: "workflow", kind: "workflow", targetId: "assignment-support", targetName: "Assignment Support", workflow: completed } } }) });
    });

    await page.goto("/student/assistant");
    if (mobile) {
      const history = page.getByRole("complementary", { name: "Conversation history" });
      await expect(history).toHaveCount(0);
      const openHistory = page.getByRole("button", { name: "Open conversation history" });
      await openHistory.press("Enter");
      await expect(history).toBeVisible();
      await expect(openHistory).toHaveAttribute("aria-expanded", "true");
      await history.getByRole("button", { name: "Close conversation history" }).press("Enter");
      await expect(history).toHaveCount(0);
      await expect(openHistory).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("button", { name: "New chat", exact: true })).toHaveCount(1);
      await page.getByRole("region", { name: "AI conversation" }).getByRole("button", { name: "New chat", exact: true }).press("Enter");
    }
    const composer = page.getByLabel("Message Academic AI");
    await page.getByRole("region", { name: "AI conversation" }).getByLabel("Preferred AI specialist").selectOption("tutor");
    await composer.fill("Explain induction.");
    await composer.press("Enter");
    await expect(page.getByText("Induction proves a statement by establishing a base and a repeatable step.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Proof Lecture · p. 4" })).toBeVisible();
    await page.getByRole("button", { name: "Another example" }).click();
    await expect(page.getByText("Here is another induction example.")).toBeVisible();

    await page.getByRole("button", { name: "New chat", exact: true }).last().click();
    await page.getByRole("region", { name: "AI conversation" }).getByLabel("Preferred AI specialist").selectOption("notes");
    await composer.fill("Create structured notes on induction.");
    await composer.press("Enter");
    await expect(page.getByRole("region", { name: "Induction review" })).toContainText("P(k) → P(k+1)");
    await page.getByRole("button", { name: "Turn into quiz" }).click();
    const quizRegion = page.getByRole("region", { name: "Induction check quiz" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(quizRegion).toContainText("Question 1 of 2");
    await quizRegion.getByLabel("Base case").check();
    await quizRegion.getByRole("button", { name: "Check answer" }).click();
    await expect(quizRegion).toContainText("Correct");
    await quizRegion.getByRole("button", { name: "Next question" }).click();
    await quizRegion.getByLabel("Answer question 2").fill("It moves from k to k plus one.");
    await quizRegion.getByRole("button", { name: "Check answer" }).click();
    await expect(quizRegion).toContainText("Grading is temporarily unavailable.");
    await expect(quizRegion.getByLabel("Answer question 2")).toHaveValue("It moves from k to k plus one.");
    await quizRegion.getByRole("button", { name: "Try again" }).click();
    await expect(quizRegion.getByRole("region", { name: "Quiz results" })).toContainText("75%");

    await page.getByRole("button", { name: "New chat", exact: true }).last().click();
    await page.getByRole("region", { name: "AI conversation" }).getByLabel("Preferred AI specialist").selectOption("study-planner");
    await composer.fill("Plan my proof review.");
    await composer.press("Enter");
    const planRegion = page.getByRole("region", { name: "Study plan" });
    await expect(planRegion).toContainText("Proof review plan");
    await planRegion.getByRole("button", { name: "Start" }).first().click();
    await expect(page.getByText("Let’s begin the planned induction lesson.")).toBeVisible();
    await planRegion.getByRole("button", { name: "Complete" }).first().click();
    await expect(planRegion).toContainText("1 of 2 completed");
    await planRegion.getByRole("button", { name: "Skip" }).click();
    await expect(planRegion).toContainText("Skipped");

    await page.getByRole("button", { name: "New chat", exact: true }).last().click();
    await composer.fill("Start assignment workflow.");
    await composer.press("Enter");
    const workflowRegion = page.getByRole("region", { name: "Assignment Support workflow" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(workflowRegion).toContainText("Waiting for you");
    await workflowRegion.getByRole("textbox", { name: "Add your current draft" }).fill("My assignment draft");
    const continueWorkflow = workflowRegion.getByRole("button", { name: "Continue workflow" });
    await continueWorkflow.click();
    await expect(continueWorkflow).toBeDisabled();
    await expect(page.getByText("Assignment Support complete")).toBeVisible();
    expect(resumeCount).toBe(1);

    await page.getByRole("button", { name: "New chat", exact: true }).last().click();
    await page.getByRole("region", { name: "AI conversation" }).getByLabel("Preferred AI specialist").selectOption("academic-manager");
    await composer.fill("Review my academic priorities.");
    await composer.press("Enter");
    await expect(page.getByText("Overall status")).toBeVisible();
    await expect(page.getByText("Core coverage is incomplete.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Review Induction" })).toBeVisible();

    await page.getByRole("button", { name: "New chat", exact: true }).last().click();
    await page.getByRole("region", { name: "AI conversation" }).getByLabel("Preferred AI specialist").selectOption("career");
    await composer.fill("Review my career preparation.");
    await composer.press("Enter");
    await expect(page.getByText("Clear project documentation")).toBeVisible();
    await expect(page.getByText("No deployment evidence yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Improve resume" })).toBeVisible();

    expect(streamRequests.some((request) => request.preferredAgentId === "quiz")).toBe(true);
    expect(streamRequests.some((request) => request.preferredAgentId === "tutor" && String(request.request).startsWith("Start this study task"))).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("Message Academic AI")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1 AND email=$2', [userId, email]);
    await pool.end();
  }
});
}
