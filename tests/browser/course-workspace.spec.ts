import "dotenv/config";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

test("uses the course workspace for academic work, documents, learning actions and mobile", async ({ page }) => {
  test.setTimeout(120000);
  const email = `course-workspace-browser-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const origin = { Origin: "http://localhost:3000" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", {
      headers: origin,
      data: { name: "Course Workspace Student", email, password: "Course-workspace-browser-2026!" },
    });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id as string;
    expect((await page.request.put("/api/student/profile", { headers: origin, data: {
      name: "Course Workspace Student", school: "Test University", program: "Mathematics",
      currentYear: 2, semester: "Fall 2026", academicGoal: "Master proofs",
      studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC",
    } })).ok()).toBe(true);

    const courseResponse = await page.request.post("/api/student/courses", { headers: origin, data: {
      courseCode: "MATH 1240", courseName: "Discrete Mathematics", semester: "Fall 2026",
      professor: "Dr. Ada", description: "Proofs, logic and discrete structures.",
    } });
    expect(courseResponse.ok()).toBe(true);
    const courseId = (await courseResponse.json()).id as string;
    const overdueDate = new Date(Date.now() - 86_400_000).toISOString();
    const examDate = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const assignmentResponse = await page.request.post(`/api/student/courses/${courseId}/assignments`, { headers: origin, data: {
      title: "Proof assignment", description: "Write induction proofs.", dueDate: overdueDate,
      status: "TODO", priority: "HIGH", estimatedHours: 3,
    } });
    expect(assignmentResponse.ok()).toBe(true);
    const assignmentId = (await assignmentResponse.json()).id as string;
    const examResponse = await page.request.post(`/api/student/courses/${courseId}/exams`, { headers: origin, data: {
      title: "Midterm", examDate, topics: ["Mathematical Induction", "Logic"], notes: "Chapters 1–3",
    } });
    expect(examResponse.ok()).toBe(true);
    const examId = (await examResponse.json()).id as string;

    const weakId = randomUUID();
    const lowEvidenceId = randomUUID();
    const readyDocumentId = randomUUID();
    const failedDocumentId = randomUUID();
    const conversationId = randomUUID();
    const planId = randomUUID();
    const completedTaskId = randomUUID();
    const plannedTaskId = randomUUID();
    await pool.query(`INSERT INTO "LearningTopic" ("id","userId","courseId","name","normalizedName","createdAt","updatedAt") VALUES ($1,$2,$3,'Mathematical Induction','mathematical induction',NOW(),NOW()),($4,$2,$3,'Relations','relations',NOW(),NOW())`, [weakId, userId, courseId, lowEvidenceId]);
    await pool.query(`INSERT INTO "LearningProgress" ("id","userId","courseId","topicId","masteryScore","confidenceScore","questionsAttempted","correctAnswers","incorrectAnswers","scoreTotal","difficultyWeightedScore","difficultyWeightTotal","practiceSessions","mediumAttempts","recentAccuracy","firstPracticedAt","lastPracticedAt","trend","createdAt","updatedAt") VALUES ($1,$2,$3,$4,38,88,12,4,8,4,4,12,4,12,35,NOW()-INTERVAL '20 days',NOW()-INTERVAL '1 day','DECLINING',NOW(),NOW()),($5,$2,$3,$6,42,18,1,1,0,1,1,1,1,1,100,NOW()-INTERVAL '1 day',NOW()-INTERVAL '1 day','INSUFFICIENT_DATA',NOW(),NOW())`, [randomUUID(), userId, courseId, weakId, randomUUID(), lowEvidenceId]);
    await pool.query(`INSERT INTO "Document" ("id","userId","courseId","title","originalFileName","fileType","fileSize","storageKey","processingStatus","pageCount","uploadedAt","createdAt","updatedAt") VALUES ($1,$2,$3,'Lecture 6 — Induction','lecture-6.pdf','application/pdf',2048,$4,'READY',12,NOW(),NOW(),NOW()),($5,$2,$3,'Review sheet','review.pdf','application/pdf',1024,$6,'FAILED',NULL,NOW(),NOW(),NOW())`, [readyDocumentId, userId, courseId, `workspace/${randomUUID()}`, failedDocumentId, `workspace/${randomUUID()}`]);
    await pool.query(`INSERT INTO "DocumentPage" ("id","documentId","userId","pageNumber","content") VALUES ($1,$2,$3,3,'The induction step assumes the claim for k and proves k plus one.')`, [randomUUID(), readyDocumentId, userId]);
    await pool.query(`INSERT INTO "Conversation" ("id","userId","courseId","title","messageCount","nextMessageSequence","lastMessageAt","createdAt","updatedAt") VALUES ($1,$2,$3,'Lecture notes',1,2,NOW(),NOW(),NOW())`, [conversationId, userId, courseId]);
    await pool.query(`INSERT INTO "ConversationMessage" ("id","conversationId","userId","sequence","role","content","agentId","metadata","tokenEstimate","createdAt") VALUES ($1,$2,$3,1,'ASSISTANT','Induction starts with a base case and an inductive step.','notes',$4,14,NOW())`, [randomUUID(), conversationId, userId, JSON.stringify({ presentationData: JSON.stringify({ title: "Lecture 6 Summary" }), sourceRefs: JSON.stringify([{ documentId: readyDocumentId, pageNumber: 3 }]) })]);
    await pool.query(`INSERT INTO "StudyPlan" ("id","userId","title","startDate","endDate","summary","totalPlannedMinutes","status","createdAt","updatedAt") VALUES ($1,$2,'Midterm preparation',NOW()-INTERVAL '1 day',$3,'Prepare for the midterm.',90,'ACTIVE',NOW(),NOW())`, [planId, userId, examDate]);
    await pool.query(`INSERT INTO "StudyTask" ("id","userId","studyPlanId","courseId","topicId","examId","date","title","topic","activityType","durationMinutes","priority","status","reason","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,NOW()-INTERVAL '1 day','Review induction','Mathematical Induction','REVIEW',45,90,'COMPLETED','Repair a reliable gap.',NOW(),NOW()),($7,$2,$3,$4,$5,$6,NOW()+INTERVAL '1 day','Induction practice','Mathematical Induction','PRACTICE',45,88,'PLANNED','Prepare for the exam.',NOW(),NOW())`, [completedTaskId, userId, planId, courseId, weakId, examId, plannedTaskId]);

    await page.goto("/student/courses");
    const courseCard = page.locator(".course-workspace-card").filter({ hasText: "MATH 1240" });
    await expect(courseCard).toContainText("Discrete Mathematics");
    await expect(courseCard).toContainText("Needs attention");
    await courseCard.click();
    await expect(page.getByRole("heading", { name: "Discrete Mathematics" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: /MATH 1240 workspace sections/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Ask Course AI/ })).toHaveAttribute("href", new RegExp(`courseId=${courseId}`));
    await expect(page.getByRole("link", { name: /Study weakest topic/ })).toHaveAttribute("href", /workflow=weak-topic-recovery/);
    await expect(page.getByText("Midterm preparation", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: /^Assignments/ }).click();
    await expect(page).toHaveURL(/tab=assignments/);
    await page.reload();
    await expect(page.getByRole("tab", { name: /^Assignments/ })).toHaveAttribute("aria-selected", "true");
    const assignment = page.locator(".course-assignment-list article").filter({ hasText: "Proof assignment" });
    await expect(assignment).toContainText("Overdue");
    await expect(assignment.getByRole("link", { name: "Get help" })).toHaveAttribute("href", new RegExp(`workflow=assignment-support.*assignmentId=${assignmentId}`));
    await expect(assignment.getByRole("link", { name: "Plan work" })).toBeVisible();
    await expect(assignment.getByRole("link", { name: "Review draft" })).toBeVisible();

    await page.getByRole("tab", { name: /^Exams/ }).click();
    const exam = page.locator(".course-exam-list article").filter({ hasText: "Midterm" });
    await expect(exam).toContainText(/Ready|Developing|Needs attention|Insufficient data/);
    await expect(exam.getByRole("link", { name: "Prepare" })).toHaveAttribute("href", new RegExp(`workflow=exam-preparation.*examId=${examId}`));
    await expect(exam.getByRole("link", { name: "Practice quiz" })).toHaveAttribute("href", /agent=quiz/);
    await expect(exam.getByRole("link", { name: "Update plan" })).toHaveAttribute("href", /agent=study-planner/);

    await page.getByRole("tab", { name: /^Documents/ }).click();
    await expect(page.getByRole("button", { name: "Upload document" })).toBeVisible();
    const readyDocument = page.getByText("Lecture 6 — Induction", { exact: true }).locator("xpath=ancestor::article");
    await expect(readyDocument).toContainText("Lecture");
    await expect(readyDocument.getByRole("link", { name: "Study lecture" })).toHaveAttribute("href", new RegExp(`documentId=${readyDocumentId}.*workflow=lecture-study`));
    await expect(readyDocument.getByRole("link", { name: "Summarize" })).toHaveAttribute("href", /agent=notes/);
    await expect(readyDocument.getByRole("link", { name: "Quiz me" })).toHaveAttribute("href", /agent=quiz/);
    const failedDocument = page.getByText("Review sheet", { exact: true }).locator("xpath=ancestor::article");
    await expect(failedDocument.getByRole("button", { name: "Retry processing" })).toBeVisible();
    await expect(failedDocument.getByRole("button", { name: "Delete document" })).toBeVisible();

    await page.getByRole("tab", { name: /^Notes/ }).click();
    await expect(page.getByText("Lecture 6 Summary", { exact: true })).toBeVisible();
    await page.getByText("Lecture 6 Summary", { exact: true }).click();
    await expect(page.getByRole("link", { name: "Continue in AI" })).toHaveAttribute("href", /agent=notes/);
    await expect(page.getByRole("link", { name: "Turn into quiz" })).toHaveAttribute("href", /agent=quiz/);

    await page.goto(`/student/courses/${courseId}?tab=progress`);
    await expect(page.getByRole("tab", { name: /^Progress/ })).toHaveAttribute("aria-selected", "true");
    const weakTopic = page.locator(".course-topic-row").filter({ hasText: "Mathematical Induction" });
    await expect(weakTopic).toContainText("Mastery 38");
    await expect(weakTopic.getByRole("link", { name: "Recover" })).toHaveAttribute("href", /workflow=weak-topic-recovery/);
    const lowEvidence = page.locator(".course-topic-row").filter({ hasText: "Relations" });
    await expect(lowEvidence).toContainText("Needs more evidence");
    await expect(lowEvidence.getByRole("link", { name: "Diagnostic quiz" })).toHaveAttribute("href", /agent=quiz/);

    await page.goto(`/student/documents/${readyDocumentId}?page=3`);
    await expect(page.getByRole("heading", { name: "Page 3" })).toBeVisible();
    await expect(page.getByText(/assumes the claim for k/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Study this lecture" })).toHaveAttribute("href", /workflow=lecture-study/);

    await page.goto(`/student/courses/${courseId}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("tab", { name: /^Progress/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1 AND email=$2', [userId, email]);
    await pool.end();
  }
});
