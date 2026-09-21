import "server-only";
import { z } from "zod";
import { db } from "../../db/client";
const filterSchema = z.object({ userId: z.string().min(1).max(100), since: z.date(), until: z.date() }).strict().refine(v => v.until > v.since && v.until.getTime() - v.since.getTime() <= 366 * 86400000);
const average = (n: number[]) => n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
/** Owner-scoped operations data. Observational cohorts are not causal model comparisons.
 * No raw messages, feedback comments, or judge rationales leave this boundary. */
export async function getQualityAnalytics(input: z.infer<typeof filterSchema>) {
  const filter = filterSchema.parse(input), where = { userId: filter.userId, createdAt: { gte: filter.since, lt: filter.until } };
  const [records, count, feedback] = await Promise.all([
    db().aIEvaluationRecord.findMany({ where, take: 5000, orderBy: { createdAt: "desc" } }), db().aIEvaluationRecord.count({ where }),
    db().aIUserFeedback.groupBy({ by: ["rating", "reasonCode"], where, _count: true }),
  ]);
  const usageIds = [...new Set(records.flatMap(r => r.usageRecordId ? [r.usageRecordId] : []))];
  const usage = await db().aIUsageRecord.findMany({ where: { userId: filter.userId, id: { in: usageIds } }, select: { id: true, latencyMs: true, estimatedCostUsd: true } });
  const usageMap = new Map(usage.map(r => [r.id, r]));
  const groups = new Map<string, typeof records>();
  for (const r of records) { const key = JSON.stringify([r.profile, r.evaluationType, r.evaluatorVersion, r.datasetVersion, r.promptVersion, r.routingVersion, r.contextVersion, r.model, r.provider, r.selectedTier, r.fallbackUsed, r.judgeModel]); groups.set(key, [...(groups.get(key) ?? []), r]); }
  const cohorts = [...groups.values()].map(rows => {
    const r = rows[0], attempts = [...new Set(rows.flatMap(r => r.usageRecordId ? [r.usageRecordId] : []))].flatMap(id => usageMap.has(id) ? [usageMap.get(id)!] : []);
    const measured = rows.filter(r => r.score !== null), outcomes = rows.filter(r => r.passed !== null);
    const dimensions: Record<string, number[]> = {}, failures: Record<string, number> = {};
    for (const row of rows) { for (const [d, score] of Object.entries(row.dimensions as Record<string, number>)) (dimensions[d] ??= []).push(score); for (const f of row.failures) failures[f] = (failures[f] ?? 0) + 1; }
    return { profile: r.profile, type: r.evaluationType, evaluatorVersion: r.evaluatorVersion, datasetVersion: r.datasetVersion, promptVersion: r.promptVersion, routingVersion: r.routingVersion, contextVersion: r.contextVersion, model: r.model, provider: r.provider, tier: r.selectedTier, fallbackUsed: r.fallbackUsed, judgeModel: r.judgeModel,
      samples: rows.length, measuredSamples: measured.length, meanScore: average(measured.map(r => r.score!)), passRate: average(outcomes.map(r => Number(r.passed))), dimensions: Object.fromEntries(Object.entries(dimensions).map(([d, scores]) => [d, { score: average(scores), samples: scores.length }])), failures,
      unmeasured: [...new Set(rows.flatMap(r => r.unmeasured))], linkedAttempts: attempts.length, unknownCosts: attempts.filter(r => r.estimatedCostUsd === null).length,
      meanCostUsd: average(attempts.flatMap(r => r.estimatedCostUsd === null ? [] : [Number(r.estimatedCostUsd)])), meanLatencyMs: average(attempts.map(r => r.latencyMs)) };
  });
  // Preserve disagreement between satisfaction and automation rather than changing either label.
  const negative = await db().aIUserFeedback.findMany({ where: { ...where, rating: -1 }, select: { messageId: true }, take: 5000 });
  const negativeIds = new Set(negative.map(r => r.messageId));
  return { cohorts, totalRecords: count, truncated: count > records.length, feedback: feedback.map(f => ({ rating: f.rating, reasonCode: f.reasonCode, count: f._count })), positiveEvaluationWithNegativeFeedback: new Set(records.filter(r => r.evaluationType !== "user-feedback" && r.passed === true && r.messageId && negativeIds.has(r.messageId)).map(r => r.messageId)).size,
    comparisonWarning: "Sampled observational cohorts; use paired synthetic reports for model/fallback regression decisions." };
}
