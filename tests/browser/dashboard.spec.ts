import "dotenv/config";
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("uses the Smart Dashboard for daily work, recommendations, launches, and mobile", async ({ page }) => {
  test.setTimeout(120000);
  const email = `dashboard-browser-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const origin = { Origin: "http://localhost:3000" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", {
      headers: origin,
      data: { name: "Dashboard Student", email, password: "Dashboard-browser-passphrase-2026!" },
    });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id;
    expect((await page.request.put("/api/student/profile", { headers: origin, data: {
      name: "Dashboard Student", school: "Test University", program: "Mathematics",
      currentYear: 2, semester: "Fall 2026", academicGoal: "Master proofs",
      studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC",
    } })).ok()).toBe(true);
    const courseResponse = await page.request.post("/api/student/courses", { headers: origin, data: {
      courseCode: "MATH 1240", courseName: "Discrete Mathematics", semester: "Fall 2026", professor: "", description: "",
    } });
    expect(courseResponse.ok()).toBe(true);
    const courseId = (await courseResponse.json()).id as string;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const examDate = new Date(Date.now() + 4 * 86_400_000).toISOString();
    const assignmentResponse = await page.request.post(`/api/student/courses/${courseId}/assignments`, { headers: origin, data: {
      title: "Proof assignment", description: "", dueDate: tomorrow,
      status: "TODO", priority: "HIGH", estimatedHours: 3,
    } });
    expect(assignmentResponse.ok()).toBe(true);
    const assignmentId = (await assignmentResponse.json()).id as string;
    expect((await page.request.post(`/api/student/courses/${courseId}/exams`, { headers: origin, data: {
      title: "Midterm", examDate, topics: ["Induction"],
    } })).ok()).toBe(true);

    const planId = randomUUID();
    const taskId = randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(`INSERT INTO "StudyPlan" ("id", "userId", "title", "startDate", "endDate", "summary", "totalPlannedMinutes", "status", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',NOW(),NOW())`, [planId, userId, "Dashboard plan", `${today}T00:00:00.000Z`, examDate, "Prepare for the midterm.", 45]);
    await pool.query(`INSERT INTO "StudyTask" ("id", "userId", "studyPlanId", "courseId", "assignmentId", "date", "title", "activityType", "durationMinutes", "priority", "status", "reason", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,'ASSIGNMENT',45,90,'PLANNED',$8,NOW(),NOW())`, [taskId, userId, planId, courseId, assignmentId, `${today}T00:00:00.000Z`, "Outline proof assignment", "Assignment is due tomorrow."]);

    let launched: { preferredWorkflowId?: string; assignmentId?: string } | undefined;
    await page.route("**/api/student/assistant/requests/stream", async (route) => {
      launched = route.request().postDataJSON() as typeof launched;
      const now = new Date().toISOString();
      const data = {
        conversation: { id: "dashboard-conversation", title: "Assignment support", courseId, courseName: "MATH 1240", messageCount: 2, lastMessageAt: now },
        userMessage: { id: "dashboard-user", turnId: "dashboard-turn", role: "user", content: "Help with assignment", agentId: null, createdAt: now, metadata: { workspaceVisible: true } },
        assistantMessage: { id: "dashboard-assistant", turnId: "dashboard-turn", role: "assistant", content: "I reviewed the assignment. Add your draft to continue.", agentId: null, createdAt: now, metadata: { workspaceVisible: true }, presentation: {
          kind: "workflow", targetId: "assignment-support", targetName: "Assignment Support",
          workflow: { runId: "dashboard-run", workflowId: "assignment-support", status: "waiting-for-input", summary: "Add your draft to continue.", completedSteps: ["understand"], steps: [{ stepId: "understand", agentId: "notes", status: "completed", outputSummary: "Requirements identified.", errorCode: null }, { stepId: "review", agentId: "tutor", status: "pending", outputSummary: null, errorCode: null }], warnings: [], errorCode: null, recommendedNextAction: "Add your draft.", waitingFor: { kind: "student-work", referenceId: assignmentId } },
        } },
      };
      await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "result", data })}\n` });
    });

    await page.goto("/student");
    await expect(page.getByRole("heading", { name: "Good", exact: false })).toContainText("Dashboard");
    await expect(page.getByRole("heading", { name: "Today’s focus" })).toBeVisible();
    const task = page.getByText("Outline proof assignment").locator("xpath=ancestor::article");
    await expect(task).toBeVisible();
    await task.getByRole("button", { name: "Complete Outline proof assignment" }).click();
    await expect(task.getByText("Completed", { exact: true })).toBeVisible();

    const dismiss = page.getByRole("button", { name: /^Dismiss / }).first();
    if (await dismiss.count()) {
      const label = await dismiss.getAttribute("aria-label");
      await dismiss.click();
      if (label) await expect(page.getByRole("button", { name: label })).toHaveCount(0);
    }

    const primaryAction = page.locator(".dashboard-next").getByRole("button");
    await expect(primaryAction).toBeVisible();
    await primaryAction.click();
    await expect(page).toHaveURL(/\/student\/assistant/);
    await expect(page.getByRole("region", { name: "Assignment Support workflow" })).toBeVisible();
    expect(launched).toMatchObject({ preferredWorkflowId: "assignment-support", assignmentId });

    await page.goto("/student");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Today’s focus" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1 AND email=$2', [userId, email]);
    await pool.end();
  }
});
