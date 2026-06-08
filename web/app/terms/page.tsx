/* eslint-disable react/no-unescaped-entities */
import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms governing kolm.ai agent-security audits, signed evidence reports, acceptable use, fees, liability, and data handling. Contact: dev@kolm.ai.",
};

const linkCls =
  "text-accent-text underline decoration-[var(--accent-edge)] underline-offset-[3px] transition-colors hover:decoration-[var(--accent)]";

function B({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}

function Lk({ href, children }: { href: string; children: React.ReactNode }) {
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={linkCls}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={linkCls}>
      {children}
    </a>
  );
}

function H2({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-12 scroll-mt-28 font-display text-[clamp(22px,2.7vw,29px)] font-bold leading-[1.14] tracking-[-0.022em] text-ink"
    >
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-8 font-sans text-[17.5px] font-semibold tracking-[-0.01em] text-ink">
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-[16px] leading-[1.72] text-ink-2">{children}</p>;
}

function UL({ children }: { children: React.ReactNode }) {
  return <ul className="mt-4 grid gap-3">{children}</ul>;
}

function LI({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-[16px] leading-[1.66] text-ink-2">
      <span
        aria-hidden
        className="mt-[9px] h-[5px] w-[5px] flex-none rounded-full bg-[var(--accent)]"
      />
      <span>{children}</span>
    </li>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-[4px] bg-paper-sink px-[6px] py-[2px] font-mono text-[0.85em] text-ink">
      {children}
    </code>
  );
}

const TOC: { id: string; label: string }[] = [
  { id: "s1", label: "Parties and acceptance" },
  { id: "s2", label: "Service description" },
  { id: "s3", label: "Accounts and access" },
  { id: "s4", label: "Scope of the audit engagement" },
  { id: "s5", label: "Acceptable use" },
  { id: "s6", label: "Fees, payment, and refunds" },
  { id: "s7", label: "Intellectual property and license" },
  { id: "s8", label: "Confidentiality" },
  { id: "s9", label: "Data handling" },
  { id: "s10", label: "Warranties and disclaimer" },
  { id: "s11", label: "Limitation of liability" },
  { id: "s12", label: "Indemnification" },
  { id: "s13", label: "Term, suspension, and termination" },
  { id: "s14", label: "Changes to these terms" },
  { id: "s15", label: "Governing law and dispute resolution" },
  { id: "s16", label: "Contact" },
];

export default function TermsPage() {
  return (
    <>
      {/* Hero */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">01 / Terms</p>
          <h1 className="max-w-[24ch] font-display text-[clamp(34px,5vw,54px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-ink">
            Terms of Service
          </h1>
          <p className="mt-6 max-w-[72ch] font-sans text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-ink-2">
            These terms govern your use of kolm.ai for agent-security audits and
            signed evidence reports. They are the agreement between you and
            Kolmogorov Stack, Inc., written so a developer, a procurement
            reviewer, or legal counsel can read it once. The evidence report at
            the center of the service is a cryptographically signed (Ed25519),
            offline-verifiable document your security team checks against kolm's
            public key, with no account and no trust in kolm's servers.
          </p>
          <p className="mt-4 text-[14px] text-ink-3">
            Last updated: <B>2026-06-07</B> (supersedes 2026-05-22)
          </p>
        </div>
      </section>

      {/* Long-form legal prose */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-[78ch] px-6 py-[clamp(48px,6vw,72px)]">
          <p className="eyebrow mb-6">02 / Agreement</p>

          {/* TOC */}
          <nav
            aria-label="Table of contents"
            className="rounded-lg border border-[var(--line-ink)] bg-ink-deep px-7 py-6"
          >
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-on-ink-3">
              Contents
            </p>
            <ol className="mt-4 grid list-decimal gap-x-8 gap-y-2 pl-6 text-[14px] leading-[1.7] text-on-ink-2 marker:text-on-ink-3 sm:grid-cols-2">
              {TOC.map((t) => (
                <li key={t.id}>
                  <a
                    href={`#${t.id}`}
                    className="text-on-ink underline-offset-2 hover:text-[var(--accent-on-ink)] hover:underline"
                  >
                    {t.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          {/* 1 */}
          <H2 id="s1">1. Parties and Acceptance</H2>
          <P>
            <B>Provider.</B> Kolmogorov Stack, Inc., a Delaware corporation
            ("kolm," "we," or "us").
          </P>
          <P>
            <B>Customer.</B> The individual or legal entity that submits an audit
            request, signs an order form, or uses the verification service ("you"
            or "Customer"). Where you accept on behalf of a company, you represent
            that you are authorized to bind that company to these terms.
          </P>
          <P>
            <B>Acceptance.</B> You accept these terms by: (a) submitting an audit
            request at <Lk href="/contact">/contact</Lk>; (b) signing an
            enterprise order form; (c) creating a kolm account and using any
            hosted feature; or (d) clicking through a checkout flow. Using the
            open-source verifier tool under its Apache-2.0 license does not require
            acceptance of these terms.
          </P>
          <P>
            <B>Notices.</B> The email address on your account or order form is the
            canonical address for legal notices from us to you. Notices from you to
            us must be sent to <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>

          {/* 2 */}
          <H2 id="s2">2. Service Description</H2>
          <P>
            kolm.ai provides agent-security audit services and signed evidence
            reports for AI agents. The primary deliverable is a cryptographically
            signed (Ed25519) evidence report ("Evidence Report") that an enterprise
            security team can verify offline against kolm's published public key.
            The Evidence Report covers the scope agreed in the order form or audit
            request. Current audit modules include:
          </P>
          <UL>
            <LI>
              <B>API and permission posture.</B> Static and dynamic review of the
              API surface, OAuth scopes, tool-call boundaries, and least-privilege
              adherence.
            </LI>
            <LI>
              <B>Redaction and data-handling integrity.</B> Verification that the
              agent redacts, masks, or withholds sensitive fields as claimed, and
              that the audit-trail log captures the correct events.
            </LI>
            <LI>
              <B>Audit-trail integrity.</B> Structural and cryptographic review of
              the agent's internal audit log: completeness, tamper-evidence, and
              retention compliance.
            </LI>
            <LI>
              <B>Prompt-injection testing and reporting.</B> Adversarial injection
              probes with findings reported in the Evidence Report. See Section 4
              for the scope limitation on this module.
            </LI>
            <LI>
              <B>Offline-verifiable evidence.</B> The Evidence Report is signed with
              Ed25519 and structured as a SHA-256 Merkle log (RFC 6962 style).
              Verification requires only the open-source verifier and kolm's public
              key. It needs no account and no connection to kolm's servers.
            </LI>
          </UL>
          <P>
            Additional modules and engagement types (retainer, re-audit, continuous
            monitoring) may be described in a separate order form. That order form,
            together with these terms, constitutes the complete agreement for the
            engagement.
          </P>

          {/* 3 */}
          <H2 id="s3">3. Accounts and Access</H2>
          <P>
            <B>Account creation.</B> You create an account with an email address.
            We issue a verification link. Free and professional accounts
            authenticate with an API key. Enterprise accounts add SSO via SAML 2.0
            and directory sync via SCIM 2.0.
          </P>
          <P>
            <B>Key security.</B> Your API key is your credential. Treat it as a
            password. Rotate it immediately if you suspect compromise. kolm will not
            be liable for unauthorized access that results from your failure to
            protect your key.
          </P>
          <P>
            <B>Audit portal access.</B> The audit portal at{" "}
            <Mono>https://kolm.ai</Mono> allows you to submit agent metadata, track
            audit status, download signed Evidence Reports, and run the in-browser
            WebCrypto verifier. The portal requires a valid account or a one-time
            verification token issued at the time of report delivery.
          </P>
          <P>
            <B>Enterprise SSO.</B> Enterprise order forms may include SSO and SCIM
            provisioning. The order form is the controlling document for enterprise
            seat counts and access controls.
          </P>

          {/* 4 */}
          <H2 id="s4">4. Scope of the Audit Engagement</H2>
          <P>
            The Evidence Report attests to findings within the agreed audit scope.
            The following scope limitations apply to all engagements unless
            explicitly expanded in a signed order form:
          </P>

          <H3>4.1 What the Evidence Report covers</H3>
          <P>
            The Evidence Report attests to the findings produced by kolm's audit
            methodology applied to the agent artifact, API, and configuration
            provided by you. It covers: (a) the API and permission posture as
            observed during the audit window; (b) redaction and data-handling
            behavior as exercised by the audit test suite; (c) audit-trail structure
            and cryptographic integrity; and (d) injection probe findings as
            described in Section 4.2.
          </P>

          <H3>4.2 Injection testing: reported, not warranted</H3>
          <P>
            Prompt-injection and tool-abuse probes are performed and the findings
            are reported in the Evidence Report.{" "}
            <B>
              kolm does not warrant that the agent is free from prompt-injection
              vulnerabilities, that the tested scenarios are exhaustive, or that the
              agent will resist injection attempts not covered by the audit scope.
            </B>{" "}
            The injection module produces a findings report, not a certification of
            resistance. Customers are responsible for remediation and for
            independent re-testing following remediation.
          </P>

          <H3>4.3 Point-in-time nature</H3>
          <P>
            The Evidence Report reflects the agent as audited at the date shown on
            the report. Subsequent code changes, configuration changes, model
            updates, or dependency updates are not covered by the original report. A
            re-audit engagement is required to cover a materially changed agent.
          </P>

          <H3>4.4 Reliance scope</H3>
          <P>
            The Evidence Report is addressed to the Customer. Third parties
            (including the Customer's enterprise buyers and security reviewers) may
            verify the cryptographic signature and read the report but do so on
            their own assessment. kolm makes no warranty to any third party
            regarding the agent's security posture beyond what is stated in the
            signed report and these terms.
          </P>

          {/* 5 */}
          <H2 id="s5">5. Acceptable Use</H2>
          <P>
            The following uses are prohibited. kolm will suspend or terminate
            accounts that engage in them:
          </P>
          <UL>
            <LI>
              <B>Harm.</B> Do not submit agent configurations intended to generate
              content targeting real people for harassment, sexual content involving
              minors, or operational instructions for weapons capable of mass
              casualties.
            </LI>
            <LI>
              <B>Fraud.</B> Do not use the Evidence Report or the kolm verification
              badge in a context designed to mislead a counterparty about the
              security posture of an agent that has been materially altered since the
              audit.
            </LI>
            <LI>
              <B>Misrepresentation of scope.</B> Do not represent the Evidence Report
              as covering a scope broader than the agreed audit modules or as a
              certification of production security where the audit was scoped to a
              staging environment.
            </LI>
            <LI>
              <B>Privacy violations.</B> Do not submit agent configurations or trace
              data that contain personal data without a lawful basis. Healthcare data
              governed by applicable privacy law requires a signed data-processing
              agreement before submission.
            </LI>
            <LI>
              <B>Resource abuse.</B> Do not run sustained automated traffic against
              the audit portal or the verification endpoint intended to map the
              infrastructure or exhaust shared capacity.
            </LI>
            <LI>
              <B>Sanctions.</B> Do not use kolm's services in or for the benefit of a
              person or country covered by United States, United Kingdom, or European
              Union sanctions regimes.
            </LI>
          </UL>

          {/* 6 */}
          <H2 id="s6">6. Fees, Payment, and Refunds</H2>
          <P>
            <B>Fees.</B> Audit fees are set out in the order form or on the pricing
            page at <Lk href="/pricing">/pricing</Lk>. All fees are in United States
            dollars unless the order form specifies otherwise.
          </P>
          <P>
            <B>Payment timing.</B> Fixed-scope engagements are invoiced at signing
            (50%) and at report delivery (50%) unless the order form specifies a
            different schedule. Subscription and retainer plans are invoiced monthly
            or annually on the anniversary of the start date. Invoices are issued via
            Stripe and sent to the billing email on the order form.
          </P>
          <P>
            <B>Taxes.</B> Fees exclude VAT, GST, and applicable sales tax. Where we
            are required to collect, taxes are added at checkout and shown on the
            invoice. Reverse-charge VAT applies in EU jurisdictions for business
            customers with a valid VAT ID.
          </P>
          <P>
            <B>Refunds.</B> If you cancel a fixed-scope engagement before the audit
            kickoff call, we refund the deposit in full. After the kickoff call,
            work-in-progress fees are non-refundable but any unearned portion of the
            delivery payment is refunded pro-rata based on the audit modules not yet
            completed. For subscription plans, cancellation inside the first 14 days
            of the initial term earns a full refund; thereafter, the plan terminates
            at the end of the current billing cycle with no partial refund.
          </P>
          <P>
            <B>Disputed charges.</B> Disputes about any charge must be raised in
            writing to <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk> within 30 days
            of the invoice date. Disputed amounts are placed in hold while we review;
            undisputed amounts remain due.
          </P>

          {/* 7 */}
          <H2 id="s7">7. Intellectual Property and License</H2>
          <P>
            <B>kolm IP.</B> The audit methodology, the Evidence Report template, the
            signing infrastructure, the open-source verifier, and all related tooling
            are owned by or licensed to kolm. These terms do not transfer any
            ownership of kolm IP to you.
          </P>
          <P>
            <B>Evidence Report license.</B> Upon payment of all fees for an
            engagement, kolm grants you a worldwide, non-exclusive, royalty-free,
            sublicensable license to reproduce and distribute the Evidence Report for
            your legitimate business purposes, including sharing it with your
            enterprise buyers and security reviewers. You may not alter the
            cryptographic signature, the findings narrative, or the scope statement of
            the Evidence Report. An altered or truncated report will fail the
            open-source verifier's signature check.
          </P>
          <P>
            <B>Open-source verifier.</B> The verifier tool is licensed under
            Apache-2.0. Anyone may use, modify, and redistribute it under those terms.
            No account is required to run the verifier against a signed report.
          </P>
          <P>
            <B>Your agent and materials.</B> You retain all ownership of the agent
            code, configuration, model weights, and API credentials you provide for
            the audit. You grant kolm a limited, non-exclusive license to access and
            test those materials solely for the purpose of performing the agreed
            audit. We do not retain your agent's data beyond the engagement window;
            imported logs are redacted before storage and deleted when that window
            closes.
          </P>
          <P>
            <B>Upstream model licenses.</B> If your agent uses an upstream model
            subject to a third-party license (including, without limitation, Llama,
            Qwen, DeepSeek, or any other model with a use-restriction clause), you are
            responsible for compliance with that license. kolm does not relicense
            upstream models and does not represent that an audit clears any upstream
            license obligation.
          </P>
          <P>
            <B>Trademarks.</B> The kolm name, logo, and "verified by kolm" badge are
            trademarks of Kolmogorov Stack, Inc. Use of the badge is permitted only in
            connection with an unaltered Evidence Report issued by kolm for the
            specific agent version shown in the report. Use in any other context
            requires written permission from kolm.
          </P>

          {/* 8 */}
          <H2 id="s8">8. Confidentiality</H2>
          <P>
            <B>Definition.</B> "Confidential Information" means non-public information
            disclosed by one party to the other in connection with these terms that is
            designated as confidential or that a reasonable person would understand to
            be confidential given the circumstances of disclosure. Your agent
            architecture, code, credentials, and security findings are Confidential
            Information. kolm's pricing, methodology documentation, and internal
            tooling are Confidential Information.
          </P>
          <P>
            <B>Obligations.</B> Each party agrees to: (a) use the other party's
            Confidential Information only for the purposes of performing or receiving
            the services under these terms; (b) protect Confidential Information with
            at least the same care it uses for its own confidential information of
            similar sensitivity, and in no case less than reasonable care; and (c) not
            disclose Confidential Information to any third party other than employees,
            contractors, or advisors who need to know it and are bound by obligations
            at least as protective as these.
          </P>
          <P>
            <B>Evidence Report publication.</B> You control whether and to whom you
            share the Evidence Report. kolm does not publish report contents without
            your written authorization. kolm may reference the existence of the
            engagement in aggregate statistics or marketing (e.g., "N agent audits
            completed") without identifying you unless you have given written consent
            for a named case study.
          </P>
          <P>
            <B>Exceptions.</B> The confidentiality obligation does not apply to
            information that: (a) is or becomes publicly available through no breach of
            these terms; (b) was already known to the receiving party without
            restriction; (c) is independently developed by the receiving party; or (d)
            is required to be disclosed by law, regulation, or court order, provided
            the disclosing party gives prompt written notice to the other party to the
            extent legally permitted.
          </P>
          <P>
            <B>Survival.</B> Confidentiality obligations survive termination of these
            terms for three (3) years, except for trade secrets, which remain protected
            for as long as they qualify as trade secrets under applicable law.
          </P>

          {/* 9 */}
          <H2 id="s9">9. Data Handling</H2>
          <P>
            <B>Agent data you submit.</B> Agent code, configuration files, trace
            samples, and API credentials you submit for audit are used solely to
            perform the agreed audit modules. kolm does not retain your agent's
            submitted materials beyond the engagement window (90 days post-report
            delivery by default; shorter on request).
          </P>
          <P>
            <B>Audit portal metadata.</B> The hosted portal records timestamp, request
            type, token count where applicable, response status, and key fingerprint.
            Request bodies containing agent configuration are not stored in audit logs
            longer than the engagement retention period.
          </P>
          <P>
            <B>Evidence Report data.</B> The signed Evidence Report is stored by kolm
            for the duration of the agreement and for a reasonable period after to
            support verification requests. The report contains only the findings, scope
            summary, and cryptographic attestation fields. It includes no raw agent
            code or credentials.
          </P>
          <P>
            <B>Sub-processors.</B> kolm uses a limited set of sub-processors for
            infrastructure (compute, storage, signing key management) and business
            operations (billing, email). Sub-processors are listed at{" "}
            <Lk href="/subprocessors">/subprocessors</Lk> and are bound by
            data-processing agreements at least as protective as this section. kolm
            notifies customers of material sub-processor changes with at least 30 days
            advance notice.
          </P>
          <P>
            <B>Data minimization.</B> Imported agent logs are redacted before storage,
            used solely to perform the agreed audit, and deleted at the end of the
            engagement window. Customer Content is never used to train any model,
            including kolm's own. Contact{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk> with data-handling questions
            before submitting an audit request.
          </P>
          <P>
            <B>Deletion.</B> Upon termination or at your written request, kolm deletes
            your agent materials from active systems within 30 days and from backups
            within 90 days. Account email is retained only for legal and tax record
            retention as required by applicable law.
          </P>
          <P>
            <B>Privacy policy.</B> The full privacy policy at{" "}
            <Lk href="/privacy">/privacy</Lk> governs personal data kolm processes
            about your team members in connection with account management. The privacy
            policy and these terms are complementary; in the event of conflict, these
            terms govern the audit engagement data and the privacy policy governs
            personal data.
          </P>

          {/* 10 */}
          <H2 id="s10">10. Warranties and Disclaimer</H2>
          <P>
            <B>kolm's warranty.</B> For paid audit engagements, kolm warrants that: (a)
            the audit will be performed in a professional and workmanlike manner
            consistent with the agreed scope; (b) the Evidence Report will accurately
            reflect the findings of the audit as performed; and (c) the Ed25519
            signature on the Evidence Report is valid and verifiable against kolm's
            published public key.
          </P>
          <P>
            <B>Scope limitations are not warranty failures.</B> The following are
            expressly outside the scope of kolm's warranty and do not constitute a
            breach: (a) injection vulnerabilities not covered by the agreed audit
            modules (see Section 4.2); (b) vulnerabilities introduced after the audit
            date (see Section 4.3); (c) the agent's fitness for any particular
            production use; (d) the completeness of the audit relative to any specific
            compliance framework beyond the modules tested.
          </P>
          <P>
            <B>Open-source verifier.</B> The open-source verifier is provided as-is
            under Apache-2.0. kolm does not warrant its fitness for any particular
            verification use case beyond checking Ed25519 signatures on Evidence Reports
            issued by kolm.
          </P>
          <P>
            <B>Disclaimer.</B> To the maximum extent permitted by applicable law, kolm
            disclaims all other warranties, express or implied, including warranties of
            merchantability, fitness for a particular purpose, and non-infringement,
            except as expressly stated in this Section 10.
          </P>

          {/* 11 */}
          <H2 id="s11">11. Limitation of Liability</H2>
          <P>
            <B>Liability cap.</B> Each party's aggregate liability to the other arising
            out of or related to these terms, whether based on contract, tort, or any
            other theory, is limited to the greater of: (a) <B>USD 1,000</B>; or (b) the
            total fees paid or payable by you to kolm in the twelve (12) months
            immediately preceding the event giving rise to the claim.
          </P>
          <P>
            <B>Excluded damages.</B> Neither party is liable for indirect, incidental,
            special, consequential, or punitive damages, including lost profits, lost
            revenue, lost data, reputational harm, or business interruption, even if
            advised of the possibility of such damages.
          </P>
          <P>
            <B>Carve-outs.</B> The liability cap does not apply to: (a) your obligation
            to pay fees that are due; (b) either party's indemnification obligations
            under Section 12; (c) a party's fraud or willful misconduct; or (d)
            liability that cannot be excluded or limited under applicable law.
          </P>
          <P>
            <B>Allocation of risk.</B> The fees for audit engagements reflect, in part,
            this allocation of risk. The parties acknowledge that kolm would not provide
            the services at the agreed price without these limitations.
          </P>

          {/* 12 */}
          <H2 id="s12">12. Indemnification</H2>
          <P>
            <B>kolm indemnifies you for:</B> Third-party claims alleging that the
            Evidence Report format or the open-source verifier, as provided by kolm and
            used in accordance with these terms, infringes a valid United States patent,
            copyright, or registered trademark. Subject to the cap in Section 11.
          </P>
          <P>
            <B>You indemnify kolm for:</B> Third-party claims arising from: (a) your
            agent's design, operation, or outputs; (b) your use of the services in
            violation of Section 5; (c) your sharing or misrepresentation of the
            Evidence Report beyond its stated scope; (d) claims by an upstream model
            provider arising from your use of model outputs in connection with the
            audited agent; or (e) your breach of applicable law. Subject to the cap in
            Section 11.
          </P>
          <P>
            <B>Process.</B> The indemnified party must: (a) give the indemnifying party
            prompt written notice of the claim; (b) give the indemnifying party sole
            control of the defense and settlement; and (c) reasonably cooperate at the
            indemnifying party's expense. Any settlement that admits liability on behalf
            of the indemnified party requires the indemnified party's prior written
            consent, not to be unreasonably withheld.
          </P>

          {/* 13 */}
          <H2 id="s13">13. Term, Suspension, and Termination</H2>
          <P>
            <B>Term.</B> These terms apply from the date of acceptance until the
            expiration or termination of all active engagements and subscriptions.
          </P>
          <P>
            <B>Termination for convenience.</B> You may cancel any subscription plan at
            any time through the account dashboard or by written notice to{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>; cancellation takes effect at
            the end of the current billing cycle. Fixed-scope engagements may not be
            cancelled for convenience after the kickoff call except on terms agreed in
            writing. kolm may terminate a subscription plan with 30 days written notice
            without cause.
          </P>
          <P>
            <B>Termination for cause.</B> Either party may terminate immediately upon
            written notice if: (a) the other party materially breaches these terms and
            fails to cure within 30 days of written notice specifying the breach; (b) the
            other party becomes insolvent, makes a general assignment for the benefit of
            creditors, or has an insolvency proceeding filed against it that is not
            dismissed within 60 days; or (c) the other party engages in fraud or willful
            misconduct. Section 5 violations and non-payment may be terminated without a
            cure period.
          </P>
          <P>
            <B>Suspension.</B> kolm may suspend account access for: (a) a security
            incident requiring immediate containment; (b) a suspected Section 5
            violation; or (c) a payment that is more than 15 days past due. kolm will
            provide reasonable notice before suspension except where immediate action is
            required for security reasons.
          </P>
          <P>
            <B>Effect of termination.</B> On termination: (a) all licenses granted under
            these terms terminate except the license to the Evidence Reports already
            delivered; (b) each party returns or destroys the other party's Confidential
            Information; and (c) all accrued payment obligations remain due.
          </P>
          <P>
            <B>Survival.</B> Sections 7 (IP, for reports already delivered), 8
            (Confidentiality), 9 (Data handling, for the retention and deletion
            obligations), 10 through 12 (Warranty, Liability, Indemnification), and 15
            (Governing law) survive termination.
          </P>

          {/* 14 */}
          <H2 id="s14">14. Changes to These Terms</H2>
          <P>
            kolm may update these terms from time to time. The effective date at the top
            of this page reflects the most recent revision. For changes that materially
            reduce your rights or materially increase your obligations, kolm will send
            notice to the account email at least 30 days before the change takes effect.
            Continued use of any kolm service after the effective date of a change
            constitutes acceptance of the revised terms.
          </P>
          <P>
            Every effective date corresponds to a tagged commit in the public site
            repository. Prior versions of this document can be retrieved from the
            repository history. The canonical version is the one at{" "}
            <Lk href="https://kolm.ai/terms">https://kolm.ai/terms</Lk>.
          </P>

          {/* 15 */}
          <H2 id="s15">15. Governing Law and Dispute Resolution</H2>
          <P>
            <B>Governing law.</B> These terms are governed by the laws of the State of
            Delaware, without regard to its conflict-of-laws principles.
          </P>
          <P>
            <B>Negotiation first.</B> Before filing any formal claim, the parties agree
            to a 30-day period of good-faith negotiation. Either party initiates this
            period by written notice to the other party's contact address specifying the
            nature and amount of the claim. A genuine attempt to resolve is required, not
            a procedural checkbox.
          </P>
          <P>
            <B>Venue.</B> Any dispute not resolved by negotiation is subject to the
            exclusive jurisdiction of the state and federal courts located in the State
            of Delaware. Each party irrevocably waives any objection to venue in those
            courts and waives any right to a jury trial.
          </P>
          <P>
            <B>Class action waiver.</B> All claims under these terms are brought on an
            individual basis. Neither party may bring a class, collective, or
            representative action.
          </P>
          <P>
            <B>Equitable relief.</B> Either party may seek injunctive or other equitable
            relief in any court of competent jurisdiction to prevent actual or threatened
            misappropriation of intellectual property or Confidential Information, without
            first completing the negotiation period.
          </P>

          {/* 16 */}
          <H2 id="s16">16. Contact</H2>
          <P>
            For all questions about these terms, audit engagements, payment disputes,
            data requests, and legal notices, contact:
          </P>
          <div className="mt-4 rounded-lg border border-[var(--line-ink)] bg-ink-deep px-6 py-5 text-[15px] leading-[1.7] text-on-ink-2">
            <strong className="text-on-ink">Kolmogorov Stack, Inc.</strong>
            <br />
            <a
              href="mailto:dev@kolm.ai"
              className="text-on-ink underline decoration-[var(--accent-on-ink-edge)] underline-offset-[3px] hover:decoration-[var(--accent-on-ink)]"
            >
              dev@kolm.ai
            </a>
          </div>
          <P>
            For verification of a signed Evidence Report, use the open-source verifier at{" "}
            <Lk href="/verify">/verify</Lk> or run the verifier tool locally against
            kolm's published public key. Verification requires no account and no
            connection to kolm's servers.
          </P>

          {/* Related legal pages */}
          <div className="mt-10 flex flex-wrap gap-3 border-t border-line pt-6">
            <Button asChild variant="ghost" size="sm">
              <Link href="/privacy">Privacy policy</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/security">Security</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/subprocessors">Sub-processors</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/dpa">DPA</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/baa">BAA</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* CTA final */}
      <section className="bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(26px,3.6vw,40px)] font-bold leading-[1.1] tracking-[-0.025em] text-on-ink">
            Questions about these terms?
          </h2>
          <p className="mx-auto mt-4 max-w-[56ch] text-[clamp(16px,1.5vw,19px)] leading-[1.55] text-on-ink-2">
            Reach the team for engagement, billing, or legal questions. Or verify a
            signed report against kolm's public key, with no account.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/contact">Start an audit</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/verify">Verify a report</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
