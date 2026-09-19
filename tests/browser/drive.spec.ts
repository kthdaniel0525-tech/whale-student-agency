import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";
const origin = { Origin: "http://localhost:3000" };
async function fixture(page: Page, pool: Pool, enabled: boolean) {
    const signup = await page.request.post("/api/auth/sign-up/email", { headers: origin, data: { name: "Drive Student", email: `drive-ui-${randomUUID()}@example.test`, password: "Drive-browser-password-2026!" } });
    expect(signup.ok()).toBe(true);
    const userId = (await signup.json()).user.id as string;
    expect((await page.request.put("/api/student/profile", { headers: origin, data: { name: "Drive Student", school: "Test", program: "Math", currentYear: 1, semester: "Fall 2026", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } })).ok()).toBe(true);
    const course = await page.request.post("/api/student/courses", { headers: origin, data: { courseCode: "MATH 1240", courseName: "Mathematical Induction", semester: "Fall 2026", professor: "", description: "" } });
    expect(course.ok()).toBe(true);
    const courseId = (await course.json()).id as string;
    const accountId = randomUUID();
    await pool.query(`INSERT INTO "ConnectedAccount" (id,"userId",provider,"providerAccountId",email,status,scopes,"updatedAt") VALUES ($1,$2,'google',$1,'drive-student@example.test','ACTIVE',$3,NOW())`, [accountId, userId, ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", ...(enabled ? ["https://www.googleapis.com/auth/drive.readonly"] : [])]]);
    return { userId, courseId, accountId };
}
test("Drive is enabled only through separate incremental consent", async ({ page }) => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let userId: string | undefined;
    try {
        const f = await fixture(page, pool, false);
        userId = f.userId;
        await page.route("https://accounts.google.com/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Drive consent fixture</h1>" }));
        await page.goto("/student/settings#integrations");
        const panel = page.getByRole("region", { name: "Google Drive settings" });
        await expect(panel).toContainText("Needs permission");
        await panel.getByRole("button", { name: "Enable Drive" }).click();
        await expect(page.getByRole("heading", { name: "Drive consent fixture" })).toBeVisible();
        const url = new URL(page.url());
        expect(url.searchParams.get("scope")).toContain("drive.readonly");
        expect(url.searchParams.get("scope")).not.toContain("calendar");
        expect(url.searchParams.get("include_granted_scopes")).toBe("true");
        expect((await pool.query('SELECT scopes FROM "ConnectedAccount" WHERE id=$1', [f.accountId])).rows[0].scopes).not.toContain("https://www.googleapis.com/auth/drive.readonly");
    }
    finally {
        if (userId)
            await pool.query('DELETE FROM "User" WHERE id=$1', [userId]);
        await pool.end();
    }
});
test("course Drive browser supports search, folders, pagination, partial imports and mobile", async ({ page }) => {
    test.setTimeout(90000);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let userId: string | undefined;
    try {
        const f = await fixture(page, pool, true);
        userId = f.userId;
        const selected: string[] = [], queries: URL[] = [];
        const imports: {
            id: string;
            name: string;
            documentId: string | null;
            courseId: string;
            status: string;
            syncStatus: string;
            error: string | null;
        }[] = [];
        const file = (id: string, name: string, folder = false, importable = true) => ({ externalId: id, name, mimeType: folder ? "application/vnd.google-apps.folder" : "application/pdf", modifiedAt: "2026-09-19T00:00:00Z", size: 100, parentIds: [], webViewLink: null, exportable: false, folder, provider: "google", connectedAccountId: f.accountId, importable, unavailableReason: importable ? null : "Unsupported file type" });
        await page.route(`**/api/student/drive/accounts/${f.accountId}/files*`, async (route) => {
            const url = new URL(route.request().url());
            queries.push(url);
            await route.fulfill({ json: url.searchParams.has("pageToken") ? { files: [file("fail", "Fails.pdf")], nextPageToken: null } : { files: [file("pdf", "Lecture.pdf"), file("txt", "Notes.txt"), file("bad", "Archive.zip", false, false), file("folder", "Lectures", true)], nextPageToken: "next-page" } });
        });
        await page.route(`**/api/student/drive/accounts/${f.accountId}/imports*`, route => route.fulfill({ json: imports }));
        await page.route("**/api/student/drive/imports", async (route) => {
            const input = route.request().postDataJSON();
            expect(input.courseId).toBe(f.courseId);
            expect(input.connectedAccountId).toBe(f.accountId);
            expect(input).not.toHaveProperty("userId");
            selected.push(input.externalFileId);
            if (input.externalFileId === "fail")
                return route.fulfill({ status: 503, json: { error: "Temporary import failure" } });
            const row = { id: input.externalFileId, name: input.externalFileId === "pdf" ? "Lecture.pdf" : "Notes.txt", documentId: null, courseId: f.courseId, status: input.externalFileId === "pdf" ? "Ready" : "Processing", syncStatus: "IDLE", error: null };
            imports.push(row);
            await route.fulfill({ json: row });
        });
        await page.goto(`/student/courses/${f.courseId}`);
        await page.getByRole("tab", { name: /^Documents/ }).click();
        await page.getByRole("button", { name: "Import from Google Drive" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByLabel("Import to course")).toHaveValue(f.courseId);
        await expect(dialog.getByLabel("Import to course")).toBeDisabled();
        await expect(dialog.getByLabel("Archive.zip", { exact: false })).toBeDisabled();
        await dialog.getByLabel("Search Drive by filename").fill("Lecture");
        await dialog.getByRole("button", { name: "Search", exact: true }).click();
        await expect.poll(() => queries.at(-1)?.searchParams.get("search")).toBe("Lecture");
        await dialog.getByRole("button", { name: "Open folder: Lectures" }).click();
        await expect.poll(() => queries.at(-1)?.searchParams.get("folderId")).toBe("folder");
        await dialog.getByLabel("Lecture.pdf", { exact: false }).check();
        await dialog.getByLabel("Notes.txt", { exact: false }).check();
        await dialog.getByRole("button", { name: "Next page" }).click();
        await expect(dialog.getByLabel("Fails.pdf", { exact: false })).toBeVisible();
        await dialog.getByLabel("Fails.pdf", { exact: false }).check();
        await dialog.getByRole("button", { name: "Import selected (3/10)", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText("Temporary import failure");
        await expect(dialog.getByRole("status")).toContainText("1 Ready · 1 Processing · 0 Importing · 1 Failed");
        expect(selected.sort()).toEqual(["fail", "pdf", "txt"]);
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(dialog).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: "/tmp/drive-browser-mobile.png", fullPage: true });
    }
    finally {
        if (userId)
            await pool.query('DELETE FROM "User" WHERE id=$1', [userId]);
        await pool.end();
    }
});
