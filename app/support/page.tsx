import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/features/legal/legal-page";
import { publicSupportContact } from "@/server/legal/support";

export const metadata: Metadata = { title: "Support" };
export const dynamic = "force-dynamic";

export default function SupportPage() {
  const contact = publicSupportContact();
  return (
    <LegalPage
      eyebrow="Support"
      title="Get help with Student Agency"
      summary="Choose the category that best matches the problem. Do not include passwords, payment details, API keys, or sensitive documents in a support message."
    >
      <section className="panel"><h2>Account and access</h2><p>Use this category for sign-in, session, invitation, or account-access problems.</p></section>
      <section className="panel"><h2>Bug or incorrect AI output</h2><p>Signed-in beta users can use Feedback &amp; privacy for product bugs and AI-quality reports. Individual AI responses also provide a feedback control.</p><Link className="mt-3 inline-block font-medium text-primary underline underline-offset-4" href="/student/feedback">Open Feedback &amp; privacy</Link></section>
      <section className="panel"><h2>Privacy and data deletion</h2><p>Use Settings for document, memory, conversation, and account controls. Use the configured support contact when access to those controls is unavailable.</p></section>
      <section className="panel"><h2>Billing</h2><p>Billing is disabled in the current staging environment. A reviewed billing-support process is required before billing can be enabled.</p></section>
      <section className="panel" aria-live="polite"><h2>Support contact</h2>{contact.available ? <><p>The approved support destination for this environment is available below.</p><a className="mt-3 inline-block font-medium text-primary underline underline-offset-4" href={contact.url}>{contact.label}</a></> : <><p>No public support contact has been configured for this environment. Signed-in beta users can use Feedback &amp; privacy; account-access and external privacy requests remain an RC approval blocker.</p><p className="mt-3 text-sm">Operators must set both <code>SUPPORT_CONTACT_LABEL</code> and an approved HTTPS <code>SUPPORT_CONTACT_URL</code>.</p></>}</section>
    </LegalPage>
  );
}
