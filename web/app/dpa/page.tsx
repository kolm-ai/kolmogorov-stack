/* eslint-disable react/no-unescaped-entities */
import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Data Processing Agreement (DPA)",
  description:
    "kolm.ai's Data Processing Agreement for enterprise customers. GDPR Art. 28-aligned terms covering processor obligations, sub-processors, security measures, breach notification, and Standard Contractual Clauses.",
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

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-12 scroll-mt-28 font-display text-[clamp(22px,2.7vw,29px)] font-bold leading-[1.14] tracking-[-0.022em] text-ink">
      {children}
    </h2>
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

const thCls =
  "border-b border-line bg-paper-sink px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.07em] text-ink-3";
const tdCls = "px-4 py-3 align-top text-[14.5px] leading-[1.6] text-ink-2";

export default function DpaPage() {
  return (
    <>
      {/* Hero */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">01 / Data processing</p>
          <h1 className="max-w-[22ch] font-display text-[clamp(34px,5vw,54px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-ink">
            Data Processing Agreement
          </h1>
          <p className="mt-6 max-w-[64ch] font-sans text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-ink-2">
            This Data Processing Agreement ("DPA") governs how kolm.ai processes
            agent audit data and redacted logs on behalf of enterprise customers.
            It is incorporated into your Master Services Agreement or order form
            with kolm.ai and is governed by its terms.
          </p>
          <p className="mt-4 text-[14px] text-ink-3">
            Last updated: 2026-05. Aligned with GDPR Art. 28 and EU Standard
            Contractual Clauses 2021/914.
          </p>
        </div>
      </section>

      {/* Plain-language summary (the ledger beat) */}
      <section className="border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-[78ch] px-6 py-[clamp(48px,6vw,72px)]">
          <p className="eyebrow mb-3 text-on-ink-3">02 / In plain language</p>
          <h2 className="font-display text-[clamp(22px,2.7vw,29px)] font-bold leading-[1.14] tracking-[-0.022em] text-on-ink">
            The short version
          </h2>
          <p className="mt-4 text-[16px] leading-[1.72] text-on-ink-2">
            kolm.ai processes only the agent audit data and redacted log material
            you submit for review. We act as your processor; you remain the
            controller. All data is tenant-isolated. We notify you in writing
            within 72 hours of any confirmed breach. Sub-processors are listed in
            Section 6. We provide at least 30 days' written notice before adding
            any new sub-processor.
          </p>
        </div>
      </section>

      {/* Full terms */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-[78ch] px-6 py-[clamp(48px,6vw,72px)]">
          <p className="eyebrow mb-3">03 / Full terms</p>

          <H2>1. Definitions</H2>
          <P>
            <B>Controller</B>, <B>Processor</B>, <B>Data Subject</B>,{" "}
            <B>Personal Data</B>, and <B>Processing</B> have the meanings given in
            Regulation (EU) 2016/679 ("GDPR").
          </P>
          <P>
            <B>Customer Data</B> means all data, including Personal Data, that
            Customer submits to the kolm.ai audit and evidence services, including
            agent interaction logs, redacted prompts and completions, tool-call
            traces, and associated metadata.
          </P>
          <P>
            <B>Services</B> means the kolm.ai agent audit, evidence-report
            generation, Ed25519-signed report issuance, offline verification, and
            related control-plane services made available at kolm.ai.
          </P>
          <P>
            <B>MSA</B> means the Master Services Agreement or equivalent order form
            between the parties that incorporates this DPA.
          </P>

          <H2>2. Scope and roles</H2>
          <P>
            Customer acts as Controller of Customer Data. kolm.ai acts as
            Processor. kolm.ai will process Customer Data only on Customer's
            documented instructions, including with regard to transfers of Personal
            Data to third countries, unless required to do otherwise by applicable
            Union or Member State law. In such a case, kolm.ai will inform Customer
            of that legal requirement before processing, unless the law prohibits
            disclosure on important grounds of public interest.
          </P>

          <H2>3. Subject matter and duration</H2>
          <P>
            The subject matter of processing is the provision of agent security
            audit and evidence-report services as described in the MSA. Processing
            continues for the duration of the MSA plus a wind-down period not
            exceeding 30 days following termination or expiry, after which Customer
            Data will be deleted or returned in accordance with Section 11.
          </P>

          <H2>4. Nature and purpose of processing</H2>
          <P>
            kolm.ai processes Customer Data for the following purposes, and no
            others, unless Customer provides further documented instructions:
          </P>
          <UL>
            <LI>
              Receiving, ingesting, and storing agent interaction logs and redacted
              materials submitted by Customer for audit.
            </LI>
            <LI>
              Running automated security checks (permission scope analysis,
              prompt-injection detection, egress-path enumeration, tool-call
              integrity review) against submitted logs and traces.
            </LI>
            <LI>
              Generating a cryptographically signed evidence report (Ed25519 over a
              SHA-256 manifest) summarising audit findings.
            </LI>
            <LI>
              Issuing the signed evidence report and making it available for offline
              verification by Customer or Customer's counterparties.
            </LI>
            <LI>
              Operating the evidence-report registry and providing verification
              receipts.
            </LI>
            <LI>
              Providing Customer with self-serve data-export and deletion
              capabilities.
            </LI>
          </UL>

          <H2>5. Categories of data subjects and personal data</H2>
          <P>
            The categories of Personal Data processed and the data subjects to whom
            they relate are as follows:
          </P>
          <div className="mt-6 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>Category of data subject</th>
                  <th className={thCls}>Categories of personal data</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-line">
                  <td className={tdCls}>Customer employees and administrators</td>
                  <td className={tdCls}>
                    Account email address, tenant identifiers, API credentials,
                    audit configuration settings.
                  </td>
                </tr>
                <tr>
                  <td className={tdCls}>
                    End users of Customer's agent-based product (only when Customer
                    routes their data through the kolm.ai audit surface)
                  </td>
                  <td className={tdCls}>
                    Redacted or pseudonymised prompts and completions, tool-call
                    inputs and outputs, session identifiers, and any other fields
                    present in the logs Customer submits. Customer is responsible
                    for ensuring appropriate redaction before submission.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <P>
            kolm.ai does not require or request special categories of personal data
            (GDPR Art. 9) in order to provide the Services. Customer must not submit
            special-category data unless expressly agreed in writing.
          </P>

          <H2>6. Sub-processors</H2>
          <P>
            Customer hereby authorises kolm.ai to engage the sub-processors listed
            below. kolm.ai will give Customer at least <B>30 days' written notice</B>{" "}
            before engaging any new sub-processor or materially changing the role of
            an existing one. Customer may object on reasonable data-protection
            grounds within that notice period; if the parties cannot resolve the
            objection, Customer may terminate the relevant services without penalty
            on the grounds of the objection.
          </P>
          <div className="mt-6 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>Sub-processor role</th>
                  <th className={thCls}>Purpose</th>
                  <th className={thCls}>Processing region</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-line">
                  <td className={tdCls}>
                    Edge content delivery and frontend hosting
                  </td>
                  <td className={tdCls}>
                    Serving the kolm.ai web application, documentation, and static
                    assets.
                  </td>
                  <td className={tdCls}>United States; EU; global edge nodes.</td>
                </tr>
                <tr className="border-b border-line">
                  <td className={tdCls}>Control-plane compute hosting</td>
                  <td className={tdCls}>
                    Running the kolm.ai API, audit pipeline, evidence-report engine,
                    and registry.
                  </td>
                  <td className={tdCls}>United States (US-East).</td>
                </tr>
                <tr className="border-b border-line">
                  <td className={tdCls}>
                    Third-party model inference (conditional)
                  </td>
                  <td className={tdCls}>
                    Where Customer's audit configuration routes specific log material
                    to an external model provider for automated analysis, that
                    provider acts as a sub-processor for those inputs only. This
                    applies solely when Customer selects such a route; kolm.ai's
                    default processing does not involve third-party model inference.
                  </td>
                  <td className={tdCls}>
                    Per the applicable provider's published data-processing regions,
                    as disclosed in the notice required above.
                  </td>
                </tr>
                <tr>
                  <td className={tdCls}>Payment processing</td>
                  <td className={tdCls}>
                    Processing subscription and invoice payments for paid plans.
                    Billing data only; no Customer audit data is shared.
                  </td>
                  <td className={tdCls}>United States; EU.</td>
                </tr>
              </tbody>
            </table>
          </div>

          <H2>7. Processor obligations</H2>
          <P>
            kolm.ai agrees to the following obligations in its capacity as
            Processor:
          </P>
          <UL>
            <LI>
              <B>Instructions:</B> Process Customer Data only on Customer's
              documented instructions. Where kolm.ai believes an instruction would
              infringe applicable data-protection law, it will promptly notify
              Customer.
            </LI>
            <LI>
              <B>Confidentiality:</B> Ensure that personnel authorised to process
              Customer Data are bound by an appropriate duty of confidentiality.
            </LI>
            <LI>
              <B>Assistance:</B> Provide reasonable assistance to Customer in
              fulfilling its obligations under GDPR Arts. 32-36 (security, breach
              notification, data-protection impact assessments, prior consultation).
            </LI>
            <LI>
              <B>Records:</B> Maintain records of processing activities carried out
              on Customer's behalf, as required by GDPR Art. 30(2), and make them
              available on request.
            </LI>
            <LI>
              <B>Sub-processor flow-down:</B> Impose data-protection obligations on
              any sub-processor that are no less protective than those in this DPA.
            </LI>
          </UL>

          <H2>8. Security measures (GDPR Art. 32)</H2>
          <P>
            kolm.ai implements and maintains the following technical and
            organisational measures, taking into account the state of the art, the
            costs of implementation, and the nature, scope, context, and purposes of
            processing:
          </P>
          <UL>
            <LI>
              <B>Encryption in transit:</B> TLS 1.3 is enforced for all connections
              to the kolm.ai API and web surfaces. Unencrypted HTTP is redirected.
            </LI>
            <LI>
              <B>Encryption at rest:</B> Customer Data, including captured audit logs
              and generated evidence reports, is encrypted at rest using AES-256.
            </LI>
            <LI>
              <B>Tenant isolation:</B> Every data record is fenced by a{" "}
              <Mono>tenant_id</Mono> enforced at every store boundary.
              Defense-in-depth filters prevent cross-tenant access at the
              application, query, and storage layers.
            </LI>
            <LI>
              <B>Evidence-report integrity:</B> Each signed evidence report is issued
              with an Ed25519 signature over a SHA-256 manifest, enabling offline
              verification without any trust in kolm.ai's servers.
            </LI>
            <LI>
              <B>Access control:</B> Least-privilege role-based access control (RBAC)
              is applied to all internal systems. Administrative access requires
              multi-factor authentication and is logged via the internal audit
              pipeline.
            </LI>
            <LI>
              <B>Vulnerability management:</B> Dependencies are tracked and patched on
              a risk-prioritised schedule, and the open-source verifier and signing
              core are published for independent review.
            </LI>
            <LI>
              <B>Incident response:</B> kolm.ai maintains a documented
              incident-response plan covering detection, containment, eradication,
              recovery, and notification obligations.
            </LI>
          </UL>
          <P>
            Customer may review the full security posture at{" "}
            <Lk href="/security">/security</Lk> and the threat model at{" "}
            <Lk href="/security/threat-model">/security/threat-model</Lk>.
          </P>

          <H2>9. Data-subject rights</H2>
          <P>
            kolm.ai will provide reasonable assistance to Customer in responding to
            data-subject requests made under GDPR Chapter III (right of access,
            rectification, erasure, restriction of processing, data portability, and
            right to object). kolm.ai will forward to Customer, without undue delay,
            any data-subject request it receives that relates to Customer Data, and
            will not respond directly to the data subject without Customer's prior
            authorisation, unless required to do so by law.
          </P>
          <P>
            Customer may request export or deletion of Customer Data (to respond to
            access and portability requests within the statutory timeframes) by
            contacting{" "}
            <Lk href="mailto:dev@kolm.ai?subject=Data-subject%20request">
              dev@kolm.ai
            </Lk>
            . Authenticated account administrators can also export and delete data
            directly from the kolm dashboard.
          </P>

          <H2>10. Personal data breach notification</H2>
          <P>
            kolm.ai will notify Customer in writing without undue delay, and in any
            event within <B>72 hours</B> of becoming aware of a confirmed Personal
            Data breach affecting Customer Data. The notification will include, to
            the extent then known: the nature of the breach, the categories and
            approximate number of data subjects and records affected, the likely
            consequences, and the measures taken or proposed to address the breach
            and mitigate its effects.
          </P>
          <P>
            Breach reports and disclosures should be directed to{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>. kolm.ai will cooperate
            with Customer and relevant supervisory authorities as required.
          </P>

          <H2>11. Return and deletion of Customer Data</H2>
          <P>
            On termination or expiry of the MSA, or upon Customer's earlier written
            request, kolm.ai will, at Customer's election, either securely return or
            delete all Customer Data (including audit logs, evidence reports, and
            intermediate artefacts) within <B>30 days</B>. Copies held in automated
            backup systems will be purged on the next scheduled backup-rotation
            cycle, which does not exceed 90 days. Deletion will be confirmed to
            Customer in writing upon completion.
          </P>
          <P>
            Retention beyond this period is permitted only where required by
            applicable law; in such cases, kolm.ai will notify Customer, process the
            retained data for no other purpose, and delete it as soon as the legal
            obligation is satisfied.
          </P>

          <H2>12. Audit rights</H2>
          <P>
            Customer may audit kolm.ai's compliance with this DPA no more than once
            per calendar year, on at least 30 days' prior written notice. Audits will
            be conducted remotely during normal business hours and at Customer's
            expense, unless an audit reveals a material breach, in which case
            reasonable audit costs will be borne by kolm.ai.
          </P>
          <P>
            kolm.ai does not currently hold a SOC 2 report. In lieu of a third-party
            certification, kolm.ai satisfies Customer's audit rights through its
            published security posture, this DPA, written responses to a security
            questionnaire, and the open, offline verifier that lets Customer
            independently check every evidence report. Customer may request supporting
            materials by writing to <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>

          <H2>13. International transfers</H2>
          <P>
            Where Processing of Customer Data involves a transfer of Personal Data to
            a country outside the European Economic Area ("EEA") that has not been
            granted an adequacy decision by the European Commission, kolm.ai will
            ensure that the transfer is subject to appropriate safeguards. The primary
            mechanism is the EU Standard Contractual Clauses (Commission Decision
            2021/914), Module 2 (Controller-to-Processor), which are incorporated by
            reference into this DPA and govern in the event of any conflict with its
            other provisions.
          </P>
          <P>
            For transfers to sub-processors in third countries, kolm.ai will enter
            into Module 3 SCCs (Processor-to-Processor) or rely on another lawful
            transfer mechanism, as applicable. Details of the transfer mechanisms in
            place for each sub-processor are available on written request to{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>

          <H2>14. Liability</H2>
          <P>
            The aggregate liability of each party in connection with this DPA is
            subject to the limitations and caps set out in the MSA. Nothing in this
            DPA limits either party's liability to the extent that it cannot be limited
            or excluded under applicable data-protection law, including liability to
            data subjects under GDPR Art. 82.
          </P>

          <H2>15. Governing law and jurisdiction</H2>
          <P>
            This DPA is governed by the law specified in the MSA. If the MSA does not
            specify a choice of law, this DPA is governed by the laws of the State of
            Delaware, USA, without prejudice to any mandatory data-protection law of
            the jurisdiction in which the relevant data subjects are habitually
            resident. The parties submit to the exclusive jurisdiction of the courts
            of Delaware for resolution of any dispute arising from this DPA, except
            where mandatory law requires a different forum.
          </P>

          <H2>16. Contact and counter-signature</H2>
          <P>
            Questions about this DPA, requests for a counter-signed PDF copy, or
            requests to negotiate amendments should be directed to{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>. Please include your entity
            name, registered address, and the nature of your request. kolm.ai will
            provide a fully-executable version of this DPA on request and is prepared
            to review reasonable amendments from regulated industries including
            healthcare, financial services, and EU public-sector organisations.
          </P>

          <p className="mt-10 border-t border-line pt-5 text-[13.5px] leading-[1.7] text-ink-3">
            See also:{" "}
            <Link href="/terms" className="text-ink-2 hover:text-ink">
              Terms of Service
            </Link>{" "}
            ·{" "}
            <Link href="/privacy" className="text-ink-2 hover:text-ink">
              Privacy Policy
            </Link>{" "}
            ·{" "}
            <Link href="/sla" className="text-ink-2 hover:text-ink">
              SLA
            </Link>{" "}
            ·{" "}
            <Link href="/acceptable-use" className="text-ink-2 hover:text-ink">
              Acceptable Use
            </Link>{" "}
            ·{" "}
            <Link href="/security" className="text-ink-2 hover:text-ink">
              Security Posture
            </Link>
          </p>
        </div>
      </section>

      {/* CTA final */}
      <section className="bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(26px,3.6vw,40px)] font-bold leading-[1.1] tracking-[-0.025em] text-on-ink">
            Write to us before you sign.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(16px,1.5vw,19px)] leading-[1.55] text-on-ink-2">
            We review reasonable amendments for regulated customers and can provide a
            counter-signed PDF on request.
          </p>
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
