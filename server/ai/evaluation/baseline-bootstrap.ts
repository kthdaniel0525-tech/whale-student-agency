import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assessBaselineEligibility, CORE_RELEASE_PROFILES } from "./release-gate";
import { reportSchema, type EvalReport } from "./runner";
import { PROFILE_IDS, type ProfileId } from "./types";

const immutableImage = z.string().regex(
  /^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[0-9a-f]{64}$/,
);

export const baselineReviewSchema = z.object({
  version: z.literal(1),
  reviewStatus: z.literal("reviewed"),
  reviewedAt: z.string().datetime({ offset: true }),
  reviewer: z.string().trim().min(1).max(200),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  immutableImage,
  environment: z.literal("staging"),
}).strict();

const profileSummarySchema = z.object({
  profile: z.enum(PROFILE_IDS),
  evaluationType: z.enum(["model-based", "deterministic"]),
  sampleCount: z.number().int().positive(),
  minimumSamples: z.number().int().positive(),
  averageScore: z.number().min(0).max(1),
}).strict();

export const baselineProvenanceSchema = z.object({
  version: z.literal(1),
  kind: z.literal("first-release-baseline"),
  baselineStatus: z.literal("BASELINE_ESTABLISHED"),
  comparisonStatus: z.literal("NOT_PERFORMED_FIRST_RELEASE"),
  reviewStatus: z.literal("reviewed"),
  reviewedAt: z.string().datetime({ offset: true }),
  reviewer: z.string().trim().min(1).max(200),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  immutableImage,
  environment: z.literal("staging"),
  reportCreatedAt: z.string(),
  reportSha256: z.string().regex(/^[0-9a-f]{64}$/),
  datasetVersions: z.array(z.string().min(1)).min(1),
  evaluatorVersions: z.array(z.string().min(1)).min(1),
  judgeModels: z.array(z.string().min(1)).min(1),
  generatorModels: z.array(z.string().min(1)).min(1),
  providers: z.array(z.string().min(1)).min(1),
  profiles: z.array(profileSummarySchema).min(1),
}).strict();

export type BaselineReview = z.infer<typeof baselineReviewSchema>;
export type BaselineProvenance = z.infer<typeof baselineProvenanceSchema>;

const unique = (values: string[]) => [...new Set(values)].sort();

export function serializeBaselineReport(rawReport: EvalReport) {
  const report = reportSchema.parse(rawReport);
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function createFirstReleaseBaseline(
  rawReport: EvalReport,
  rawReview: BaselineReview,
  profiles: readonly ProfileId[] = CORE_RELEASE_PROFILES,
) {
  const report = reportSchema.parse(rawReport);
  const review = baselineReviewSchema.parse(rawReview);
  const assessment = assessBaselineEligibility(report, profiles);
  if (!assessment.eligible) {
    return { assessment, report: null, provenance: null } as const;
  }
  const serializedReport = serializeBaselineReport(report);
  const provenance = baselineProvenanceSchema.parse({
    version: 1,
    kind: "first-release-baseline",
    baselineStatus: "BASELINE_ESTABLISHED",
    comparisonStatus: "NOT_PERFORMED_FIRST_RELEASE",
    reviewStatus: review.reviewStatus,
    reviewedAt: review.reviewedAt,
    reviewer: review.reviewer,
    commitSha: review.commitSha,
    immutableImage: review.immutableImage,
    environment: review.environment,
    reportCreatedAt: report.createdAt,
    reportSha256: createHash("sha256").update(serializedReport).digest("hex"),
    datasetVersions: unique(report.rows.map((row) => row.datasetVersion)),
    evaluatorVersions: unique(report.rows.map((row) => row.result.evaluatorVersion)),
    judgeModels: unique(report.rows.flatMap((row) => row.judgeModel ? [row.judgeModel] : [])),
    generatorModels: unique(report.rows.flatMap((row) => row.model ? [row.model] : [])),
    providers: unique(report.rows.flatMap((row) => row.provider ? [row.provider] : [])),
    profiles: assessment.profiles.map((profile) => ({
      ...profile,
      averageScore: profile.averageScore as number,
    })),
  });
  return { assessment, report, provenance } as const;
}
