import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";

test("notification settings save across sessions, validate timing, preserve drafts on failure and work on mobile", async ({ page, browser }) => {
  test.setTimeout(120000);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const headers = { Origin: "http://localhost:3000" };
  const credentials = { email: `settings-ui-${randomUUID()}@example.test`, password: "Settings-browser-passphrase-2026!" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", { headers, data: { name: "Settings Student", ...credentials } });
    expect(signup.ok()).toBe(true); userId = (await signup.json()).user.id;
    expect((await page.request.put("/api/student/profile", { headers, data: { name: "Settings Student", school: "Test University", program: "Mathematics", currentYear: 2, semester: "Fall 2026", academicGoal: "Master proofs", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } })).ok()).toBe(true);
    let aiCalls = 0;
    await page.route("**/api/student/assistant/requests/**", async (route) => { aiCalls++; await route.abort(); });
    await page.goto("/student/settings");
    const section = page.getByRole("region", { name: "Notifications & Automation" });
    await expect(section).toBeVisible();
    const reminders = section.getByRole("switch", { name: "Enable reminders", exact: true });
    await expect(reminders).toBeChecked();
    await expect(reminders).toHaveAttribute("aria-describedby", "automation-remindersEnabled-description");
    await reminders.focus(); await page.keyboard.press("Space"); await expect(reminders).not.toBeChecked();
    await expect(reminders).toBeFocused();
    await expect(section.getByText("Reminders are paused.", { exact: false })).toBeVisible();
    await section.getByRole("switch", { name: "Assignments", exact: true }).uncheck();
    await section.getByRole("switch", { name: "Exams", exact: true }).uncheck();
    await section.getByRole("switch", { name: "Study sessions", exact: true }).uncheck();
    await section.getByRole("switch", { name: "Workflow follow-ups", exact: true }).uncheck();
    await section.getByRole("switch", { name: "In-app notifications", exact: true }).uncheck();
    await section.getByRole("switch", { name: "Proactive recommendations", exact: true }).uncheck();
    await section.getByLabel("Study reminder lead time").selectOption("60");
    await section.getByLabel("Notification frequency", { exact: true }).selectOption("HOURLY");
    await section.getByRole("switch", { name: "Quiet hours", exact: true }).check();
    await expect(section.getByLabel("Quiet hours start", { exact: true })).toHaveValue("22:00");
    await section.getByLabel("Quiet hours end", { exact: true }).fill("22:00");
    await section.getByRole("button", { name: "Save notification settings" }).click();
    await expect(section.getByRole("alert")).toContainText("Please check your quiet hours");
    await expect(section.getByLabel("Quiet hours end", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(section.getByLabel("Quiet hours end", { exact: true })).toHaveAttribute("aria-describedby", "quiet-hours-end-error");
    await section.getByLabel("Quiet hours end", { exact: true }).fill("08:00");
    await section.getByRole("button", { name: "Save notification settings" }).click();
    await expect(section.getByRole("status")).toHaveText("Settings saved.");
    await page.reload();
    await expect(reminders).not.toBeChecked();
    await expect(section.getByLabel("Study reminder lead time")).toHaveValue("60");
    await expect(section.getByLabel("Quiet hours end", { exact: true })).toHaveValue("08:00");
    const saved = await (await page.request.get("/api/student/notification-preferences")).json();
    expect(saved).toMatchObject({ remindersEnabled: false, inAppEnabled: false, assignmentReminders: false, examReminders: false, studyReminders: false, workflowReminders: false, proactiveRecommendationsEnabled: false, leadTimeMinutes: 60, quietHoursEnabled: true, quietHoursStart: 1320, quietHoursEnd: 480, notificationFrequency: "HOURLY" });
    // A separate authenticated browser session receives the canonical server state.
    const device = await browser.newContext({ baseURL: "http://localhost:3000" });
    try {
      expect((await device.request.post("/api/auth/sign-in/email", { headers, data: credentials })).ok()).toBe(true);
      const second = await device.newPage(); await second.goto("/student/settings");
      await expect(second.getByRole("switch", { name: "Enable reminders", exact: true })).not.toBeChecked();
      await expect(second.getByLabel("Study reminder lead time")).toHaveValue("60");
    } finally { await device.close(); }
    await page.route("**/api/student/notification-preferences", async (route) => {
      if (route.request().method() === "PATCH") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Settings could not be saved. Please try again." }) });
      else await route.continue();
    });
    await reminders.check(); await section.getByRole("button", { name: "Save notification settings" }).click();
    await expect(section.getByRole("alert")).toContainText("could not be saved");
    await expect(reminders).toBeChecked(); await expect(section.getByRole("status")).toHaveText("");
    expect((await (await page.request.get("/api/student/notification-preferences")).json()).remindersEnabled).toBe(false);
    await page.unroute("**/api/student/notification-preferences");
    await section.getByRole("button", { name: "Save notification settings" }).click();
    await expect(section.getByRole("status")).toHaveText("Settings saved.");
    await section.getByRole("link", { name: "Change in Academic profile" }).click();
    await page.getByLabel("Timezone", { exact: true }).fill("Not/AZone");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText("Choose a valid IANA timezone", { exact: false })).toBeVisible();
    await page.getByLabel("Timezone", { exact: true }).fill("America/Winnipeg");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(section.getByText("America/Winnipeg", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await section.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(section.getByRole("switch", { name: "In-app notifications", exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/notification-settings-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1365, height: 950 });
    await page.screenshot({ path: "/tmp/notification-settings-desktop.png", fullPage: true });
    expect(aiCalls).toBe(0);
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1', [userId]);
    await pool.end();
  }
});
