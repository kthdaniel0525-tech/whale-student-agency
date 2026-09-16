import { describe, expect, it } from "vitest";
import { hasUnsupportedMetrics } from "@/server/agents/career/grounding";
import { careerAnalysisSchema } from "@/server/agents/career/schemas";
import { CAREER_INSTRUCTIONS } from "@/server/agents/career/instructions";

describe("Career quantity grounding", () => {
  it.each([
    ["Built a React website.", "I made a React website."],
    ["Served 120 members.", "The site served 120 members."],
    ["Reduced build time by 30%.", "Measured build time decreased by 30%."],
    ["Built two dashboards.", "I built two dashboards."],
    ["Used React 18.", "A project using React 18."],
    ["Handled 1,200 requests.", "Handled 1,200 requests in the test."],
    ["사용자 100명에게 제공.", "사용자 100명에게 제공했습니다."],
  ])("accepts quantities grounded in the cited excerpt: %s", (output, source) => {
    expect(hasUnsupportedMetrics(output, source)).toBe(false);
  });
  it.each([
    ["Increased membership by 40%.", "Built a club website."],
    ["Served 120 members.", "Served 1200 members."],
    ["Built two dashboards.", "Built a dashboard."],
    ["Doubled engagement.", "Built a website."],
    ["Tripled conversion.", "Created a landing page."],
    ["Saved 18 hours.", "Used React 18."],
    ["Served 100 users.", "Processed 100 documents."],
    ["Reduced costs by 5%.", "Reduced costs by 50%."],
    ["Reached 50% conversion.", "Reached 50 users."],
    ["Reached 100k users.", "Built a website."],
    ["회원 100명 확보.", "동아리 웹사이트 개발."],
    ["Improved performance tenfold.", "Developed a project."],
  ])("rejects new quantities or transferred units: %s", (output, source) => {
    expect(hasUnsupportedMetrics(output, source)).toBe(true);
  });
  it("requires bounded structured sections and an actionable next step", () => {
    expect(careerAnalysisSchema.safeParse({ summary: "Advice" }).success).toBe(false);
    expect(careerAnalysisSchema.safeParse({ targetRole: null, summary: "Advice", strengths: [], gaps: [], recommendedProjects: [], recommendedSkills: [], resumeBullets: [], nextActions: [] }).success).toBe(false);
  });
  it("keeps instructions concise and covers evidence, role scope and constructive learning", () => {
    expect(CAREER_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
    for (const requirement of ["Never invent metrics", "self-reported", "Course enrollment alone", "Missing evidence is not inability", "general guidance", "without raw scores", "Do not save goals automatically"]) expect(CAREER_INSTRUCTIONS).toContain(requirement);
  });
});
