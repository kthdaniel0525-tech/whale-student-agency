# Privacy, Terms, and Support — human review boundary

The repository now provides factual engineering-summary pages at `/privacy`, `/terms`, and `/support`. They are not final legal approval and do not claim legal compliance.

Before Release Candidate approval, an authorized human/legal reviewer must provide or approve:

1. Final Privacy Policy wording for the actual processors, deployment and backup regions, provider terms, user rights, and approved retention periods.
2. Final Terms wording, including eligibility, jurisdiction-specific requirements, acceptable use, academic integrity, availability, suspension/deletion, and any required warranty/liability/consumer language.
3. A named accountable support/security/privacy owner and an approved public HTTPS support destination.
4. Billing terms, cancellation information, and billing support before billing is enabled.
5. The operational process for requests involving external-provider records, infrastructure logs, and backup copies.

Configure the public support destination with both server-side values:

- `SUPPORT_CONTACT_LABEL`
- `SUPPORT_CONTACT_URL` — an approved public HTTPS form or help destination

If either value is missing or invalid, `/support` renders a closed, non-fake unavailable-contact state and keeps authenticated beta feedback available. The placeholder values in environment templates are comments and must not be published as a real destination.

Source marker: `LEGAL_CONTENT_REVIEW_STATUS = "EXTERNAL_LEGAL_REVIEW_REQUIRED"`.
