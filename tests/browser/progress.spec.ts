import "dotenv/config";
import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

test("shows trustworthy progress, deep actions, refresh and the mobile critical flow", async ({ page }) => {
  test.setTimeout(120000);
  const email = `progress-browser-${randomUUID()}@example.test`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const origin = { Origin: "http://localhost:3000" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", {
      headers: origin,
      data: { name: "Progress Student", email, password: "Progress-browser-passphrase-2026!" },
    });
    expect(signup.ok()).toBe(true);
    userId = (await signup.json()).user.id;
    expect((await page.request.put("/api/student/profile", { headers: origin, data: {
      name: "Progress Student", school: "Test University", program: "Mathematics",
      currentYear: 2, semester: "Fall 2026", academicGoal: "Master proofs",
      studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC",
    } })).ok()).toBe(true);
    const courseResponse = await page.request.post("/api/student/courses", { headers: origin, data: {
      courseCode: "MATH 1240", courseName: "Discrete Mathematics", semester: "Fall 2026", professor: "", description: "",
    } });
    expect(courseResponse.ok()).toBe(true);
    const courseId = (await courseResponse.json()).id as string;
    const now = new Date();
    const weakId = randomUUID();
    const strongId = randomUUID();
    const lowEvidenceId = randomUUID();
    const examId = randomUUID();
    const planId = randomUUID();
    const quizId = randomUUID();
    const questionId = randomUUID();
    const attemptId = randomUUID();
    const questionAttemptId = randomUUID();
    const taskId = randomUUID();
    const examDate = new Date(now.getTime() + 5 * 86_400_000);
    const day = now.toISOString().slice(0, 10);

    for (const topic of [
      { id: weakId, name: "Mathematical Induction", mastery: 38, confidence: 88, accuracy: 35, attempts: 12, trend: "DECLINING" },
      { id: strongId, name: "Logic", mastery: 91, confidence: 92, accuracy: 92, attempts: 14, trend: "IMPROVING" },
      { id: lowEvidenceId, name: "Relations", mastery: 42, confidence: 18, accuracy: 100, attempts: 1, trend: "INSUFFICIENT_DATA" },
    ]) {
      await pool.query(`INSERT INTO "LearningTopic" ("id","userId","courseId","name","normalizedName","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`, [topic.id, userId, courseId, topic.name, topic.name.toLowerCase()]);
      await pool.query(`INSERT INTO "LearningProgress" ("id","userId","courseId","topicId","masteryScore","confidenceScore","questionsAttempted","correctAnswers","incorrectAnswers","scoreTotal","difficultyWeightedScore","difficultyWeightTotal","practiceSessions","mediumAttempts","recentAccuracy","firstPracticedAt","lastPracticedAt","trend","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$13,LEAST(3,$7),$7,$11,NOW()-INTERVAL '20 days',NOW()-INTERVAL '1 day',$12,NOW(),NOW())`, [randomUUID(), userId, courseId, topic.id, topic.mastery, topic.confidence, topic.attempts, Math.round(topic.attempts * topic.accuracy / 100), topic.attempts - Math.round(topic.attempts * topic.accuracy / 100), topic.attempts * topic.accuracy / 100, topic.accuracy, topic.trend, Number(topic.attempts)]);
    }
    await pool.query(`INSERT INTO "LearningProgressSnapshot" ("id","userId","courseId","topicId","masteryScore","confidenceScore","recentAccuracy","questionsAttempted","trend","recordedAt") VALUES ($1,$2,$3,$4,50,65,48,6,'STABLE',NOW()-INTERVAL '10 days'),($5,$2,$3,$4,38,88,35,12,'DECLINING',NOW()-INTERVAL '1 day')`, [randomUUID(), userId, courseId, weakId, randomUUID()]);
    await pool.query(`INSERT INTO "Exam" ("id","userId","courseId","title","examDate","topics","createdAt","updatedAt") VALUES ($1,$2,$3,'Midterm',$4,$5,NOW(),NOW())`, [examId, userId, courseId, examDate, ["Mathematical Induction", "Logic"]]);
    await pool.query(`INSERT INTO "StudyPlan" ("id","userId","title","startDate","endDate","summary","totalPlannedMinutes","status","createdAt","updatedAt") VALUES ($1,$2,'Midterm plan',NOW()-INTERVAL '2 days',$3,'Prepare for the midterm.',45,'ACTIVE',NOW(),NOW())`, [planId, userId, examDate]);
    await pool.query(`INSERT INTO "StudyTask" ("id","userId","studyPlanId","courseId","topicId","examId","date","title","topic","activityType","durationMinutes","priority","status","reason","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,'Review induction','Mathematical Induction','REVIEW',45,90,'COMPLETED','Induction needs attention.',NOW(),NOW())`, [taskId, userId, planId, courseId, weakId, examId, `${day}T00:00:00.000Z`]);
    await pool.query(`INSERT INTO "Quiz" ("id","userId","courseId","title","topic","difficulty","createdAt","updatedAt") VALUES ($1,$2,$3,'Induction practice','Mathematical Induction','HARD',NOW(),NOW())`, [quizId, userId, courseId]);
    await pool.query(`INSERT INTO "QuizQuestion" ("id","quizId","userId","position","type","prompt","correctAnswer","explanation","topicNames","createdAt") VALUES ($1,$2,$3,1,'SHORT_ANSWER','State the induction step','Answer','Explanation',$4,NOW())`, [questionId, quizId, userId, ["Mathematical Induction"]]);
    await pool.query(`INSERT INTO "QuizQuestionTopic" ("questionId","topicId","userId","courseId","createdAt") VALUES ($1,$2,$3,$4,NOW())`, [questionId, weakId, userId, courseId]);
    await pool.query(`INSERT INTO "QuizAttempt" ("id","userId","quizId","startedAt","completedAt","createdAt","updatedAt") VALUES ($1,$2,$3,NOW()-INTERVAL '1 day',NOW()-INTERVAL '1 day',NOW(),NOW())`, [attemptId, userId, quizId]);
    await pool.query(`INSERT INTO "QuestionAttempt" ("id","userId","quizId","quizAttemptId","questionId","userAnswer","score","isCorrect","evaluationMethod","attemptedAt","updatedAt") VALUES ($1,$2,$3,$4,$5,'Answer',0.7,false,'SEMANTIC',NOW()-INTERVAL '1 day',NOW())`, [questionAttemptId, userId, quizId, attemptId, questionId]);

    await page.goto("/student/progress");
    await expect(page.getByRole("heading", { name: "Study & progress" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
    await expect(page.getByText("Mathematical Induction", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".progress-topic-row").filter({ hasText: "Relations" })).toContainText("Low evidence");
    await expect(page.getByRole("heading", { name: "Quiz performance" })).toBeVisible();
    await expect(page.getByText("hard", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Study consistency" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Exam readiness" })).toBeVisible();

    const weakRow = page.locator(".progress-topic-row").filter({ hasText: "Mathematical Induction" }).first();
    await expect(weakRow.getByRole("link", { name: "Review" })).toHaveAttribute("href", /agent=tutor/);
    await expect(weakRow.getByRole("link", { name: "Practice" })).toHaveAttribute("href", /agent=quiz/);
    await expect(weakRow.getByRole("link", { name: "Start recovery" })).toHaveAttribute("href", /workflow=weak-topic-recovery/);
    const examCard = page.locator(".exam-readiness-list article").first();
    await expect(examCard.getByRole("link", { name: "Prepare for exam" })).toHaveAttribute("href", /workflow=exam-preparation/);
    await expect(examCard.getByRole("link", { name: "Update plan" })).toHaveAttribute("href", /agent=study-planner/);
    await expect(examCard.getByRole("link", { name: "Practice quiz" })).toHaveAttribute("href", /agent=quiz/);

    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("heading", { name: "Study & progress" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Study plan progress" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Exam readiness" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1 AND email=$2', [userId, email]);
    await pool.end();
  }
});
