import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";

test("notification center persists controls, rolls back failed updates, paginates and launches preserved context", async ({ page }) => {
  test.setTimeout(120000);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const origin = { Origin: "http://localhost:3000" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", { headers: origin, data: { name: "Notification Student", email: `notification-ui-${randomUUID()}@example.test`, password: "Notification-browser-passphrase-2026!" } });
    expect(signup.ok()).toBe(true); userId = (await signup.json()).user.id;
    expect((await page.request.put("/api/student/profile", { headers: origin, data: {
      name: "Notification Student", school: "Test University", program: "Mathematics", currentYear: 2, semester: "Fall 2026", academicGoal: "Master proofs", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC",
    } })).ok()).toBe(true);
    const courseId = randomUUID(), assignmentId = randomUUID();
    await pool.query(`INSERT INTO "Course" (id,"userId","courseCode","courseName",semester,"createdAt","updatedAt") VALUES ($1,$2,'MATH 1240','Discrete Mathematics','Fall 2026',NOW(),NOW())`, [courseId, userId]);
    await pool.query(`INSERT INTO "Assignment" (id,"userId","courseId",title,"dueDate",priority,"estimatedHours","createdAt","updatedAt") VALUES ($1,$2,$3,'Proof assignment',NOW()+INTERVAL '1 day','HIGH',4,NOW(),NOW())`, [assignmentId,userId,courseId]);
    const ids: string[] = [], reminderIds: string[] = [];
    for (let i = 0; i < 22; i++) {
      const reminderId = randomUUID(), notificationId = randomUUID(); reminderIds.push(reminderId); ids.push(notificationId);
      const action = JSON.stringify({ courseId, assignmentId });
      await pool.query(`INSERT INTO "Reminder" (id,"userId",type,title,message,priority,"priorityScore",status,"sourceType","sourceId","scheduledFor","expiresAt","deliveredAt","reasonCode","reasonData","actionTargetType","actionTargetId","actionPayload","dedupeKey","supersessionKey","stateFingerprint","createdAt","updatedAt") VALUES ($1,$2,'ASSIGNMENT_DUE',$3,'Your proof assignment is due tomorrow.','HIGH',80,'DELIVERED','ASSIGNMENT',$4,NOW(),NOW()+INTERVAL '2 days',NOW(),'ASSIGNMENT_DUE_TOMORROW','{}','WORKFLOW','assignment-support',$5,$1,$1,'fixture',NOW(),NOW())`, [reminderId,userId,`Study reminder ${i}`,assignmentId,action]);
      await pool.query(`INSERT INTO "Notification" (id,"userId","reminderId",channel,type,title,message,priority,status,"actionTargetType","actionTargetId","actionPayload","scheduledFor","deliveredAt","deliveryCount","createdAt","updatedAt") VALUES ($1,$2,$3,'IN_APP','ASSIGNMENT_DUE',$4,'Your proof assignment is due tomorrow.','HIGH','DELIVERED','WORKFLOW','assignment-support',$5,NOW(),NOW()-($6 * INTERVAL '1 minute'),1,NOW(),NOW())`, [notificationId,userId,reminderId,`Study reminder ${i}`,action,i]);
    }
    await page.goto("/student/notifications");
    await expect(page.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Notifications, 22 unread" })).toBeVisible();
    expect((await page.request.get("/api/student/notifications/unread-count").then((response) => response.json())).count).toBe(22);
    await expect(page.getByRole("article")).toHaveCount(20);
    await page.getByRole("button", { name: "Load earlier notifications" }).click();
    await expect(page.getByRole("article")).toHaveCount(22);
    await page.getByRole("article", { name: "Study reminder 0", exact: true }).getByRole("button", { name: "Mark read", exact: true }).click();
    await expect(page.getByRole("link", { name: "Notifications, 21 unread" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("article", { name: "Study reminder 0", exact: true }).getByRole("button", { name: "Mark read", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Unread", exact: true }).click();
    await expect(page.getByRole("article", { name: "Study reminder 0", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("article", { name: "Study reminder 0", exact: true }).getByRole("button", { name: "Snooze 1 hour" }).click();
    await expect(page.getByRole("article", { name: "Study reminder 0", exact: true }).getByText("Handled", { exact: true })).toBeVisible();
    expect((await pool.query(`SELECT status FROM "Reminder" WHERE id=$1`, [reminderIds[0]])).rows[0].status).toBe("SNOOZED");
    await page.getByRole("button", { name: "Dismiss Study reminder 1", exact: true }).click();
    await expect.poll(async () => (await pool.query(`SELECT status FROM "Reminder" WHERE id=$1`, [reminderIds[1]])).rows[0].status).toBe("DISMISSED");
    await page.route(`**/api/student/notifications/${ids[2]}`, async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary test failure. Try again." }) });
    });
    const third = page.getByRole("article", { name: "Study reminder 2", exact: true });
    await third.getByRole("button", { name: "Mark read", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Temporary test failure" })).toBeVisible();
    await expect(third.getByRole("button", { name: "Mark read", exact: true })).toBeVisible();
    await page.unroute(`**/api/student/notifications/${ids[2]}`);
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect(page.getByText("Timely reminders for the work that matters. 0 unread.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Notifications", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/notification-center-mobile.png", fullPage: false });
    await page.setViewportSize({ width: 1365, height: 950 });
    await page.screenshot({ path: "/tmp/notification-center-desktop.png", fullPage: false });
    let launch: { assignmentId?: string; courseId?: string; preferredWorkflowId?: string } | undefined;
    await page.route("**/api/student/assistant/requests/stream", async (route) => {
      launch = route.request().postDataJSON();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "AI execution intentionally intercepted in UI test." }) });
    });
    await third.getByRole("button", { name: "Work on assignment" }).click();
    await expect(page).toHaveURL(/\/student\/assistant\?/);
    await expect.poll(() => launch).toMatchObject({ assignmentId, courseId, preferredWorkflowId: "assignment-support" });
    expect((await pool.query(`SELECT status FROM "Notification" WHERE id=$1`, [ids[2]])).rows[0].status).toBe("READ");
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1', [userId]);
    await pool.end();
  }
});

test("workflow notification reopens the existing waiting run without starting AI execution", async ({ page }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const origin = { Origin: "http://localhost:3000" };
  let userId: string | undefined;
  try {
    const signup = await page.request.post("/api/auth/sign-up/email", { headers: origin, data: { name: "Workflow Student", email: `notification-run-${randomUUID()}@example.test`, password: "Notification-browser-passphrase-2026!" } });
    userId = (await signup.json()).user.id;
    await page.request.put("/api/student/profile", { headers: origin, data: { name: "Workflow Student", school: "Test University", program: "Mathematics", currentYear: 2, semester: "Fall 2026", academicGoal: "Master proofs", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
    const runId = randomUUID(), reminderId = randomUUID(), notificationId = randomUUID();
    await pool.query(`INSERT INTO "WorkflowRun" (id,"userId","workflowId",status,input,context,"updatedAt") VALUES ($1,$2,'assignment-support','WAITING_FOR_INPUT','{}','{}',NOW())`, [runId, userId]);
    const payload = JSON.stringify({ workflowRunId: runId });
    await pool.query(`INSERT INTO "Reminder" (id,"userId",type,title,message,priority,"priorityScore",status,"sourceType","sourceId","scheduledFor","reasonCode","reasonData","actionTargetType","actionTargetId","actionPayload","dedupeKey","supersessionKey","stateFingerprint","updatedAt") VALUES ($1,$2,'WORKFLOW_WAITING','Continue your assignment','Your workflow is waiting for input.','MEDIUM',60,'DELIVERED','WORKFLOW_RUN',$3,NOW(),'WORKFLOW_WAITING_FOR_INPUT','{}','RESOURCE','workflow-run',$4,$1,$1,'fixture',NOW())`, [reminderId,userId,runId,payload]);
    await pool.query(`INSERT INTO "Notification" (id,"userId","reminderId",type,title,message,priority,status,"actionTargetType","actionTargetId","actionPayload","scheduledFor","deliveredAt","updatedAt") VALUES ($1,$2,$3,'WORKFLOW_WAITING','Continue your assignment','Your workflow is waiting for input.','MEDIUM','DELIVERED','RESOURCE','workflow-run',$4,NOW(),NOW(),NOW())`, [notificationId,userId,reminderId,payload]);
    let executions = 0;
    await page.route("**/api/student/assistant/requests/stream", async (route) => { executions++; await route.abort(); });
    await page.goto("/student/notifications");
    await page.getByRole("button", { name: "Resume workflow" }).click();
    await expect(page).toHaveURL(`/student/assistant/workflows/${runId}`);
    await expect(page.getByRole("region", { name: "Assignment Support workflow" })).toBeVisible();
    expect(executions).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "WorkflowRun" WHERE "userId"=$1`, [userId])).rows[0].count).toBe(1);
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1', [userId]);
    await pool.end();
  }
});
