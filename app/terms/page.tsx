import type { Metadata } from "next";
import { LegalPage } from "@/features/legal/legal-page";
import { LEGAL_CONTENT_REVIEW_STATUS } from "@/lib/legal/status";

export const metadata: Metadata = { title: "Terms" };
export const dynamic = "force-dynamic";

export default function TermsPage() {
  void LEGAL_CONTENT_REVIEW_STATUS;
  return (
    <LegalPage
      eyebrow="Terms · product use summary"
      title="Using Student Agency"
      summary="This factual product-use summary is not final legal terms. External legal review is required before Release Candidate approval."
    >
      <section className="panel"><h2>Your account</h2><p>Use your own account and keep its credentials private. Access can be limited by closed-beta admission, plan entitlements, security controls, or an account deletion request.</p></section>
      <section className="panel"><h2>Acceptable use</h2><p>Use the service for lawful academic organization and learning activity. Do not attempt to access another person’s account or data, bypass product limits, interfere with the service, or submit credentials and other secrets as study content.</p></section>
      <section className="panel"><h2>AI-generated output</h2><p>AI-generated responses can be inaccurate. Verify important academic work, course requirements, deadlines, citations, and answers before relying on them.</p></section>
      <section className="panel"><h2>Academic integrity</h2><p>You remain responsible for following your institution’s academic-integrity rules and for deciding whether AI assistance is permitted for a specific course or assignment.</p></section>
      <section className="panel"><h2>Service availability</h2><p>Features, availability, limits, and supported integrations can change during the beta. The product may pause an operation when required context, authorization, provider access, or service capacity is unavailable.</p></section>
      <section className="panel"><h2>Account and data controls</h2><p>Settings provides supported controls for saved memory, conversations, product analytics, and account deletion. The Documents area provides document deletion. Account deletion is destructive and disables access before background cleanup completes.</p></section>
      <section className="panel"><h2>Billing</h2><p>Billing is disabled in the current staging configuration. Billing terms, cancellation information, and support must be reviewed before paid checkout is enabled.</p></section>
      <section className="panel"><h2>Final review boundary</h2><p>This page intentionally contains no invented age, governing-law, arbitration, warranty, liability, consumer-law, or jurisdiction-specific language. Those decisions require external legal review.</p></section>
    </LegalPage>
  );
}
