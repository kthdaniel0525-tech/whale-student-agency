import "dotenv/config";
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
test("student signs up, onboards, manages courses and deadlines, then signs out", async ({
  page,
}) => {
  test.setTimeout(120000);
  const email = `browser-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await page.goto("/sign-up");
    await page.getByLabel("Name", { exact: true }).fill("Browser Student");
    await page.getByLabel("Email address").fill(email);
    await page
      .getByLabel("Password", { exact: true })
      .fill("Long-browser-test-passphrase!");
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(page).toHaveURL(/onboarding/);
    await page.getByLabel("University or school").fill("Test University");
    await page.getByLabel("Program / major").fill("Mathematics");
    await page.getByLabel("Current semester").fill("Fall 2026");
    await page.getByLabel("Academic goal").fill("Understand proofs");
    await page.getByRole("button", { name: "Open my dashboard" }).click();
    await expect(page).toHaveURL(/\/student$/);
    await expect(
      page.getByText("Room to get organized", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add course", exact: true }).click();
    await page.getByLabel("Course code").fill("MATH 1240");
    await page.getByLabel("Course name").fill("Discrete Mathematics");
    await page
      .getByRole("button", { name: "Create course", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("link")
      .filter({ hasText: "Discrete Mathematics" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Discrete Mathematics", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add assignment", exact: true })
      .click();
    await page.getByLabel("Title", { exact: true }).fill("Proof worksheet");
    await page.getByLabel("Due date").fill("2027-01-10T14:00");
    await page
      .getByRole("button", { name: "Create assignment", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Proof worksheet" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Reopen", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add exam", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Midterm test");
    await page.getByLabel("Exam date").fill("2027-01-20T14:00");
    await page.getByLabel("Topics (one per line)").fill("Induction\nLogic");
    await page
      .getByRole("button", { name: "Create exam", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Midterm test" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Edit course", exact: true })
      .click();
    await page.getByLabel("Course name").fill("Discrete Mathematics II");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Discrete Mathematics II",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Edit assignment", exact: true })
      .click();
    await page.getByLabel("Title", { exact: true }).fill("Updated worksheet");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Updated worksheet" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit exam", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Updated midterm");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Updated midterm" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/course-desktop.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Delete assignment", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete assignment", exact: true })
      .click();
    await expect(
      page.getByText("No assignments yet", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Delete exam", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete exam", exact: true })
      .click();
    await expect(page.getByText("No exams yet", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Delete course", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete course", exact: true })
      .click();
    await expect(page).toHaveURL(/\/student\/courses$/);
    await expect(
      page.getByText("Every semester starts somewhere", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Updated Student");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByText("Settings saved.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      "Updated Student",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/settings-mobile.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/sign-in/);
    await page.goto("/student");
    await expect(page).toHaveURL(/sign-in/);
  } finally {
    await pool.query('DELETE FROM "User" WHERE email=$1', [email]);
    await pool.end();
  }
});
