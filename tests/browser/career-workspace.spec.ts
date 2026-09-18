import "dotenv/config";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

test("uses the Career Workspace for profile evidence, projects, plan actions, AI context and mobile", async ({ page }) => {
  test.setTimeout(120000);
  const email = `career-workspace-browser-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const origin = { Origin: "http://localhost:3000" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", { headers: origin, data: { name: "Career Workspace Student", email, password: "Career-workspace-browser-2026!" } });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id as string;
    expect((await page.request.put("/api/student/profile", { headers: origin, data: { name: "Career Workspace Student", school: "Test University", program: "Computer Science", currentYear: 3, semester: "Fall 2026", academicGoal: "Prepare for internships", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } })).ok()).toBe(true);
    expect((await page.request.put("/api/student/career/profile", { headers: origin, data: { careerGoal: "Prepare for a software engineering internship", targetRoles: ["Software Engineering Intern"], targetIndustries: ["Education Technology"], targetCompanies: ["Example Labs"], applicationTimeline: "in 8 weeks", experiences: ["Built a student club portal."], portfolioLinks: ["https://example.test/portfolio"], resumeText: "Built a student club portal using React, Node, and PostgreSQL." } })).ok()).toBe(true);
    const projectResponse = await page.request.post("/api/student/career/projects", { headers: origin, data: { courseId: null, name: "Student Club Portal", description: "A portal for club events and membership information.", technologies: ["React", "Node", "PostgreSQL"], role: "Developer", outcomes: ["Documented the event publishing workflow."], link: "https://example.test/portal", repositoryUrl: "https://example.test/repository" } });
    expect(projectResponse.ok()).toBe(true);
    const projectId = (await projectResponse.json()).id as string;
    expect((await page.request.post("/api/student/career/skills", { headers: origin, data: { name: "React", category: "Frameworks", proficiency: "Developing", evidence: ["Used for the portal interface."] } })).ok()).toBe(true);

    const planId = randomUUID();
    const taskId = randomUUID();
    await pool.query(`INSERT INTO "CareerPlan" ("id","userId","targetRole","startDate","targetDate","weeklyAvailableMinutes","totalPlannedMinutes","summary","status","createdAt","updatedAt") VALUES ($1,$2,'Software Engineering Intern',NOW(),NOW()+INTERVAL '6 weeks',180,120,'Strengthen the portal and resume.','ACTIVE',NOW(),NOW())`, [planId, userId]);
    await pool.query(`INSERT INTO "CareerTask" ("id","userId","careerPlanId","projectId","actionId","weekNumber","category","title","description","priority","durationMinutes","status","targetDate","createdAt","updatedAt") VALUES ($1,$2,$3,$4,'add-tests',1,'PROJECT','Add integration tests','Test the main portal flow.',100,120,'PLANNED',NOW()+INTERVAL '7 days',NOW(),NOW())`, [taskId, userId, planId, projectId]);

    let assistantCalls = 0;
    page.on("request", (request) => { if (request.url().includes("/api/student/assistant/requests")) assistantCalls++; });
    await page.goto("/student/career");
    await expect(page.getByRole("heading", { name: "Build evidence for your next role" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Software Engineering Intern", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Career readiness" })).toBeVisible();
    await expect(page.getByText("Example Labs", { exact: true })).toBeVisible();
    await expect(page.getByText("in 8 weeks", { exact: true })).toBeVisible();
    await expect(page.getByText("Frameworks", { exact: true })).toBeVisible();
    await expect(page.getByText("Used for the portal interface.", { exact: true })).toBeVisible();
    expect(assistantCalls).toBe(0);

    const project = page.locator(".project-card").filter({ hasText: "Student Club Portal" });
    await expect(project).toContainText("React");
    await project.getByText("Open project details").click();
    await expect(project).toContainText("Documented the event publishing workflow.");
    await expect(project.getByRole("link", { name: "Improve project" })).toHaveAttribute("href", new RegExp(`agent=career.*projectId=${projectId}|projectId=${projectId}.*agent=career`));
    await expect(page.getByRole("link", { name: /Build \/ update career plan/ })).toHaveAttribute("href", /workflow=career-preparation/);
    await expect(page.getByRole("link", { name: /Build \/ update career plan/ })).toHaveAttribute("href", /targetCompanies=Example\+Labs/);

    const task = page.locator(".career-tasks article").filter({ hasText: "Add integration tests" });
    await expect(task.getByRole("link", { name: "Ask Career AI" })).toHaveAttribute("href", new RegExp(`projectId=${projectId}`));
    await expect(task.getByRole("link", { name: "View related project" })).toHaveAttribute("href", `#project-${projectId}`);
    await task.getByRole("button", { name: "Mark complete" }).click();
    await expect(page.locator(".career-tasks article.task-completed").filter({ hasText: "Add integration tests" })).toBeVisible();

    await page.getByRole("button", { name: "Edit career profile" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Target role(s)").fill("Backend Engineering Intern");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "Backend Engineering Intern", exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.locator("#plan h2")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(assistantCalls).toBe(0);
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1 AND email=$2', [userId, email]);
    await pool.end();
  }
});
