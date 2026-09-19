import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";
const origin = { Origin: "http://localhost:3000" };
async function fixture(page: Page) {
    const response = await page.request.post("/api/auth/sign-up/email", { headers: origin, data: { name: "LMS Student", email: `lms-ui-${randomUUID()}@example.test`, password: "Lms-browser-password-2026!" } });
    expect(response.ok()).toBe(true);
    const userId = (await response.json()).user.id as string;
    expect((await page.request.put("/api/student/profile", { headers: origin, data: { name: "LMS Student", school: "Test", program: "Math", currentYear: 1, semester: "Fall 2026", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } })).ok()).toBe(true);
    const course = await page.request.post("/api/student/courses", { headers: origin, data: { courseCode: "MATH 1240", courseName: "Discrete Mathematics", semester: "Fall 2026", professor: "", description: "" } });
    expect(course.ok()).toBe(true);
    return { userId, courseId: (await course.json()).id as string };
}
test("production settings offer no fake LMS providers; unlinked courses show no sync controls", async ({ page }) => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let userId: string | undefined;
    try {
        const fixtureData = await fixture(page);
        userId = fixtureData.userId;
        await page.goto("/student/settings#academic-integrations");
        const panel = page.getByRole("region", { name: "Course imports" });
        await expect(panel).toContainText("Institution connections are not available yet");
        await expect(panel.getByRole("button", { name: "Browse courses" })).toHaveCount(0);
        expect(await (await page.request.get("/api/student/academic-integrations")).json()).toEqual({ providers: [], accounts: [] });
        await page.goto(`/student/courses/${fixtureData.courseId}`);
        expect(await (await page.request.get(`/api/student/courses/${fixtureData.courseId}/integration`)).json()).toBeNull();
        await expect(page.getByRole("region", { name: "Course integration status" })).toHaveCount(0);
    }
    finally {
        if (userId)
            await pool.query('DELETE FROM "User" WHERE id=$1', [userId]);
        await pool.end();
    }
});
test("generic LMS UI previews selected categories, explicitly links a course, and shows manual sync", async ({ page }) => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let userId: string | undefined;
    try {
        const f = await fixture(page);
        userId = f.userId;
        const accountId = "fixture-account";
        const external = { externalId: "math", name: "Discrete Mathematics", code: "MATH 1240 A01", term: "Fall 2026", provider: "fixture", connectedAccountId: accountId };
        const courseState = { id: "fixture-link", courseId: f.courseId, providerName: "Institution fixture", active: true, pending: false, status: "synced", lastSyncedAt: "2026-09-19T12:00:00.000Z", lastSuccessAt: "2026-09-19T12:00:00.000Z", result: { created: { assignments: 1, assessments: 1, files: 0, skipped: 1 }, updated: { assignments: 0, assessments: 0, files: 0, skipped: 0 }, unchanged: 0, failed: 0, missing: 1, partial: false, errors: [] } };
        await page.route("**/api/student/academic-integrations", route => route.fulfill({ json: { providers: [], accounts: [{ id: accountId, provider: "fixture", name: "Institution fixture", connected: true, capabilities: ["courses-read", "assignments-read", "assessments-read", "files-read"] }] } }));
        await page.route(`**/api/student/academic-integrations/accounts/${accountId}/courses`, route => route.fulfill({ json: { items: [external], mode: "snapshot" } }));
        let previewed = false, imported = false;
        await page.route("**/api/student/academic-integrations/preview", route => {
            expect(route.request().postDataJSON()).toEqual({ connectedAccountId: accountId, externalCourseId: "math", options: { assignments: true, assessments: true, files: false } });
            previewed = true;
            return route.fulfill({ json: { course: external, counts: { assignments: 1, assessments: 1, files: 0, skipped: 1 }, skippedReasons: ["Small quiz: does not become an exam."], suggestions: [{ courseId: f.courseId, label: "MATH 1240 · Discrete Mathematics", score: 50 }], ambiguous: true, previewToken: "reviewed-fixture" } });
        });
        await page.route("**/api/student/academic-integrations/import", route => {
            expect(previewed).toBe(true);
            imported = true;
            expect(route.request().postDataJSON()).toMatchObject({ targetCourseId: f.courseId, previewToken: "reviewed-fixture", confirmed: true, options: { files: false } });
            expect(route.request().postDataJSON()).not.toHaveProperty("userId");
            return route.fulfill({ json: { ...courseState, pending: true, status: "queued" } });
        });
        await page.route(`**/api/student/courses/${f.courseId}/integration`, route => route.fulfill({ json: courseState }));
        let synced = false;
        await page.route(`**/api/student/courses/${f.courseId}/integration/sync`, route => { synced = true; courseState.pending = true; courseState.status = "queued"; return route.fulfill({ json: courseState }); });
        await page.goto("/student/settings#academic-integrations");
        const panel = page.getByRole("region", { name: "Course imports" });
        await panel.getByRole("button", { name: "Browse courses" }).click();
        await panel.getByLabel("External course", { exact: true }).selectOption("math");
        await panel.getByLabel("Course files", { exact: true }).uncheck();
        await panel.getByRole("button", { name: "Preview import" }).click();
        await expect(panel).toContainText("1 assignments · 1 exams · 0 files");
        await expect(panel).toContainText("no match is applied automatically");
        expect(imported).toBe(false);
        await expect(panel.getByLabel("Course destination")).toHaveValue("");
        await panel.getByLabel("Course destination").selectOption(f.courseId);
        await panel.getByRole("button", { name: "Import reviewed course" }).click();
        await panel.getByRole("link", { name: "Open course" }).click();
        const status = page.getByRole("region", { name: "Course integration status" });
        await expect(status).toContainText("Institution fixture");
        await expect(status).toContainText("imported data preserved");
        await page.setViewportSize({ width: 390, height: 844 });
        await status.getByRole("button", { name: "Sync Now" }).click();
        await expect(status).toContainText("queued");
        await expect(status.getByRole("button", { name: "Sync Now" })).toBeDisabled();
        expect(synced).toBe(true);
        await expect(status.getByRole("link", { name: "Manage Integration" })).toHaveAttribute("href", "/student/settings#academic-integrations");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    finally {
        if (userId)
            await pool.query('DELETE FROM "User" WHERE id=$1', [userId]);
        await pool.end();
    }
});
