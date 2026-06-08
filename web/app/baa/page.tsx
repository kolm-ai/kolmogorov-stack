/* eslint-disable react/no-unescaped-entities */
import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Business Associate Agreement",
  description:
    "kolm's Business Associate Agreement for regulated engagements involving Protected Health Information (PHI). Scope, permitted uses, safeguards, subcontractor flow-down, and how to execute.",
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

export default function BaaPage() {
  return (
    <>
      {/* Hero */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">01 / Business Associate</p>
          <h1 className="max-w-[24ch] font-display text-[clamp(34px,5vw,54px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-ink">
            Business Associate Agreement
          </h1>
          <p className="mt-6 max-w-[64ch] font-sans text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-ink-2">
            When an audit engagement touches a Covered Entity's Protected Health
            Information (PHI), kolm may act as a Business Associate under 45 CFR
            Parts 160 and 164. This agreement sets the permitted uses and
            disclosures of PHI, the safeguards we apply, and each party's
            obligations for the life of the engagement.
          </p>
          <p className="mt-4 text-[14px] text-ink-3">
            Last updated: <B>2026-06-07</B>
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild>
              <a href="mailto:dev@kolm.ai">Request the BAA</a>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/trust">Trust center</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Long-form legal prose */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-[78ch] px-6 py-[clamp(48px,6vw,72px)]">
          <p className="eyebrow mb-3">02 / Agreement</p>

          <H2>1. Definitions</H2>
          <P>
            The following definitions apply throughout this Business Associate
            Agreement and are drawn from 45 CFR Part 160 and Subparts A and E of 45
            CFR Part 164 unless a more specific definition is given below.
          </P>
          <UL>
            <LI>
              <B>Business Associate.</B> kolm.ai ("kolm"), which provides AI-agent
              audit, attestation, and evidence services to Covered Entities and
              their downstream Business Associates. kolm is not itself a Covered
              Entity.
            </LI>
            <LI>
              <B>Covered Entity.</B> The healthcare provider, health plan, or
              healthcare clearinghouse that executes this Agreement and whose audit
              engagement may involve Protected Health Information (PHI).
            </LI>
            <LI>
              <B>Protected Health Information (PHI).</B> Individually identifiable
              health information, as defined at 45 CFR 160.103, created, received,
              maintained, or transmitted by kolm on behalf of the Covered Entity in
              the course of an audit engagement.
            </LI>
            <LI>
              <B>Security Incident.</B> The attempted or successful unauthorized
              access, use, disclosure, modification, or destruction of information
              or interference with system operations in an information system that
              processes PHI, as defined at 45 CFR 164.304.
            </LI>
            <LI>
              <B>Subcontractor.</B> A person or entity that creates, receives,
              maintains, or transmits PHI on behalf of kolm in support of an audit
              engagement. Subcontractors are listed at <Lk href="/trust">/trust</Lk>.
            </LI>
          </UL>

          <H2>2. Scope and applicability</H2>
          <P>
            This Business Associate Agreement applies when, and only when, a kolm
            audit engagement involves PHI belonging to the Covered Entity. kolm's
            standard agent-security audit process does not require access to PHI;
            this agreement covers regulated engagements where the Covered Entity
            chooses to include PHI-bearing data as part of the evidence scope. If no
            PHI is in scope, this agreement has no operative effect.
          </P>
          <P>
            Engagements where PHI may be in scope include: AI-agent audits for
            healthcare providers or payors where the agent under review processes
            patient records; red-team assessments of systems that handle clinical
            notes or claims data; and audit-report generation where the evidence set
            includes PHI-derived inputs provided by the Covered Entity.
          </P>

          <H2>3. Permitted uses and disclosures of PHI</H2>
          <P>
            kolm may use or disclose PHI received from, or created on behalf of, the
            Covered Entity only as follows:
          </P>
          <UL>
            <LI>
              As necessary to perform the audit services described in the master
              engagement agreement, including generating the cryptographically signed
              evidence report delivered to the Covered Entity.
            </LI>
            <LI>
              As required by applicable law, provided that kolm notifies the Covered
              Entity of the legal requirement prior to disclosure, to the extent
              permitted by that law.
            </LI>
            <LI>
              For the proper management and administration of kolm's operations, or
              to carry out legal responsibilities of kolm, provided the disclosure is
              required by law or kolm obtains reasonable assurances from the recipient
              that the PHI will be held confidentially and used or further disclosed
              only as required by law or for the purpose for which it was disclosed,
              and that any breaches will be reported to kolm.
            </LI>
            <LI>
              To report violations of law to appropriate federal and state
              authorities, consistent with 45 CFR 164.502(j)(1).
            </LI>
          </UL>
          <P>
            PHI is processed only as permitted under this agreement and the applicable
            Security Rule safeguards. kolm will not use or disclose PHI for marketing
            purposes, for training shared or general-purpose models, or for any purpose
            not expressly permitted by this agreement or required by law.
          </P>

          <H2>4. Safeguards</H2>
          <P>
            kolm will implement and maintain administrative, physical, and technical
            safeguards that reasonably and appropriately protect the confidentiality,
            integrity, and availability of any PHI that kolm creates, receives,
            maintains, or transmits on behalf of the Covered Entity, in accordance with
            45 CFR Part 164 Subpart C (the Security Rule).
          </P>
          <UL>
            <LI>
              <B>Administrative safeguards (45 CFR 164.308).</B> Risk analysis conducted
              prior to any engagement that is in scope; workforce training on PHI
              handling; designated security responsibility; and documented policies for
              PHI access control and incident response.
            </LI>
            <LI>
              <B>Physical safeguards (45 CFR 164.310).</B> Facility access controls,
              workstation use and security policies, and device and media controls
              governing any systems where PHI is temporarily processed during the audit
              engagement.
            </LI>
            <LI>
              <B>Technical safeguards (45 CFR 164.312).</B> Unique user identification,
              emergency access procedure, automatic log-off, encryption and decryption
              of PHI in transit and at rest, audit controls, integrity controls, and
              transmission security.
            </LI>
            <LI>
              <B>Organizational requirements (45 CFR 164.314).</B> Subcontractor
              agreements substantially equivalent to this agreement; policies and
              procedures maintained in written form; documentation retained for six years
              from creation or last effective date, whichever is later.
            </LI>
          </UL>

          <H2>5. Subcontractor flow-down</H2>
          <P>
            To the extent that kolm uses a Subcontractor to create, receive, maintain,
            or transmit PHI on kolm's behalf in the course of an audit engagement, kolm
            will execute a written agreement with that Subcontractor requiring the
            Subcontractor to comply with the same restrictions, conditions, and
            requirements that apply to kolm under this Business Associate Agreement,
            consistent with 45 CFR 164.308(b)(3) and 164.314(a).
          </P>
          <P>
            Subcontractors that may receive PHI in the course of an audit engagement are
            listed on the trust page at <Lk href="/trust">/trust</Lk>. The Covered Entity
            will receive prior written notice before any new Subcontractor with potential
            PHI exposure is added to the engagement. If the Covered Entity objects to the
            addition of a Subcontractor within fourteen days of notice, the parties will
            work in good faith to resolve the objection; if the objection cannot be
            resolved, the Covered Entity may terminate the engagement without penalty with
            respect to the Subcontractor change.
          </P>

          <H2>6. Reporting of impermissible use or disclosure; Security Incidents</H2>
          <P>
            kolm will report to the Covered Entity any use or disclosure of PHI not
            provided for by this agreement of which kolm becomes aware. Reporting
            obligations are as follows:
          </P>
          <UL>
            <LI>
              <B>Breach of unsecured PHI.</B> Written notice to the Covered Entity within
              thirty (30) calendar days of discovery by kolm, as required by 45 CFR
              164.410. The notice will include the identification of each individual whose
              unsecured PHI has been, or is reasonably believed to have been, accessed,
              acquired, used, or disclosed; a brief description of what happened; the
              types of PHI involved; the steps individuals should take to protect
              themselves; a brief description of what kolm is doing to investigate,
              mitigate, and prevent further occurrences; and contact information for the
              Covered Entity's questions.
            </LI>
            <LI>
              <B>Security Incidents.</B> kolm will report Security Incidents to the
              Covered Entity within thirty (30) calendar days of discovery. Unsuccessful
              security incidents (e.g., pings, port scans, and similar probes that do not
              result in access to PHI) are reported in summary form on a quarterly basis.
            </LI>
            <LI>
              <B>Impermissible use or disclosure.</B> Any other use or disclosure of PHI
              not permitted by this agreement will be reported to the Covered Entity
              within thirty (30) calendar days of discovery. Notification under this
              subsection does not itself constitute a determination that a breach
              requiring individual notification has occurred; that determination remains
              with the Covered Entity.
            </LI>
          </UL>

          <H2>7. Access, amendment, and accounting of disclosures</H2>
          <H3>7.1 Access by the Covered Entity</H3>
          <P>
            To the extent kolm maintains PHI in a designated record set on behalf of the
            Covered Entity, kolm will make such PHI available to the Covered Entity or, at
            the Covered Entity's direction, to the applicable individual within ten (10)
            business days of a written request, so as to enable the Covered Entity to meet
            its obligations under 45 CFR 164.524. PHI held by kolm in the course of an
            audit engagement is not ordinarily part of a designated record set; if the
            Covered Entity instructs kolm that certain PHI is part of such a set, kolm will
            treat it accordingly.
          </P>

          <H3>7.2 Amendment</H3>
          <P>
            To the extent kolm maintains PHI in a designated record set on behalf of the
            Covered Entity, kolm will make such PHI available for amendment and will
            incorporate any amendments directed by the Covered Entity within ten (10)
            business days of a written request, so as to enable the Covered Entity to meet
            its obligations under 45 CFR 164.526. Amendments are recorded with a tombstone
            entry in the audit trail; the original signed evidence report is not altered.
          </P>

          <H3>7.3 Accounting of disclosures</H3>
          <P>
            kolm will maintain and make available, within thirty (30) business days of a
            written request, the information required to provide an accounting of
            disclosures of PHI as necessary to enable the Covered Entity to respond to a
            request by an individual for an accounting under 45 CFR 164.528. kolm will
            retain records of PHI disclosures for six (6) years from the date of the
            disclosure or the last effective date of this agreement, whichever is later.
          </P>

          <H2>8. Return or destruction of PHI at termination</H2>
          <P>
            Upon termination of this agreement, kolm will, at the Covered Entity's
            election, either return to the Covered Entity all PHI received from or created
            on behalf of the Covered Entity, or destroy all such PHI and provide the
            Covered Entity with written certification of destruction. Return will be in a
            verifiable, machine-readable format; destruction will be via methods that
            render the PHI unreadable, indecipherable, and otherwise cannot be
            reconstructed. kolm will sign a destruction certificate for the Covered
            Entity's records.
          </P>
          <P>
            The return or destruction will be completed within thirty (30) calendar days of
            the termination effective date. If return or destruction is not feasible, kolm
            will extend the protections of this agreement to the PHI and limit further uses
            and disclosures to those purposes that make the return or destruction
            infeasible, for as long as kolm retains the PHI.
          </P>

          <H2>9. Term and termination</H2>
          <H3>9.1 Term</H3>
          <P>
            This agreement is effective as of the date both parties execute the master
            engagement agreement and remains in effect until that agreement terminates or
            expires, unless terminated earlier under this section.
          </P>

          <H3>9.2 Termination for cause</H3>
          <P>
            Either party may terminate this agreement if the other party materially
            breaches a material provision of this agreement and fails to cure the breach
            within thirty (30) calendar days of receiving written notice specifying the
            breach. The Covered Entity may terminate immediately upon written notice to
            kolm if the Covered Entity determines that a cure is not possible.
          </P>

          <H3>9.3 Effect of termination</H3>
          <P>
            Sections 3 (Permitted uses and disclosures), 4 (Safeguards), 7.3 (Accounting
            of disclosures), and 8 (Return or destruction) survive termination. Upon
            termination, the obligations in Section 8 apply immediately.
          </P>

          <H2>10. Miscellaneous</H2>
          <H3>10.1 Governing law</H3>
          <P>
            This agreement is governed by the laws of the State of Delaware, without
            regard to conflict-of-laws principles, except to the extent federal law
            (including HIPAA, 45 CFR Parts 160 and 164) preempts or supersedes state law.
            For federal agency customers, state government customers, and customers in
            jurisdictions where local rules require a different governing law, the parties
            will negotiate an appropriate modification.
          </P>

          <H3>10.2 Indemnification</H3>
          <P>
            Each party will indemnify, defend, and hold harmless the other party from and
            against claims, losses, liabilities, costs, and expenses (including reasonable
            legal fees) arising out of or relating to the indemnifying party's breach of
            this agreement or negligent or willful acts or omissions in connection with its
            obligations under this agreement. Liability caps and carve-outs are negotiated
            in the master engagement agreement; this agreement does not impose or waive any
            caps on its own.
          </P>

          <H3>10.3 Regulatory compliance</H3>
          <P>
            This agreement is intended to comply with HIPAA and the HITECH Act as
            implemented in 45 CFR Parts 160 and 164. To the extent any provision of this
            agreement conflicts with an applicable requirement of those regulations, the
            regulations control. The parties will amend this agreement as necessary to
            comply with changes in applicable law.
          </P>

          <H3>10.4 No third-party beneficiaries</H3>
          <P>
            This agreement is for the sole benefit of the Covered Entity and kolm and does
            not create any rights in any third party, except as required by applicable law.
          </P>

          <H3>10.5 Entire agreement</H3>
          <P>
            This Business Associate Agreement, together with the master engagement agreement
            into which it is incorporated, constitutes the entire agreement of the parties
            with respect to the subject matter hereof and supersedes all prior negotiations,
            representations, or agreements relating to the same subject matter.
          </P>

          <H2>11. How to execute this agreement</H2>
          <P>
            Regulated engagements involving PHI require a countersigned copy of this
            agreement before any PHI-bearing data is included in the audit scope. The
            process is as follows:
          </P>
          <UL>
            <LI>
              Email <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk> with your legal entity
              name, whether you are a Covered Entity or a downstream Business Associate, and
              whether you would like the kolm template or prefer to provide your own for
              redline. The contact form at <Lk href="/contact">/contact</Lk> may also be
              used.
            </LI>
            <LI>
              kolm will deliver the template the same business day. Material redlines are
              returned within five business days of receipt.
            </LI>
            <LI>
              A countersigned PDF is returned within two business days of agreed final
              text. A sales call is not required to execute the agreement.
            </LI>
            <LI>
              Once the agreement is in place, you are added to the Subcontractor notice list
              so that any future subprocessor change with PHI exposure reaches you with the
              prior notice this agreement requires.
            </LI>
            <LI>
              For OCR audits, IRB reviews, or downstream Covered Entity evidence requests,
              kolm responds to written evidence requests within five business days. The
              signed evidence report is verifiable offline; many audit questions resolve at
              that layer without further correspondence.
            </LI>
          </UL>
          <P>
            All BAA inquiries and breach reports go to{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>. Acknowledged within one business
            day.
          </P>
        </div>
      </section>

      {/* CTA final */}
      <section className="bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(26px,3.6vw,40px)] font-bold leading-[1.1] tracking-[-0.025em] text-on-ink">
            Start a regulated engagement.
          </h2>
          <p className="mx-auto mt-4 max-w-[60ch] text-[clamp(16px,1.5vw,19px)] leading-[1.55] text-on-ink-2">
            For audit engagements that involve Protected Health Information, email us to
            initiate the BAA process. No sales call required to countersign.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <a href="mailto:dev@kolm.ai">Email dev@kolm.ai</a>
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
