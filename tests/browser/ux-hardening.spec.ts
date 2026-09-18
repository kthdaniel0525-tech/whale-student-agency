import "dotenv/config";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

test("preserves navigation state and exposes the saved study plan across screen sizes", async ({ page }) => {
  const email = `ux-hardening-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const origin = { Origin: "http://localhost:3000" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", { headers: origin, data: { name: "UX Student", email, password: "UX-hardening-browser-2026!" } });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id as string;
    expect((await page.request.put("/api/student/profile", { headers: origin, data: {
      name: "UX Student", school: "Test University", program: "Mathematics", currentYear: 2,
      semester: "Fall 2026", academicGoal: "Study consistently", studySessionMinutes: 45,
      explanationDifficulty: "INTERMEDIATE", timezone: "America/Winnipeg",
    } })).ok()).toBe(true);
    const courseResponse = await page.request.post("/api/student/courses", { headers: origin, data: {
      courseCode: "MATH 1240", courseName: "Discrete Mathematics", semester: "Fall 2026", professor: "", description: "",
    } });
    const courseId = (await courseResponse.json()).id as string;
    const planId = randomUUID();
    const firstTaskId = randomUUID();
    const secondTaskId = randomUUID();
    await pool.query(`INSERT INTO "StudyPlan" ("id","userId","title","startDate","endDate","summary","totalPlannedMinutes","status","createdAt","updatedAt") VALUES ($1,$2,'Weekly proof plan',NOW(),NOW()+INTERVAL '2 days','Review proof foundations without overloading the week.',75,'ACTIVE',NOW(),NOW())`, [planId, userId]);
    await pool.query(`INSERT INTO "StudyTask" ("id","userId","studyPlanId","courseId","date","title","topic","activityType","durationMinutes","priority","status","reason","createdAt","updatedAt") VALUES ($1,$2,$3,$4,NOW(),'Review logic','Logic','REVIEW',30,70,'COMPLETED','Maintain a strong foundation.',NOW(),NOW()),($5,$2,$3,$4,NOW()+INTERVAL '1 day','Practice induction','Mathematical Induction','PRACTICE',45,90,'PLANNED','Induction needs focused practice.',NOW(),NOW())`, [firstTaskId, userId, planId, courseId, secondTaskId]);

    await page.goto("/student/study-plan");
    await expect(page.getByRole("heading", { name: "Study Plan", exact: true })).toBeVisible();
    await expect(page.getByText("Weekly proof plan", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Plan overview" })).toContainText("1 of 2");
    await expect(page.getByRole("link", { name: "Update plan" })).toHaveAttribute("href", /agent=study-planner/);
    await page.getByRole("button", { name: "Complete" }).click();
    await expect(page.getByRole("region", { name: "Study plan" })).toContainText("2 of 2 completed");
    await expect(page.getByRole("region", { name: "Plan overview" })).toContainText("2 of 2");

    await page.goto(`/student/courses/${courseId}?tab=exams`);
    await expect(page.getByRole("tab", { name: /^Exams/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /^Documents/ }).click();
    await expect(page).toHaveURL(/tab=documents/);
    await page.reload();
    await expect(page.getByRole("tab", { name: /^Documents/ })).toHaveAttribute("aria-selected", "true");

    await page.goto("/student/settings");
    await expect(page.getByRole("heading", { name: "AI context & memory" })).toBeVisible();
    await expect(page.getByText(/Context is scoped to your account|Personalization will grow/)).toBeVisible();

    for (const viewport of [{ width: 820, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/student/study-plan");
      await expect(page.getByRole("heading", { name: "Study Plan", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1 AND email=$2', [userId, email]);
    await pool.end();
  }
});
