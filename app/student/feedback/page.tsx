import { requirePageUser } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { analyticsConfig } from "@/server/product-analytics/config";
import { ProductFeedbackForm } from "@/features/student/analytics/feedback-form";
export default async function FeedbackPage() {
  const { user } = await requirePageUser();
  const state = await db().productAnalyticsState.findUnique({ where: { userId: user.id } });
  return <><div className="page-heading"><div><p className="eyebrow">HELP SHAPE STUDENT AGENCY</p><h1>Feedback &amp; privacy</h1><p>Your feedback helps us improve the beta.</p></div></div><ProductFeedbackForm optedOut={state?.optedOut ?? false} analyticsEnabled={analyticsConfig().enabled} /></>;
}
