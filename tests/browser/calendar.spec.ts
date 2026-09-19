import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";
test("Calendar selection, separate write consent and explicit study-event actions work on mobile", async ({ page }) => {
    test.setTimeout(120000);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let userId: string | undefined;
    try {
        const headers = { Origin: "http://localhost:3000" };
        const signup = await page.request.post("/api/auth/sign-up/email", { headers, data: { name: "Calendar Student", email: `calendar-ui-${randomUUID()}@example.test`, password: "Calendar-browser-passphrase-2026!" } });
        expect(signup.ok()).toBe(true);
        userId = (await signup.json()).user.id;
        expect((await page.request.put("/api/student/profile", { headers, data: { name: "Calendar Student", school: "Test", program: "CS", currentYear: 1, semester: "Fall", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "America/Winnipeg" } })).ok()).toBe(true);
        const accountId = randomUUID(), planId = randomUUID(), taskId = randomUUID();
        const scopes = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"];
        await pool.query(`INSERT INTO "ConnectedAccount" (id,"userId",provider,"providerAccountId",email,status,scopes,"updatedAt") VALUES ($1,$2,'google',$1,'student@example.test','ACTIVE',$3,NOW())`, [accountId, userId, scopes]);
        let selections: unknown;
        let refreshes = 0;
        let aiCalls = 0;
        const writes: string[] = [];
        const settings = { calendars: [{ id: "primary", title: "Personal", timezone: "America/Winnipeg", canWrite: true, enabledForAvailability: false, allowStudyWrites: false, blockAllDay: false }, { id: "work", title: "Work", timezone: "America/Winnipeg", canWrite: false, enabledForAvailability: false, allowStudyWrites: false, blockAllDay: false }], sync: { status: "COMPLETED", lastSuccessfulSyncAt: "2026-09-20T12:00:00Z", lastErrorCode: null } };
        await page.route("**/api/student/calendar/accounts/**", async (route) => { const req = route.request(); if (req.url().endsWith("/refresh"))
            refreshes++; if (req.method() === "PUT")
            selections = req.postDataJSON(); await route.fulfill({ json: settings }); });
        await page.route("**/api/student/assistant/requests/**", async (route) => { aiCalls++; await route.abort(); });
        await page.route("https://accounts.google.com/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Test consent</h1>" }));
        await page.goto("/student/settings#integrations");
        const section = page.getByLabel("Google Calendar settings");
        await expect(section).toContainText("Read access enabled");
        await expect(section).toContainText("Write access not enabled");
        await section.getByRole("button", { name: "Manage calendars" }).click();
        await section.getByRole("group", { name: "Personal", exact: true }).getByLabel("Use for availability").check();
        await section.getByRole("button", { name: "Save calendars" }).click();
        await expect.poll(() => selections).toEqual({ calendars: [{ id: "primary", enabledForAvailability: true, allowStudyWrites: false, blockAllDay: false }] });
        await section.getByRole("button", { name: "Refresh Calendar" }).click();
        await expect.poll(() => refreshes).toBe(1);
        await section.getByRole("button", { name: "Enable Calendar write access" }).click();
        await expect(page.getByRole("heading", { name: "Test consent" })).toBeVisible();
        const consent = new URL(page.url());
        expect(consent.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar.events");
        expect(consent.searchParams.get("scope")).not.toContain("gmail");
        await pool.query(`INSERT INTO "StudyPlan" (id,"userId",title,"startDate","endDate",summary,"totalPlannedMinutes","updatedAt",assumptions) VALUES ($1,$2,'Exam preparation','2026-09-28','2026-09-28','Focused practice',45,NOW(),ARRAY['Calendar availability considered.'])`, [planId, userId]);
        await pool.query(`INSERT INTO "StudyTask" (id,"userId","studyPlanId",date,title,"activityType","durationMinutes",priority,reason,"updatedAt","scheduledStart","scheduledEnd","scheduledTimezone") VALUES ($1,$2,$3,'2026-09-28','Practice induction','PRACTICE',45,80,'Review weak topic',NOW(),'2026-09-28T23:00Z','2026-09-28T23:45Z','America/Winnipeg')`, [taskId, userId, planId]);
        const options = { timezone: "America/Winnipeg", scheduledStart: "2026-09-28T23:00:00Z", scheduledEnd: "2026-09-28T23:45:00Z", targets: [{ connectedAccountId: accountId, calendarId: "primary", label: "student@example.test · Personal" }], links: [] as {
                id: string;
                connectedAccountId: string;
                calendarId: string;
                status: string;
                needsUpdate: boolean;
                openUrl: string | null;
            }[] };
        await page.route(`**/api/student/calendar/tasks/${taskId}`, async (route) => { const req = route.request(); if (req.method() === "POST") {
            const action = req.postDataJSON();
            expect(action.confirmed).toBe(true);
            expect(action).not.toHaveProperty("userId");
            writes.push(action.action);
            options.links = [{ id: "link", connectedAccountId: accountId, calendarId: "primary", status: action.action === "remove" ? "REMOVED" : "LINKED", needsUpdate: false, openUrl: action.action === "remove" ? null : "https://calendar.google.com/calendar/event?eid=test" }];
        } await route.fulfill({ json: options }); });
        await page.goto(`/student/study-plan?planId=${planId}`);
        await expect(page.getByText(/Calendar availability considered/)).toBeVisible();
        await page.getByRole("button", { name: "Calendar options" }).click();
        const actions = page.getByLabel("Calendar for Practice induction");
        await actions.getByLabel("Calendar destination").selectOption("0");
        expect(writes).toEqual([]);
        await actions.getByRole("button", { name: "Add to Google Calendar", exact: true }).click();
        await expect(actions.getByText("Added to Google Calendar", { exact: true })).toBeVisible();
        expect(writes).toEqual(["create"]);
        await actions.getByRole("button", { name: "Update Calendar event" }).click();
        await expect.poll(() => writes).toEqual(["create", "update"]);
        await actions.getByRole("button", { name: "Remove from Google Calendar" }).click();
        await expect(actions.getByText("Removed from Google Calendar", { exact: true })).toBeVisible();
        expect(writes).toEqual(["create", "update", "remove"]);
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: "/tmp/calendar-task-mobile.png", fullPage: true });
        await page.goto("/student/settings#integrations");
        await section.getByRole("button", { name: "Manage calendars" }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: "/tmp/calendar-settings-mobile.png", fullPage: true });
        expect(aiCalls).toBe(0);
    }
    finally {
        if (userId)
            await pool.query('DELETE FROM "User" WHERE id=$1', [userId]);
        await pool.end();
    }
});
