import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";

test("integration settings show permissions, connect through state, reconnect, confirm disconnect and stay responsive", async ({ page }) => {
  test.setTimeout(120000);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let userId: string | undefined;
  try {
    const headers = { Origin: "http://localhost:3000" };
    const signup = await page.request.post("/api/auth/sign-up/email", { headers, data: { name: "Integration Student", email: `integration-ui-${randomUUID()}@example.test`, password: "Integration-browser-password-2026!" } });
    expect(signup.ok()).toBe(true); userId = (await signup.json()).user.id;
    expect((await page.request.put("/api/student/profile", { headers, data: { name: "Integration Student", school: "Test", program: "CS", currentYear: 1, semester: "Fall", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } })).ok()).toBe(true);
    const activeId = randomUUID(), expiredId = randomUUID();
    const scopes = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"];
    for (const [id, email, status] of [[activeId, "personal@example.test", "ACTIVE"], [expiredId, "university@example.test", "EXPIRED"]]) {
      await pool.query(`INSERT INTO "ConnectedAccount" (id,"userId",provider,"providerAccountId",email,status,scopes,"updatedAt") VALUES ($1,$2,'google',$1,$3,$4::"ConnectedAccountStatus",$5,NOW())`, [id,userId,email,status,scopes]);
    }
    let aiCalls = 0;
    await page.route("**/api/student/assistant/requests/**", async (route) => { aiCalls++; await route.abort(); });
    // Provider consent is intercepted in the browser. No real Google authorization.
    await page.route("https://accounts.google.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Test Google consent</h1>" }));
    await page.goto("/student/settings#integrations");
    const section = page.getByRole("region", { name: "Integrations", exact: true });
    await expect(section).toBeVisible();
    const active = section.getByRole("article", { name: "Google account personal@example.test" });
    const expired = section.getByRole("article", { name: "Google account university@example.test" });
    await expect(active.getByText("Connected", { exact: true })).toBeVisible();
    await expect(expired.getByText("Needs reconnect", { exact: true })).toBeVisible();
    await expect(active.getByText("Read calendar events", { exact: true })).toBeVisible();
    await expect(section).not.toContainText("googleapis.com/auth");
    const connect = section.getByRole("button", { name: "Connect Google", exact: true });
    if (await connect.isEnabled()) {
      await connect.click(); await expect(page.getByRole("heading", { name: "Test Google consent" })).toBeVisible();
      const authorization = new URL(page.url()); const state = authorization.searchParams.get("state")!;
      expect(authorization.searchParams.get("scope")).not.toContain("calendar");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      await page.goto(`http://localhost:3000/api/student/integrations/google/callback?state=${state}&error=access_denied`);
      await expect(page).toHaveURL(/\/student\/settings\?integration=ACCESS_DENIED#integrations/);
      await expect(section.getByRole("alert")).toHaveText("Connection cancelled. No new access was saved.");
      await expired.getByRole("button", { name: "Reconnect", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Test Google consent" })).toBeVisible();
      const reconnectState = new URL(page.url()).searchParams.get("state")!;
      const session = await pool.query(`SELECT "targetAccountId","requestedScopes" FROM "OAuthConnectionSession" WHERE "userId"=$1 AND "usedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`, [userId]);
      expect(session.rows[0].targetAccountId).toBe(expiredId); expect(session.rows[0].requestedScopes).toContain(scopes[3]);
      await page.goto(`http://localhost:3000/api/student/integrations/google/callback?state=${reconnectState}&error=access_denied`);
    } else {
      await expect(section.getByText("Connection setup is not available yet.", { exact: false })).toBeVisible();
    }
    await active.getByRole("button", { name: "Disconnect", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "Disconnect Google?" })).toBeVisible();
    await expect(dialog).toContainText("will not delete your external calendar");
    await dialog.getByRole("button", { name: "Keep connected" }).click();
    expect((await pool.query(`SELECT status FROM "ConnectedAccount" WHERE id=$1`, [activeId])).rows[0].status).toBe("ACTIVE");
    await active.getByRole("button", { name: "Disconnect", exact: true }).click();
    await dialog.getByRole("button", { name: "Disconnect account", exact: true }).click();
    await expect(active.getByText("Disconnected", { exact: true })).toBeVisible();
    await page.reload(); await expect(active.getByText("Disconnected", { exact: true })).toBeVisible();
    expect(JSON.stringify(await (await page.request.get("/api/student/integrations")).json())).not.toMatch(/Token|Encrypted/);
    await page.setViewportSize({ width: 390, height: 844 }); await section.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(expired.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/integration-settings-mobile.png", fullPage: true });
    expect(aiCalls).toBe(0);
  } finally {
    if (userId) await pool.query('DELETE FROM "User" WHERE id=$1', [userId]);
    await pool.end();
  }
});
