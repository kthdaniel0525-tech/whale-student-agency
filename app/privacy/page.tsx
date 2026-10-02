import type { Metadata } from "next";
import { LegalPage } from "@/features/legal/legal-page";
import { LEGAL_CONTENT_REVIEW_STATUS } from "@/lib/legal/status";

export const metadata: Metadata = { title: "Privacy" };
export const dynamic = "force-dynamic";

export default function PrivacyPage() {
  void LEGAL_CONTENT_REVIEW_STATUS;
  return (
    <LegalPage
      eyebrow="Privacy · engineering summary"
      title="How Student Agency handles data"
      summary="This page describes the product behavior implemented today. Final policy wording still requires external legal review."
    >
      <section className="panel"><h2>Information the service processes</h2><p>Student Agency stores account and profile details needed to sign you in, personalize the workspace, and protect access to your data. Authentication secrets and session credentials remain server-side.</p></section>
      <section className="panel"><h2>Academic data</h2><p>Courses, assignments, exams, quiz activity, learning progress, study plans, workflows, reminders, and notifications are stored for your account so the product can organize and personalize study support.</p></section>
      <section className="panel"><h2>Uploaded documents</h2><p>Uploaded PDF, text, and Markdown files are kept in private application storage. Extracted pages, passages, and local vector embeddings are stored with your owned document records for retrieval. Deleting a document removes it from normal retrieval and queues its stored file for deletion.</p></section>
      <section className="panel"><h2>AI processing</h2><p>Your request and bounded task-relevant context may be sent to the configured OpenAI service. Context can include selected academic data, relevant document passages, conversation history or summaries, and relevant saved memory. Passwords, session cookies, API keys, OAuth tokens, database credentials, and billing records are excluded from AI context. Provider requests use the implemented <code>store: false</code> setting; this page does not make claims about provider contracts or all provider-side logs.</p></section>
      <section className="panel"><h2>Personalization and memory</h2><p>The service can store explicit preferences and supported learning or product-use observations. Settings lets you inspect, archive, and delete saved long-term memory. Archived memory is excluded from active retrieval but remains stored until it is deleted.</p></section>
      <section className="panel"><h2>Usage and operational data</h2><p>The application records bounded usage, cost, latency, reliability, and job metadata without intentionally storing full prompts or uploaded document contents in those records. Optional product analytics is disabled in the current staging environment and has a user opt-out control when configured.</p></section>
      <section className="panel"><h2>Third-party services currently enabled</h2><ul><li>DigitalOcean hosts the staging application, database, and private storage.</li><li>OpenAI processes bounded AI requests.</li><li>GitHub and GHCR store source automation and immutable application images; they are not part of the runtime user-request path.</li></ul><p className="mt-3">Google integrations, Stripe billing, Sentry delivery, and external product analytics are disabled in the current staging configuration.</p></section>
      <section className="panel"><h2>Data controls</h2><p>Settings provides controls for product analytics, long-term memory, conversation deletion, and account deletion. The Documents area provides document deletion. Integration disconnect controls appear only when an integration is enabled and connected.</p></section>
      <section className="panel"><h2>Account deletion</h2><p>Account deletion requires your current password and the explicit confirmation word. It immediately disables access and schedules removal of owned local product data and private document files. Independent provider records, infrastructure logs, and backup copies follow their separate provider or operator processes.</p></section>
      <section className="panel"><h2>Security overview</h2><p>The application derives identity from the authenticated server session, checks resource ownership, stores provider keys only on the server, keeps document storage private, and filters structured operational logging. These are implementation facts, not a legal or compliance certification.</p></section>
      <section className="panel"><h2>Contact and support</h2><p>Use the Support page for the configured support path and the authenticated Feedback &amp; privacy page for product, AI-quality, or privacy feedback. A final accountable support contact must be supplied before Release Candidate approval.</p></section>
    </LegalPage>
  );
}
