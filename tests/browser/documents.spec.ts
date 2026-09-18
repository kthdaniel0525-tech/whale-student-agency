import "dotenv/config";
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { inductionPages, textPdf } from "../fixtures/documents";
test("uploads a course PDF, reads extracted pages, searches cited passages and deletes it", async ({
  page,
}) => {
  test.setTimeout(120000);
  const email = `docs-browser-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const headers = { Origin: "http://localhost:3000" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", {
      headers,
      data: {
        name: "Documents Browser",
        email,
        password: "Long-browser-document-passphrase!",
      },
    });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id;
    expect(
      (
        await page.request.put("/api/student/profile", {
          headers,
          data: {
            name: "Documents Browser",
            school: "Test University",
            program: "Mathematics",
            currentYear: 1,
            semester: "Fall 2026",
            academicGoal: "Understand proofs",
            studySessionMinutes: 45,
            explanationDifficulty: "INTERMEDIATE",
            timezone: "America/Winnipeg",
          },
        })
      ).ok(),
    ).toBe(true);
    const course = await page.request.post("/api/student/courses", {
      headers,
      data: {
        courseCode: "MATH 1240",
        courseName: "Discrete Mathematics",
        semester: "Fall 2026",
        professor: "",
        description: "",
      },
    });
    expect(course.ok()).toBe(true);
    const courseId = (await course.json()).id;
    await page.goto(`/student/courses/${courseId}`);
    await page.getByRole("tab", { name: /^Documents/ }).click();
    await page
      .getByRole("button", { name: "Upload document", exact: true })
      .click();
    await page
      .getByLabel("Document file")
      .setInputFiles({
        name: "Induction.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from(textPdf(inductionPages)),
      });
    await page
      .getByLabel("Document title (optional)")
      .fill("Lecture 3 — Mathematical Induction");
    await page
      .getByRole("button", { name: "Upload file", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("link", {
        name: "Lecture 3 — Mathematical Induction",
        exact: true,
      })
      .click();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible({
      timeout: 90000,
    });
    const id = page.url().split("/").pop()!;
    expect(
      (await (await page.request.get(`/api/student/documents/${id}`)).json())
        .courseId,
    ).toBe(courseId);
    await page
      .getByRole("button", { name: "Read extracted pages", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Page 2", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/The inductive hypothesis assumes/),
    ).toBeVisible();
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download original file" }).click();
    expect((await downloading).suggestedFilename()).toBe("Induction.pdf");
    await page
      .getByRole("link", { name: "Search this document", exact: true })
      .click();
    await page
      .getByLabel("Search question")
      .fill("What is the inductive hypothesis?");
    await page
      .getByRole("button", { name: "Search passages", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Retrieved passages", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      page.getByRole("link", {
        name: "Lecture 3 — Mathematical Induction · Page 1–2",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/Similarity: 0\./)).toBeVisible();
    await mkdir(".local/verification", { recursive: true });
    await page.screenshot({
      path: ".local/verification/rag-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".local/verification/rag-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page
      .getByLabel("Search question")
      .fill("How long should I roast chicken with garlic and potatoes?");
    await page
      .getByRole("button", { name: "Search passages", exact: true })
      .click();
    await expect(
      page.getByText("No relevant passages found", { exact: true }),
    ).toBeVisible();
    await page.goto(`/student/documents/${id}`);
    await page
      .getByRole("button", { name: "Delete document", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete permanently", exact: true })
      .click();
    await expect(page).toHaveURL(/\/student\/documents$/);
    await expect(
      page.getByText("Build your course library", { exact: true }),
    ).toBeVisible();
    expect(
      (await page.request.get(`/api/student/documents/${id}`)).status(),
    ).toBe(404);
  } finally {
    if (userId)
      await pool.query('DELETE FROM "User" WHERE id=$1 AND email=$2', [
        userId,
        email,
      ]);
    await pool.end();
  }
});
