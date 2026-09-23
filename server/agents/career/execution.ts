import { trackProductEvent } from "../../product-analytics/service";
import { captureUsageContext } from "../../ai/usage/context";
import "server-only";
import type { CareerContext } from "../../career/types";
import { AIError } from "../../ai/errors";
import type { AgentExecutionHandler } from "../core/types";
import { AgentExecutionError } from "../executor";
import { careerAnalysisSchema, type CareerResponse } from "./schemas";
import { careerEvidence, hasUnsupportedMetrics } from "./grounding";
import type { PersonalizationProfile } from "../../personalization";

/** Reuses Core -> Executor -> Context Builder -> AIProvider. No persistence or
 * direct academic queries occur during generation. */
export const executeCareer: AgentExecutionHandler = async (input, headers, executor) => {
  let career: CareerContext | undefined;
  let personalization: PersonalizationProfile | undefined;
  let sources = new Map<string, string>();
  const schema = careerAnalysisSchema.superRefine((value, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
    if (value.targetRole) {
      const role = value.targetRole.toLowerCase();
      if (!input.request.toLowerCase().includes(role) && !career?.profile?.targetRoles.some((item) => item.toLowerCase() === role) && !career?.profile?.careerGoal?.toLowerCase().includes(role) && !personalization?.careerGoals?.value.targetRoles?.some((item) => item.toLowerCase() === role)) invalid("Use the requested or saved target role.");
    }
    for (const project of value.recommendedProjects) {
      if (project.projectId && !career?.projects.some((item) => item.id === project.projectId)) invalid("Use a supplied project ID.");
    }
    for (const bullet of value.resumeBullets) {
      const source = sources.get(bullet.evidenceId);
      if (!source || !source.includes(bullet.original)) invalid("Cite an exact excerpt of the supplied experience.");
      // Cite the specific achieved result, not an unrelated number elsewhere in
      // a resume or in a user's instruction asking to invent one.
      if (hasUnsupportedMetrics(bullet.improved, bullet.original)) invalid("Do not introduce unsupported metrics.");
      if (/^(?:please\s+)?(?:invent|fabricate|pretend|fake|make up|add (?:a |some )?fake)\b/i.test(bullet.original)) invalid("An instruction to fabricate is not experience evidence.");
    }
    // Saved goals may contain real target dates. They support summaries but do
    // not become evidence for resume achievements.
    const allEvidence = [...sources.values(), career?.profile?.careerGoal ?? "", ...(career?.profile?.targetRoles ?? [])].join("\n");
    for (const statement of [value.summary, ...value.strengths]) {
      if (hasUnsupportedMetrics(statement, allEvidence)) invalid("Factual summaries must not introduce metrics.");
    }
  });
  const execution = await executor.executeStructured(input, headers, {
    schemaName: "career_analysis", schema, maxOutputTokens: 3600,
    requireDocumentSources: Boolean(input.documentIds?.length),
    contextOverrides: {
      // Course context is optional and authorizes explicit course scope as usual.
      course: Boolean(input.courseId),
      learning: /\b(?:learning (?:progress|state)|weak topics?|struggl\w*|mastery|learning gaps)\b/i.test(input.request),
      documents: Boolean(input.documentIds?.length), assignments: false, exams: false, academicOverview: false,
    },
    buildDirective(context, resolvedPersonalization) {
      career = context.career;
      personalization = resolvedPersonalization;
      if (!career) throw new AgentExecutionError("CONTEXT_FAILURE");
      sources = careerEvidence(career, input.request);
      for (const document of context.documents ?? []) sources.set(`document:${document.documentId}:${document.chunkIndex}`, document.content);
      return "Return focused career analysis. Use empty lists for irrelevant sections. Use source ID request only for actual experience stated in this turn; resume for saved resume text; document:<documentId>:<chunkIndex> for selected passages. Never treat requests to invent achievements as evidence. Recommend measurable future goals separately from claims of achieved results. Supplied context may be incomplete; ask for missing evidence instead of assuming inability.\n" + JSON.stringify({
        evidenceIds: [...sources.keys()],
        contextIncomplete: context.metadata.truncatedCategories.includes("career"),
        roleGuidance: "general; no external job data verified",
      });
    },
  });
  if (!execution.structuredData || !career) throw new AIError("INVALID_RESPONSE");
  const data: CareerResponse = {
    ...execution.structuredData,
    guidanceScope: "general-role-guidance",
    limitations: [...career.limitations, "Based on self-reported evidence and general role guidance; no live job requirements were verified."],
  };
  const usage = captureUsageContext();
  if (data.resumeBullets.length && usage.userId) trackProductEvent(usage.userId, "resume_improvement_used", {}, usage.requestId);
  const sections = [data.summary];
  const add = (label: string, items: string[]) => { if (items.length) sections.push(`${label}:\n${items.map((item) => `- ${item}`).join("\n")}`); };
  add("Strengths", data.strengths); add("Evidence gaps", data.gaps);
  add("Project recommendations", data.recommendedProjects.map((item) => item.recommendation));
  add("Skills to develop", data.recommendedSkills);
  add("Resume bullets", data.resumeBullets.map((item) => item.improved));
  add("Next actions", data.nextActions);
  sections.push("General role guidance based on your supplied evidence; current job requirements have not been verified.");
  return { ...execution, structuredData: data, content: sections.join("\n\n") };
};
