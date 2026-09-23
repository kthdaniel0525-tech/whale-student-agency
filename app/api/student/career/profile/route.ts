import { z } from "zod";
import { api, readJson } from "@/server/api";
import { CareerDataService } from "@/server/career/service";
import { careerProfileSchema } from "@/server/career/schemas";
import { refreshRecommendationsBestEffort } from "@/server/recommendations";
import { archiveMemory, listMemories, saveExplicitMemory } from "@/server/memory";

const service = new CareerDataService();
const inputSchema = careerProfileSchema.extend({
  targetCompanies: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  applicationTimeline: z.string().trim().min(1).max(100).nullable().default(null),
}).strict();

export function GET(request: Request) {
  return api(request, () => service.getProfile(request.headers));
}

export function PUT(request: Request) {
  return api(request, async (userId) => {
    const input = await readJson(request, inputSchema);
    const { targetCompanies, applicationTimeline, ...profileInput } = input;
    const profile = await service.saveProfile(profileInput, request.headers);
    const current = await listMemories({ category: "career-goal", status: "active" }, request.headers);
    const memoryValues: Array<["targetRole" | "targetIndustry" | "targetCompanies" | "internshipTimeline", string | string[] | null]> = [
      ["targetRole", profileInput.targetRoles[0] ?? null],
      ["targetIndustry", profileInput.targetIndustries[0] ?? null],
      ["targetCompanies", targetCompanies.length ? targetCompanies : null],
      ["internshipTimeline", applicationTimeline],
    ];
    for (const [key, value] of memoryValues) {
      const existing = current.find((item) => item.key === key);
      if (value) await saveExplicitMemory({ category: "career-goal", key, value, source: "Career Workspace profile" }, request.headers, { embeddingProvider: null });
      else if (existing) await archiveMemory(existing.id, request.headers);
    }
    await refreshRecommendationsBestEffort(userId);
    return profile;
  });
}
