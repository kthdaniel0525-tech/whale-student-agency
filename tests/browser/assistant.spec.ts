import "dotenv/config";
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("uses the AI workspace with context, rich responses, quiz feedback, and mobile navigation", async ({ page }) => {
  test.setTimeout(120000);
  const email = `assistant-browser-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const headers = { Origin: "http://localhost:3000" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", { headers, data: { name: "AI Workspace Student", email, password: "Assistant-browser-passphrase-2026!" } });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id;
    expect((await page.request.put("/api/student/profile", { headers, data: { name: "AI Workspace Student", school: "Test University", program: "Mathematics", currentYear: 2, semester: "Fall 2026", academicGoal: "Master proofs", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "America/Winnipeg" } })).ok()).toBe(true);
    const courseResponse = await page.request.post("/api/student/courses", { headers, data: { courseCode: "MATH 1240", courseName: "Discrete Mathematics", semester: "Fall 2026", professor: "", description: "" } });
    const courseId = (await courseResponse.json()).id as string;

    let requestCount = 0;
    await page.route("**/api/student/assistant/requests/stream", async (route) => {
      requestCount++;
      const input = route.request().postDataJSON() as { request: string; turnId: string; courseId?: string };
      const quiz = /quiz/i.test(input.request);
      const now = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const data = {
        conversation: { id: "browser-conversation", title: input.request, courseId: input.courseId ?? null, courseName: "MATH 1240 Discrete Mathematics", messageCount: 2, lastMessageAt: now },
        userMessage: { id: `user-${requestCount}`, turnId: input.turnId, role: "user", content: input.request, agentId: null, createdAt: now, metadata: { workspaceVisible: true } },
        assistantMessage: quiz ? {
          id: "assistant-quiz", turnId: input.turnId, role: "assistant", content: "Created a short recursion quiz.", agentId: "quiz", createdAt: now, metadata: { workspaceVisible: true, targetName: "Quiz" },
          presentation: { kind: "agent", targetId: "quiz", targetName: "Quiz", quiz: { id: "quiz-browser", title: "Recursion check", topic: "Recursion", difficulty: "medium", questions: [{ id: "question-browser", type: "multiple-choice", prompt: "Which case stops recursive calls?", choices: ["Base case", "Inductive step", "Loop case", "Recursive case"], topics: ["Recursion"] }], sources: [] } },
        } : {
          id: "assistant-tutor", turnId: input.turnId, role: "assistant", content: "Start with the base case, then prove the inductive step.", agentId: "tutor", createdAt: now, metadata: { workspaceVisible: true, targetName: "Tutor" },
          presentation: { kind: "agent", targetId: "tutor", targetName: "Tutor", sources: [{ documentId: "doc-one", documentTitle: "Lecture 4", pageNumber: 7, pageEnd: 7, chunkIndex: 0 }] },
        },
      };
      await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "status", message: "Reviewing context…" })}\n${JSON.stringify({ type: "result", data })}\n` });
    });
    await page.route("**/api/student/assistant/quizzes/quiz-browser/answers", async (route) => {
      const input = route.request().postDataJSON() as { questionId: string };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ quizId: "quiz-browser", questionId: input.questionId, quizAttemptId: "attempt-browser", correct: true, score: 1, feedback: "Correct.", explanation: "The base case ends the recursive chain." }) });
    });

    await page.goto("/student/assistant");
    await expect(page.getByRole("heading", { name: "What can I help you accomplish?" })).toBeVisible();
    await page.getByRole("button", { name: "Context", exact: true }).click();
    await page.getByLabel("Course", { exact: true }).selectOption(courseId);
    await expect(page.getByRole("button", { name: /MATH 1240/ }).last()).toBeVisible();
    const composer = page.getByLabel("Message Academic AI");
    await composer.fill("Explain induction from my course.");
    await composer.press("Enter");
    await expect(page.getByText("Start with the base case, then prove the inductive step.")).toBeVisible();
    await expect(page.locator('[data-slot="message-header"]').getByText("Tutor", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Lecture 4 · p. 7" })).toBeVisible();

    await page.getByRole("button", { name: "New chat", exact: true }).last().click();
    await composer.fill("Quiz me on recursion.");
    await composer.press("Enter");
    await expect(page.getByRole("region", { name: "Recursion check quiz" })).toBeVisible();
    await page.getByLabel("Base case").check();
    await page.getByRole("button", { name: "Check answer" }).click();
    await expect(page.getByText("The base case ends the recursive chain.")).toBeVisible();
    await expect(page.getByText("Score: 100%")).toBeVisible();
    expect(requestCount).toBe(2);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("Message Academic AI")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Open conversation history" }).click();
    await expect(page.getByRole("complementary", { name: "Conversation history" })).toBeVisible();
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1 AND email=$2', [userId, email]);
    await pool.end();
  }
});
