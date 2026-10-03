import "dotenv/config";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import SupportPage from "@/app/support/page";
import { LegalLinks } from "@/features/legal/legal-links";
import { LEGAL_CONTENT_REVIEW_STATUS } from "@/lib/legal/status";
import { publicSupportContact } from "@/server/legal/support";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { createConversation } from "@/server/conversations";
import { GET as listMemories } from "@/app/api/student/memories/route";
import { PATCH as archiveMemory, DELETE as deleteMemory } from "@/app/api/student/memories/[id]/route";
import { DELETE as deleteConversation } from "@/app/api/student/assistant/conversations/[id]/route";

type Actor = { id: string; headers: Headers };
const users: string[] = [];
const origin = process.env.BETTER_AUTH_URL!;
const password = "Privacy-controls-passphrase-2026!";

async function actor(): Promise<Actor> {
  const response = await auth().api.signUpEmail({ body: { name: "Privacy controls", email: `privacy-controls-${randomUUID()}@example.test`, password }, asResponse: true });
  expect(response.status).toBe(200);
  const id = (await response.json()).user.id as string;
  users.push(id);
  await db().profile.create({ data: { userId: id, school: "Test", program: "Test", currentYear: 1, semester: "Test", academicGoal: "Test controls", studySessionMinutes: 30, explanationDifficulty: "INTERMEDIATE" } });
  return { id, headers: new Headers({ origin, "content-type": "application/json", cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") }) };
}
function request(path: string, method: string, headers?: Headers, body?: unknown) {
  return new Request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await db().user.deleteMany({ where: { id: { in: users } } }); await db().$disconnect(); });

describe("public legal and support surfaces", () => {
  it("renders polished public Privacy, Terms, and Support content with discoverable navigation", () => {
    const privacy = renderToStaticMarkup(createElement(PrivacyPage));
    const terms = renderToStaticMarkup(createElement(TermsPage));
    const support = renderToStaticMarkup(createElement(SupportPage));
    const links = renderToStaticMarkup(createElement(LegalLinks));
    expect(privacy).toContain("Account and profile information");
    expect(privacy).toContain("AI processing");
    expect(privacy).toContain("Kim WooJin");
    expect(privacy).toContain("Republic of Korea");
    expect(privacy).toContain("OpenAI");
    expect(privacy).toContain("DigitalOcean");
    expect(privacy).toContain("AI-generated output may be incomplete or inaccurate");
    expect(terms).toContain("Acceptable use");
    expect(terms).toContain("Academic integrity");
    expect(terms).toContain("AI-generated responses may be incomplete, outdated, or inaccurate");
    expect(support).toContain("Contact support");
    expect(support).toContain("kth.daniel0525@gmail.com");
    expect(support).toContain("mailto:kth.daniel0525@gmail.com");
    for (const markup of [privacy, terms, support]) {
      expect(markup).not.toContain("external legal review");
      expect(markup).not.toContain("engineering summary");
      expect(markup).not.toContain("RC approval blocker");
    }
    expect(LEGAL_CONTENT_REVIEW_STATUS).toBe("EXTERNAL_LEGAL_REVIEW_REQUIRED");
    for (const href of ["/privacy", "/terms", "/support"]) expect(links).toContain(`href="${href}"`);
  });

  it("fails closed when the optional support destination is not configured", () => {
    vi.stubEnv("SUPPORT_CONTACT_LABEL", "");
    vi.stubEnv("SUPPORT_CONTACT_URL", "");
    expect(publicSupportContact()).toEqual({ available: false, reason: "not-configured" });
    const support = renderToStaticMarkup(createElement(SupportPage));
    expect(support).toContain("kth.daniel0525@gmail.com");
    expect(support).not.toContain("Additional support resource");
  });

  it("rejects unsafe optional support URLs and publishes a complete HTTPS configuration", () => {
    vi.stubEnv("SUPPORT_CONTACT_LABEL", "Approved help center");
    vi.stubEnv("SUPPORT_CONTACT_URL", "javascript:alert(1)");
    expect(publicSupportContact()).toEqual({ available: false, reason: "invalid-configuration" });
    const invalid = renderToStaticMarkup(createElement(SupportPage));
    expect(invalid).toContain("kth.daniel0525@gmail.com");
    expect(invalid).not.toContain("javascript:");
    expect(invalid).not.toContain("Additional support resource");
    vi.stubEnv("SUPPORT_CONTACT_URL", "https://support.example.test/student-agency");
    expect(publicSupportContact()).toEqual({
      available: true,
      label: "Approved help center",
      url: "https://support.example.test/student-agency",
    });
    const configured = renderToStaticMarkup(createElement(SupportPage));
    expect(configured).toContain("kth.daniel0525@gmail.com");
    expect(configured).toContain("Approved help center");
    expect(configured).toContain("https://support.example.test/student-agency");
  });
});

describe.sequential("owned privacy controls", () => {
  let owner: Actor, other: Actor;
  beforeAll(async () => { owner = await actor(); other = await actor(); });

  it("lists, archives, and deletes only the authenticated user's memory", async () => {
    const memory = await db().userMemory.create({ data: { userId: owner.id, category: "USER_DEFINED", key: "review-style", value: "diagrams" } });
    expect((await listMemories(request("/api/student/memories", "GET", owner.headers))).status).toBe(200);
    expect(await (await listMemories(request("/api/student/memories", "GET", other.headers))).json()).toEqual([]);
    const context = { params: Promise.resolve({ id: memory.id }) };
    expect((await archiveMemory(request(`/api/student/memories/${memory.id}`, "PATCH", other.headers, { action: "archive" }), context)).status).toBe(404);
    const archived = await archiveMemory(request(`/api/student/memories/${memory.id}`, "PATCH", owner.headers, { action: "archive" }), context);
    expect(archived.status).toBe(200);
    expect((await archived.json()).status).toBe("archived");
    expect((await deleteMemory(request(`/api/student/memories/${memory.id}`, "DELETE", other.headers), context)).status).toBe(404);
    expect((await deleteMemory(request(`/api/student/memories/${memory.id}`, "DELETE", owner.headers), context)).status).toBe(200);
    expect(await db().userMemory.findUnique({ where: { id: memory.id } })).toBeNull();
  });

  it("deletes only owned conversations and rejects anonymous or cross-origin mutations", async () => {
    const conversation = await createConversation({ title: "Owned conversation" }, owner.headers);
    const context = { params: Promise.resolve({ id: conversation.id }) };
    expect((await deleteConversation(request(`/api/student/assistant/conversations/${conversation.id}`, "DELETE", other.headers), context)).status).toBe(404);
    expect((await deleteConversation(request(`/api/student/assistant/conversations/${conversation.id}`, "DELETE"), context)).status).toBe(403);
    const crossOrigin = new Headers(owner.headers); crossOrigin.set("origin", "https://attacker.example");
    expect((await deleteConversation(request(`/api/student/assistant/conversations/${conversation.id}`, "DELETE", crossOrigin), context)).status).toBe(403);
    expect((await deleteConversation(request(`/api/student/assistant/conversations/${conversation.id}`, "DELETE", owner.headers), context)).status).toBe(200);
    expect(await db().conversation.findUnique({ where: { id: conversation.id } })).toBeNull();
  });
});
