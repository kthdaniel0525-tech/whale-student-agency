import "dotenv/config";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

test("beta feedback, optional survey and privacy preference work in the browser", async ({ page }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const email = `beta-browser-${randomUUID()}@example.test`;
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", { headers: { Origin: "http://localhost:3000" }, data: { name: "Beta browser fixture", email, password: "Beta-browser-fixture-passphrase!" } });
    expect(signup.ok()).toBe(true); userId = (await signup.json()).user.id;
    const profile = await page.request.put("/api/student/profile", { headers: { Origin: "http://localhost:3000" }, data: { name: "Beta browser fixture", school: "Test", program: "Math", currentYear: 1, semester: "Fall", academicGoal: "Practice", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
    expect(profile.ok()).toBe(true);
    await page.goto("/student/feedback");
    await expect(page.getByRole("heading", { name: "Feedback & privacy" })).toBeVisible();
    await page.getByLabel("Your feedback", { exact: true }).fill("A private usability observation.");
    await page.getByRole("button", { name: "Send feedback", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Your feedback has been saved" })).toBeVisible();
    expect((await pool.query('SELECT category,message FROM "ProductFeedback" WHERE "userId"=$1', [userId])).rows).toEqual([{ category: "bug", message: "A private usability observation." }]);
    await page.getByText("Optional beta survey", { exact: true }).click();
    await page.getByLabel("Include these survey answers").check();
    await page.getByLabel("How useful is Student Agency?").selectOption("5");
    await page.getByLabel("What would make you use it every week?").fill("Better weekly planning");
    await page.getByLabel("Your feedback", { exact: true }).fill("Optional beta survey response");
    await page.getByRole("button", { name: "Send feedback", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Your feedback has been saved" })).toBeVisible();
    await page.getByRole("button", { name: "Turn off product usage tracking" }).click();
    await expect(page.getByRole("button", { name: "Allow product usage tracking" })).toBeVisible();
    expect((await pool.query('SELECT "optedOut" FROM "ProductAnalyticsState" WHERE "userId"=$1', [userId])).rows[0].optedOut).toBe(true);
    const surveys = await pool.query('SELECT survey FROM "ProductFeedback" WHERE "userId"=$1 AND category=$2', [userId, "beta-survey"]);
    expect(surveys.rows[0].survey).toMatchObject({ usefulness: 5, weeklyValue: "Better weekly planning" });
    const forbidden = await page.request.get("/api/internal/beta"); expect(forbidden.status()).toBe(403);
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1 AND email=$2', [userId, email]);
    await pool.end();
  }
});
