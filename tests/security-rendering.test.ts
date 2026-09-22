import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMessageView } from "@/features/student/assistant/message-renderer";
import { careerProfileSchema, projectSchema } from "@/server/career/schemas";
import { chatGPTSignInPath } from "@/app/chatgpt-auth";

describe("untrusted text and navigation", () => {
  it.each(["user", "assistant"] as const)("renders %s HTML/Markdown as inert text", role => {
    const payload = '<script>alert("private")</script><img src=x onerror=alert(1)>[link](javascript:alert(1))';
    const html = renderToStaticMarkup(createElement(AssistantMessageView, { message: { id: "fixture", turnId: null, role, content: payload, agentId: "tutor", createdAt: new Date(0).toISOString(), metadata: null } }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('href="javascript:');
  });
  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "//evil.example", "file:///etc/passwd"])("rejects unsafe displayed project/profile URL %s", link => {
    expect(projectSchema.safeParse({ name: "Test", description: "Test", link }).success).toBe(false);
    expect(careerProfileSchema.safeParse({ portfolioLinks: [link] }).success).toBe(false);
  });
  it.each(["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)"])("legacy return path cannot become an external redirect: %s", returnTo => {
    expect(chatGPTSignInPath(returnTo)).toBe("/signin-with-chatgpt?return_to=%2F");
  });
});
