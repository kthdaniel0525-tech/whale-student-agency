import { z } from "zod";
import { PROFILE_IDS, type ProfileId, type Dimension } from "./types";
export type QualityProfile = { version: string; minimum: number; allowedDrop: number; minimumSamples: number; semantic: Dimension[]; rubric: string };
const profile = (semantic: Dimension[], rubric: string, minimum = .8, allowedDrop = .05, minimumSamples = 5): QualityProfile => ({ version: "quality-v1", minimum, allowedDrop, minimumSamples, semantic, rubric });
export const QUALITY_PROFILES: Record<ProfileId, QualityProfile> = {
  tutor: profile(["correctness", "relevance", "clarity", "personalization", "sourceFaithfulness"], "Check conceptual correctness, requested depth and current preferences. Source claims must follow supplied passages. Length alone is not quality."),
  notes: profile(["completeness", "groundedness", "clarity", "sourceFaithfulness"], "Compare notes with source concepts and terminology; identify omissions, distortion and invented claims. Reward faithful compression, not copying or length."),
  quiz: profile(["correctness", "relevance", "clarity", "groundedness"], "Check correct answers, ambiguity, plausible distractors, diversity, topic relevance, and requested/adaptive difficulty. Difficulty is a coarse aggregate, not calibrated by one question."),
  grading: profile(["gradingReliability", "correctness"], "Compare the grade with curated reference answer and allowed score interval. Do not reward agreement with an incorrect generated answer key.", .95, .02),
  "study-planner": profile(["actionability", "planningQuality"], "Check coherence and practical prioritization using deadlines, mastery, confidence, diagnostic needs, maintenance, and available time. Deterministic constraints remain binding.", .99, .01),
  "academic-manager": profile(["correctness", "actionability", "relevance"], "Prioritize actual urgent/high impact work, interpret readiness and confidence cautiously, and avoid unnecessary specialist recommendations."),
  career: profile(["correctness", "actionability", "relevance"], "Check evidence-backed skill gaps and concrete role-relevant actions. Reject fabricated achievements/metrics. Treat unverified labor-market claims as unsupported, not factual."),
  dispatcher: profile([], "Match agent versus workflow and acceptable target IDs; allow multiple legitimate labels and clarification.", .95, .02),
  "model-router": profile([], "Required quality tiers are hard floors. Compare output quality separately from price and latency; never infer quality from a tier alone.", 1, 0),
  "rag-retrieval": profile([], "Measure recall@k, hit@k and precision against curated chunk labels separately from answer quality.", .9, .05),
  "rag-generation": profile(["groundedness", "sourceFaithfulness", "correctness"], "Judge each source-attributed claim against actual retrieved passages. Citation presence or word overlap is not evidence of semantic faithfulness.", .9, .03),
  workflow: profile(["actionability", "completeness"], "Assess final user value and useful preserved artifacts, not just completion status or mastery increase. Respect confidence, loop limits and optional-step warnings."),
  continuity: profile(["correctness", "relevance"], "Preserve corrections, resolve references, keep course scope separate and prefer current instructions to obsolete summary claims."),
  personalization: profile(["personalization"], "Explicit current requests override stored preferences; low-confidence inferred memories must not become hard requirements."),
  adaptive: profile(["personalization", "actionability"], "Check strategy changes after failures, appropriate quiz difficulty and realistic replanning. Inspect behavior evidence as well as final wording."),
};
const override = z.record(z.enum(PROFILE_IDS), z.object({ minimum: z.number().min(0).max(1).optional(), allowedDrop: z.number().min(0).max(.3).optional(), minimumSamples: z.number().int().min(2).max(1000).optional() }).strict());
export function qualityProfile(id: ProfileId): QualityProfile {
  const changes = override.parse(process.env.AI_EVAL_THRESHOLDS_JSON ? JSON.parse(process.env.AI_EVAL_THRESHOLDS_JSON) : {});
  return { ...QUALITY_PROFILES[id], ...changes[id] };
}
