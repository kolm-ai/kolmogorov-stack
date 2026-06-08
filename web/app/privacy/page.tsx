/* eslint-disable react/no-unescaped-entities */
import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "How kolm.ai handles data collected during agent security audits: what we collect, how long we keep it, your GDPR and CCPA rights, and how to reach us.",
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

export default function PrivacyPage() {
  return (
    <>
      {/* Hero */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">01 / Privacy</p>
          <h1 className="max-w-[24ch] font-display text-[clamp(34px,5vw,54px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-ink">
            Privacy Policy
          </h1>
          <p className="mt-6 max-w-[72ch] font-sans text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-ink-2">
            kolm.ai issues cryptographically signed, offline-verifiable evidence
            reports for AI agent security reviews. This policy explains, in plain
            terms, what personal and organisational data we collect to deliver
            that service, why we collect it, how long we keep it, who we share it
            with, and how you exercise your rights under GDPR, CCPA, and
            equivalent laws.
          </p>
          <p className="mt-4 text-[14px] text-ink-3">
            Last updated: <B>2026-06-07</B> (supersedes 2026-05-22)
          </p>
        </div>
      </section>

      {/* Long-form legal prose */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-[78ch] px-6 py-[clamp(48px,6vw,72px)]">
          <p className="eyebrow mb-3">02 / Policy</p>

          <H2>1. Who we are</H2>
          <P>
            kolm.ai ("kolm", "we", "us") is the controller of personal data
            collected through the kolm.ai website and hosted services. We are
            incorporated under the laws of the United States. Contact:{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>

          <H2>2. Definitions</H2>
          <UL>
            <LI>
              <B>Audit Customer</B>: an organisation that engages kolm to audit
              an AI agent.
            </LI>
            <LI>
              <B>Audit Subject</B>: the AI agent system under review (not a
              natural person).
            </LI>
            <LI>
              <B>Customer Content</B>: redacted agent logs, tool-call traces, and
              configuration artefacts submitted for audit; these are treated as
              confidential and are not personal data in most cases unless the
              customer includes personal data in the submission.
            </LI>
            <LI>
              <B>Evidence Report</B>: the Ed25519-signed JSON document issued at
              the conclusion of an audit, containing the security findings, scope,
              and a SHA-256 Merkle log reference; verifiable offline against
              kolm's published public key.
            </LI>
            <LI>
              <B>Personal Data</B>: any information relating to an identified or
              identifiable natural person, as defined in GDPR Article 4(1) and
              equivalent legislation.
            </LI>
          </UL>

          <H2>3. Data we collect</H2>
          <P>
            The data categories below represent a complete list of the personal
            and organisational data we collect. If something is not in this list,
            we do not collect it.
          </P>

          <H3>3.1 Account and contact data</H3>
          <P>
            When an Audit Customer registers, we collect: the account email
            address, organisation name, billing contact name, and any other
            contact details provided in the order form. Legal basis: performance
            of a contract (GDPR Art. 6(1)(b)) and our legitimate interest in
            communicating with customers (Art. 6(1)(f)).
          </P>

          <H3>3.2 Billing data</H3>
          <P>
            We collect a Stripe-generated card token (never the primary account
            number), billing address, invoice line items, plan tier, and payment
            history. Prompt and completion content is never logged in billing
            records. Legal basis: performance of a contract and compliance with
            legal obligations (GDPR Art. 6(1)(b) and (c)).
          </P>

          <H3>3.3 Customer Content submitted for audit</H3>
          <P>
            Audit Customers submit redacted agent logs, tool-call traces,
            configuration files, and related artefacts necessary to run the
            security check suite. We process this data solely to deliver the audit
            and produce the Evidence Report. We do not use Customer Content to
            train any model, share it with third parties beyond the sub-processors
            listed in Section 7, or retain it beyond the retention periods in
            Section 6. Legal basis: performance of a contract (GDPR Art. 6(1)(b)).
          </P>

          <H3>3.4 Evidence Report registry data</H3>
          <P>
            When a signed Evidence Report is issued, we store the report ID, the
            SHA-256 content hash, the Ed25519 signature, the audit scope summary,
            and a timestamp in the verifier registry so that downstream parties
            can resolve and verify the report at{" "}
            <Mono>{"/verify/<report-id>"}</Mono> without an account or connection
            to kolm servers. The registry entry never includes raw logs, weights,
            or personal data beyond the Audit Customer's organisation name and the
            scope description they approved.
          </P>

          <H3>3.5 Gateway and API request metadata</H3>
          <P>
            When you use the kolm API or hosted control plane, we log: timestamp,
            route, HTTP status, latency, token counts (where applicable), and an
            API key fingerprint. Request and response bodies for audit-data
            endpoints are not retained after processing. Legal basis: legitimate
            interests in operating a reliable, secure service (GDPR Art.
            6(1)(f)).
          </P>

          <H3>3.6 Authentication audit log</H3>
          <P>
            Sign-in events, API key rotations, permission changes, and
            administrator actions on the hosted control plane are logged for the
            purpose of security incident investigation. Legal basis: legitimate
            interests (GDPR Art. 6(1)(f)) and, where applicable, legal obligation
            (Art. 6(1)(c)).
          </P>

          <H3>3.7 Support and correspondence</H3>
          <P>
            When you contact us by email at{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>, we retain the thread so
            that follow-up enquiries can be handled in context. Threads are
            deleted on request. Legal basis: legitimate interests (GDPR Art.
            6(1)(f)).
          </P>

          <H3>3.8 Website analytics</H3>
          <P>
            Marketing and informational pages on kolm.ai carry a first-party
            analytics cookie. No third-party ad pixels or cross-site trackers are
            used. Product and API pages set no analytics cookies; a session cookie
            holds your authentication token only while you are signed in. You may
            opt out of the analytics cookie by setting{" "}
            <Mono>kolm-no-track=1</Mono> in your browser. CLI tooling does not
            phone home unless you explicitly set <Mono>KOLM_TELEMETRY=1</Mono>; the
            opt-in telemetry records command name and exit code only, never
            content or filenames.
          </P>

          <H2>4. Purposes and legal bases</H2>
          <UL>
            <LI>
              <B>Delivering audit services</B>: processing Customer Content and
              producing the signed Evidence Report. Basis: contract.
            </LI>
            <LI>
              <B>Account management and billing</B>: provisioning access, issuing
              invoices, handling renewals. Basis: contract; legal obligation for
              tax records.
            </LI>
            <LI>
              <B>Security and fraud prevention</B>: maintaining the authentication
              audit log, detecting abuse of the API. Basis: legitimate interests.
            </LI>
            <LI>
              <B>Service improvement</B>: aggregate, anonymised usage metrics (not
              linked to individuals). Basis: legitimate interests.
            </LI>
            <LI>
              <B>Legal compliance</B>: responding to lawful requests from
              competent authorities. Basis: legal obligation.
            </LI>
            <LI>
              <B>Marketing communications</B>: product updates and announcements
              sent to account contacts who have not unsubscribed. Basis:
              legitimate interests; you may opt out at any time via the
              unsubscribe link in any message or by emailing{" "}
              <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
            </LI>
          </UL>

          <H2>5. What we do not collect or retain</H2>
          <P>
            We do not retain raw agent inference outputs, model weights, or
            un-redacted prompt bodies after the audit processing window. We do not
            sell, rent, or license personal data to third parties. We do not
            enrich account data with broker-sourced data. Customer Content is
            never used to train any model, including our own. We do not target or
            knowingly collect data from consumers; the service is designed for
            organisations and developers.
          </P>
          <P>
            When an engagement involves imported agent logs, redaction is applied
            before that content is stored, and the redacted material is held only
            for the processing window described in Section 6 before deletion.
            Questions about how an engagement handles Customer Content go to{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>

          <H2>6. Retention</H2>
          <UL>
            <LI>
              <B>Account and contact data</B>: held for the duration of the
              customer relationship and for a further three years to handle
              post-termination enquiries and legal claims, then deleted.
            </LI>
            <LI>
              <B>Billing records</B>: retained for seven years from the invoice
              date to satisfy statutory accounting obligations; the cardholder
              name and card token are deleted at account closure.
            </LI>
            <LI>
              <B>Customer Content (audit artefacts)</B>: deleted within 90 days of
              the Evidence Report being issued, unless the customer requests
              earlier deletion or has contracted for a longer retention period for
              their own compliance needs.
            </LI>
            <LI>
              <B>Evidence Report registry entries</B>: kept indefinitely so that
              previously issued reports remain verifiable; the entry contains
              scope metadata, not Customer Content. Customers may request removal
              of their organisation name from the registry; the cryptographic
              record (hash and signature) will remain to preserve the audit trail.
            </LI>
            <LI>
              <B>Authentication audit log</B>: retained for 12 months then
              deleted, unless a live investigation requires extension.
            </LI>
            <LI>
              <B>Support threads</B>: deleted within 12 months of resolution or on
              request.
            </LI>
            <LI>
              <B>Website analytics</B>: aggregated at 30 days; individual-level
              records deleted at 90 days.
            </LI>
          </UL>

          <H2>7. Sharing with third parties and sub-processors</H2>
          <P>
            We share data only as necessary to operate the service. The categories
            and roles of sub-processors are as follows. We do not share data with
            ad networks or data brokers under any circumstances.
          </P>
          <UL>
            <LI>
              <B>Cloud infrastructure (compute, storage, CDN)</B>: provides the
              hosting environment for the kolm platform. Data is encrypted at rest
              (KMS-backed keys) and in transit (TLS 1.3). Default region: US-East
              (AWS us-east-1). EU residency is available on the enterprise plan
              (AWS eu-west-1 or eu-central-1); Standard Contractual Clauses are
              included in the DPA.
            </LI>
            <LI>
              <B>Payment processor</B>: handles card tokenisation and payment
              settlement. This processor does not see Customer Content; it receives
              only billing-contact information and the invoice amount.
            </LI>
            <LI>
              <B>Transactional email</B>: delivers receipts, account notices, and
              policy-change announcements. Receives account email addresses and the
              content of the message being sent.
            </LI>
            <LI>
              <B>Identity provider / SSO broker</B>: on the enterprise plan, a
              third-party SSO broker handles SAML 2.0, OIDC, and SCIM provisioning.
              The identity records we transmit are limited to email, user ID, and
              group memberships needed to authorise requests. Disabled unless you
              have provisioned SSO on your plan.
            </LI>
          </UL>
          <P>
            When you supply your own API key to an upstream AI model provider (such
            as Anthropic, OpenAI, or Google) via the kolm platform settings, kolm
            routes your request directly to that provider; kolm is not the
            contracting party with the provider for those calls. If you use the
            free <Mono>/v1/free/chat</Mono> surface without supplying your own key,
            kolm acts as the contracting party with the upstream provider for those
            requests, and the gateway metadata logging described in Section 3.5
            applies.
          </P>

          <H2>8. International data transfers</H2>
          <P>
            The hosted platform operates primarily in the United States. Personal
            data transferred from the European Economic Area to the United States
            is protected under the EU Standard Contractual Clauses (2021 SCCs,
            Module 2 controller-to-processor) incorporated into our Data Processing
            Agreement. Customers may request the DPA by contacting{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>. EU data residency
            (hosting within AWS eu-west-1 or eu-central-1) is available as an
            addendum on the enterprise plan.
          </P>

          <H2>9. Security measures</H2>
          <P>
            kolm applies the following technical and organisational measures to
            protect personal data:
          </P>
          <UL>
            <LI>
              Encryption at rest using KMS-managed keys; encryption in transit
              using TLS 1.3.
            </LI>
            <LI>
              Ed25519 signing of all Evidence Reports; SHA-256 Merkle log (RFC 6962
              style) for the registry, providing an append-only, tamper-evident
              record without implying any distributed ledger or token-based system.
            </LI>
            <LI>
              Role-based access controls limiting access to personal data to
              personnel with a demonstrated need.
            </LI>
            <LI>
              Least-privilege scoped API keys, with every Evidence Report signed
              and entered into an append-only transparency log so issued artifacts
              cannot be altered after the fact.
            </LI>
            <LI>
              Incident response procedures with a target notification window of 72
              hours to supervisory authorities where required by GDPR Art. 33.
            </LI>
          </UL>
          <P>
            kolm does not currently hold a SOC 2 report, and there is no published
            third-party penetration test of kolm's own infrastructure. We will
            state either one here only once it is real and independently
            verifiable. This is distinct from the kolm product, which maps your
            agent's findings to SOC 2, ISO 42001, NIST AI RMF, EU AI Act, and the
            OWASP LLM & Agentic Top 10.
          </P>

          <H2>10. Your rights under GDPR and CCPA</H2>

          <H3>10.1 GDPR rights (EEA and UK data subjects)</H3>
          <UL>
            <LI>
              <B>Access (Art. 15)</B>: you may request a copy of the personal data
              we hold about you.
            </LI>
            <LI>
              <B>Rectification (Art. 16)</B>: you may ask us to correct inaccurate
              data.
            </LI>
            <LI>
              <B>Erasure (Art. 17)</B>: you may ask us to delete your personal data
              where there is no overriding legal ground for retention.
            </LI>
            <LI>
              <B>Restriction (Art. 18)</B>: you may ask us to restrict processing
              while a dispute is resolved.
            </LI>
            <LI>
              <B>Portability (Art. 20)</B>: you may request your data in a
              structured, machine-readable format. Account data is exportable as
              JSON on request; billing summaries are provided in CSV.
            </LI>
            <LI>
              <B>Objection (Art. 21)</B>: you may object to processing based on
              legitimate interests, including objection to direct marketing at any
              time.
            </LI>
            <LI>
              <B>Automated decision-making (Art. 22)</B>: kolm does not make
              decisions with legal or similarly significant effects on individuals
              solely by automated means.
            </LI>
            <LI>
              <B>Lodge a complaint</B>: you have the right to lodge a complaint with
              the supervisory authority in your country of residence.
            </LI>
          </UL>
          <P>
            To exercise any of these rights, contact{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>. We will acknowledge
            within 2 business days and provide a substantive response within 30
            days (extendable by a further two months for complex requests, with
            notice).
          </P>

          <H3>10.2 CCPA rights (California residents)</H3>
          <P>
            California residents have the right to know what personal information
            we collect and how it is used; the right to delete personal information
            we have collected; the right to opt out of any sale of personal
            information (we do not sell personal information); and the right not to
            receive discriminatory treatment for exercising these rights. To submit
            a CCPA request, contact{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>

          <H2>11. Cookies</H2>
          <P>
            We use cookies as described in Section 3.8. In summary: product and API
            pages use a session cookie only when you are authenticated; marketing
            and informational pages carry a first-party analytics cookie you can
            opt out of. We do not use third-party advertising cookies. A full
            cookie table is available on request from{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>

          <H2>12. Children</H2>
          <P>
            The kolm platform is designed for enterprise and developer use and is
            not directed at consumers or children. We do not knowingly collect
            personal information from individuals under the age of 13 (or the
            applicable minimum age in the relevant jurisdiction, which may be higher
            for EEA member states). If we become aware that such data has been
            collected, we will delete it promptly. To report a concern, contact{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>

          <H2>13. Changes to this policy</H2>
          <P>
            Material changes to this Privacy Policy will be announced by email to
            the account contact at least 30 days before they take effect. A dated
            summary of changes will be posted to the kolm.ai changelog.
            Non-material changes (clarifications, vendor address updates,
            typographic corrections) will be posted to the changelog without a
            mandatory advance notice period. Every version of this policy
            corresponds to a dated entry in the public changelog; previous versions
            are accessible through the changelog archive.
          </P>

          <H2>14. Governing law</H2>
          <P>
            This Privacy Policy is governed by the laws of the State of Delaware,
            United States, without regard to conflict-of-law provisions, except
            where applicable data-protection law (including GDPR) requires
            otherwise. Disputes arising under this policy are subject to the
            dispute-resolution provisions in the kolm Terms of Service.
          </P>

          <H2>15. Contact</H2>
          <P>
            For all privacy enquiries, subject-rights requests, data-processing
            agreements, residency addenda, and incident reports:
          </P>
          <UL>
            <LI>
              Email: <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>
            </LI>
            <LI>
              Response commitment: acknowledged within 2 business days; substantive
              response within 30 days for subject-rights requests.
            </LI>
          </UL>
          <P>
            There is no separate privacy desk address or DPO address. All privacy
            matters are routed through{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>
        </div>
      </section>

      {/* CTA final */}
      <section className="bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(26px,3.6vw,40px)] font-bold leading-[1.1] tracking-[-0.025em] text-on-ink">
            We will respond within 2 business days.
          </h2>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <a href="mailto:dev@kolm.ai">Contact dev@kolm.ai</a>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/trust">Trust center</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
