import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/features/legal/legal-page";
import { LEGAL_CONTENT_REVIEW_STATUS } from "@/lib/legal/status";
import { publicSupportContact } from "@/server/legal/support";

const SUPPORT_EMAIL = "kth.daniel0525@gmail.com";

export const metadata: Metadata = { title: "Support | Whale Student Agent" };
export const dynamic = "force-dynamic";

export default function SupportPage() {
  void LEGAL_CONTENT_REVIEW_STATUS;
  const contact = publicSupportContact();
  return (
    <LegalPage
      eyebrow="Support"
      title="Whale Student Agent support"
      summary="Get help with your account, data controls, product problems, or AI output. Do not include passwords, payment details, API keys, or sensitive documents in a support message."
    >
      <section className="panel"><h2>Contact support</h2><p>Email <a className="font-medium text-primary underline underline-offset-4" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Whale Student Agent is operated by Kim WooJin in the Republic of Korea.</p><p className="mt-3">Include a short description of the problem, the page or feature involved, and any non-sensitive steps that reproduce it. Do not send your password, session cookie, provider credentials, payment details, or private document contents.</p></section>
      <section className="panel"><h2>Account and access</h2><p>Contact support if you cannot sign in, cannot reach your account controls, believe someone else accessed your account, or need help with a pending account-deletion request.</p></section>
      <section className="panel"><h2>Bug or incorrect AI output</h2><p>Signed-in users can use Feedback &amp; privacy for product bugs and AI-quality reports. Individual AI responses also provide a feedback control. AI output may be inaccurate, so verify important academic work, deadlines, course requirements, citations, and answers.</p><Link className="mt-3 inline-block font-medium text-primary underline underline-offset-4" href="/student/feedback">Open Feedback &amp; privacy</Link></section>
      <section className="panel"><h2>Privacy and data controls</h2><p>Use Settings and the relevant workspace pages to manage saved memory, conversations, uploaded documents, product analytics preferences, and account deletion. Email support if you cannot access those controls or have a privacy question.</p></section>
      <section className="panel"><h2>Billing</h2><p>Billing is disabled in the current hosted staging environment. Do not send payment details by email. If billing is introduced later, the service must provide updated billing information and a supported account path.</p></section>
      {contact.available && <section className="panel"><h2>Additional support resource</h2><p>An additional approved help destination is available below.</p><a className="mt-3 inline-block font-medium text-primary underline underline-offset-4" href={contact.url}>{contact.label}</a></section>}
    </LegalPage>
  );
}
