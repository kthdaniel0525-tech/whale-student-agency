import "dotenv/config";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

test("mobile first-time onboarding and empty workspaces support keyboard navigation", async ({ page }) => {
  test.setTimeout(90000);
  const email = `launch-mobile-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.name));
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await page.goto("/sign-up");
    await page.getByLabel("Name", { exact: true }).fill("Mobile audit student");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Mobile-audit-passphrase-2026!");
    await page.getByRole("button", { name: "Create account", exact: true }).press("Enter");
    await expect(page).toHaveURL(/onboarding/);
    await page.getByLabel("University or school").fill("Synthetic university");
    await page.getByLabel("Program / major").fill("Mathematics");
    await page.getByLabel("Current semester").fill("Fall 2026");
    await page.getByLabel("Academic goal").fill("Understand proofs");
    await page.getByRole("button", { name: "Open my dashboard" }).press("Enter");
    await expect(page).toHaveURL(/\/student$/);
    await expect(page.getByRole("heading", { name: "Start with your first course", exact: true })).toBeVisible();
    const add = page.getByRole("button", { name: "Add course", exact: true });
    await add.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("Course code")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(add).toBeFocused();
    for (const path of ["/student/courses", "/student/assistant", "/student/progress", "/student/study-plan", "/student/career", "/student/settings/billing", "/plans"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await expect(page.getByRole("main")).toHaveCount(1);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    await pool.query('DELETE FROM "User" WHERE email=$1', [email]);
    await pool.end();
  }
});
