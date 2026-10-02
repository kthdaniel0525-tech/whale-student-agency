import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";

test("public legal routes and owned Settings data controls work on desktop and mobile", async ({ page }) => {
  test.setTimeout(120000);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const origin = "http://localhost:3000";
  const headers = { Origin: origin };
  const credentials = { email: `privacy-ui-${randomUUID()}@example.test`, password: "Privacy-settings-passphrase-2026!" };
  let userId: string | undefined;
  try {
    for (const [path, heading] of [["/privacy", "How Student Agency handles data"], ["/terms", "Using Student Agency"], ["/support", "Get help with Student Agency"]] as const) {
      const response = await page.goto(path); expect(response?.status()).toBe(200); await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }
    await page.goto("/sign-up");
    for (const name of ["Privacy", "Terms", "Support"]) await expect(page.getByRole("link", { name, exact: true })).toBeVisible();

    const signup = await page.request.post("/api/auth/sign-up/email", { headers, data: { name: "Privacy Student", ...credentials } });
    expect(signup.ok()).toBe(true); userId = (await signup.json()).user.id;
    expect((await page.request.put("/api/student/profile", { headers, data: { name: "Privacy Student", school: "Test University", program: "Mathematics", currentYear: 2, semester: "Fall 2026", academicGoal: "Verify controls", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } })).ok()).toBe(true);
    const memoryArchive = randomUUID(), memoryDelete = randomUUID(), conversation = randomUUID();
    await pool.query('INSERT INTO "UserMemory" (id,"userId",category,key,value,"sourceType",confidence,importance,status,"firstObservedAt","lastObservedAt","createdAt","updatedAt") VALUES ($1,$2,\'PREFERENCE\',\'explanationStyle\',\'concise\',\'EXPLICIT\',95,60,\'ACTIVE\',NOW(),NOW(),NOW(),NOW()),($3,$2,\'USER_DEFINED\',\'diagram-review\',\'Use diagrams\',\'EXPLICIT\',95,60,\'ACTIVE\',NOW(),NOW(),NOW(),NOW())', [memoryArchive, userId, memoryDelete]);
    await pool.query('INSERT INTO "Conversation" (id,"userId",title,"messageCount","nextMessageSequence","lastMessageAt","createdAt","updatedAt") VALUES ($1,$2,\'Synthetic settings conversation\',0,1,NOW(),NOW(),NOW())', [conversation, userId]);

    await page.goto("/student/settings");
    for (const name of ["Privacy", "Terms", "Support"]) await expect(page.getByRole("link", { name, exact: true }).first()).toBeVisible();
    const archiveItem = page.getByRole("listitem").filter({ hasText: "explanationStyle" });
    await archiveItem.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(archiveItem.getByText("archived", { exact: true })).toBeVisible();
    const deleteItem = page.getByRole("listitem").filter({ hasText: "diagram-review" });
    await deleteItem.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete memory", exact: true }).click();
    await expect(page.getByText("diagram-review", { exact: true })).toHaveCount(0);

    const conversationItem = page.getByRole("listitem").filter({ hasText: "Synthetic settings conversation" });
    await conversationItem.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete conversation", exact: true }).click();
    await expect(page.getByText("Synthetic settings conversation", { exact: true })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Delete account", exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Delete account", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    const permanent = dialog.getByRole("button", { name: "Delete account permanently", exact: true });
    await expect(permanent).toBeDisabled();
    await dialog.getByLabel("Current password", { exact: true }).fill("wrong-password");
    await dialog.getByLabel("Type DELETE to confirm", { exact: true }).fill("DELETE");
    await permanent.click();
    await expect(dialog.getByRole("alert")).toContainText("Confirm your current password");
    await dialog.getByLabel("Current password", { exact: true }).fill(credentials.password);
    await permanent.click();
    await expect(page.getByRole("status").filter({ hasText: "Deletion requested" })).toBeVisible();
    const state = await pool.query('SELECT "deletionRequestedAt" FROM "User" WHERE id=$1', [userId]);
    expect(state.rows[0].deletionRequestedAt).toBeTruthy();
    expect(Number((await pool.query('SELECT COUNT(*)::int AS count FROM "Session" WHERE "userId"=$1', [userId])).rows[0].count)).toBe(0);
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1', [userId]);
    await pool.end();
  }
});
