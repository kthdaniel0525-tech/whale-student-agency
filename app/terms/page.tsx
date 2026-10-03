import type { Metadata } from "next";
import { LegalPage } from "@/features/legal/legal-page";
import { LEGAL_CONTENT_REVIEW_STATUS } from "@/lib/legal/status";

export const metadata: Metadata = { title: "Terms | Whale Student Agent" };
export const dynamic = "force-dynamic";

export default function TermsPage() {
  void LEGAL_CONTENT_REVIEW_STATUS;
  return (
    <LegalPage
      eyebrow="Terms"
      title="Terms for Whale Student Agent"
      summary="These terms describe the rules and responsibilities that apply when you use Whale Student Agent and its study-support features."
    >
      <section className="panel"><h2>Service operator</h2><p>Whale Student Agent is operated by Kim WooJin in the Republic of Korea. Questions about these terms or the service can be sent to <a className="font-medium text-primary underline underline-offset-4" href="mailto:kth.daniel0525@gmail.com">kth.daniel0525@gmail.com</a>.</p></section>
      <section className="panel"><h2>Your account</h2><p>Use your own account, provide accurate account information, and keep your password and session access private. You are responsible for activity performed through your account. Access may be limited by beta admission, available plan features, security controls, or a pending account-deletion request.</p></section>
      <section className="panel"><h2>Acceptable use</h2><p>Use the service for lawful study, academic organization, and learning activities. Do not try to access another person&apos;s account or data, bypass access or usage controls, disrupt the service, upload malicious material, misuse automated requests, or include passwords, API keys, payment details, or other secrets in study content. Upload only content you are permitted to use.</p></section>
      <section className="panel"><h2>AI limitations</h2><p>AI-generated responses may be incomplete, outdated, or inaccurate. Whale Student Agent does not guarantee that an explanation, answer, citation, plan, quiz, grade, or recommendation is correct. Verify important academic work, deadlines, course requirements, citations, and answers against course materials and official sources before relying on them.</p></section>
      <section className="panel"><h2>Academic integrity</h2><p>You are responsible for following the academic-integrity, collaboration, and AI-use rules of your school, instructor, course, and assignment. Use the service as study support and submit work only when you are allowed to do so.</p></section>
      <section className="panel"><h2>Your content and data</h2><p>The service processes information and files you provide to deliver the features you request. In-product controls let you manage documents, saved memory, conversations, academic records, and your account as described on the Privacy page. Deleting source material does not automatically withdraw work already submitted elsewhere.</p></section>
      <section className="panel"><h2>Service availability and changes</h2><p>Whale Student Agent is currently operated as a developing hosted service. Features, limits, models, integrations, and availability may change. An operation may be paused or unavailable because required context, authorization, provider access, maintenance, security controls, or service capacity is unavailable. Material changes to these public terms should be reflected on this page.</p></section>
      <section className="panel"><h2>Account and data controls</h2><p>You can use Settings and the relevant workspace pages to update or delete supported data. Permanent account deletion requires password confirmation, disables access, and starts removal of owned application data. Contact support if you cannot reach the available controls.</p></section>
      <section className="panel"><h2>External features and billing</h2><p>Some integrations or paid features may exist in the codebase but are not available unless they are explicitly enabled. Google integrations and Stripe billing are disabled in the current hosted staging environment. Paid checkout must not be treated as available unless the service clearly presents it and the related terms have been updated.</p></section>
      <section className="panel"><h2>Support</h2><p>For account access, product problems, privacy requests, or questions about these terms, visit the Support page or email <a className="font-medium text-primary underline underline-offset-4" href="mailto:kth.daniel0525@gmail.com">kth.daniel0525@gmail.com</a>. Do not send passwords, payment details, API keys, or sensitive document contents in a support message.</p></section>
    </LegalPage>
  );
}
