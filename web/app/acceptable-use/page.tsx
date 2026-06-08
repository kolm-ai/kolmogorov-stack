/* eslint-disable react/no-unescaped-entities */
import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Acceptable Use Policy",
  description:
    "How kolm's audit tooling, evidence reports, and verification services may and may not be used: scope of testing, authorization requirements, and prohibited conduct.",
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
    <h2 className="font-display text-[clamp(22px,2.7vw,29px)] font-bold leading-[1.14] tracking-[-0.022em] text-ink">
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

const clauseWrap = "mx-auto max-w-[78ch] px-6 py-[clamp(40px,5vw,60px)]";

export default function AcceptableUsePage() {
  return (
    <>
      {/* Masthead */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">00 / Acceptable use</p>
          <h1 className="max-w-[22ch] font-display text-[clamp(34px,5vw,54px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-ink">
            Acceptable Use Policy
          </h1>
          <p className="mt-6 max-w-[64ch] font-sans text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-ink-2">
            This policy governs how kolm's audit tooling, evidence reports, and
            verification services may be used. Our work tests live systems, so
            authorization and scope are not optional. They are the foundation of
            everything we sign.
          </p>
          <p className="mt-4 font-mono text-[12px] tracking-[0.02em] text-ink-3">
            Last updated 1 June 2026 · applies to all kolm services
          </p>
        </div>
      </section>

      {/* 01 / Authorization */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">01 / Authorization</p>
          <H2>1. Authorization is mandatory</H2>
          <P>
            kolm performs security assessments only against systems the customer owns
            or is expressly authorized to test. Before any audit begins, the customer
            must confirm in writing that it has the authority to permit testing of the
            in-scope agent, its tools, and its connected systems. We do not test
            third-party systems, shared infrastructure, or any asset outside the agreed
            scope without separate written authorization from the party that controls
            it.
          </P>
        </div>
      </section>

      {/* 02 / Scope */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">02 / Scope</p>
          <H2>2. Scope of testing</H2>
          <P>
            An audit covers the agent's permission posture, audit-trail integrity,
            data-handling and redaction, egress and supply-chain surface, and
            adversarial resilience (including prompt-injection probing). Prompt-injection
            and jailbreak resistance are <B>tested and reported, not warranted</B>: a
            passing result reflects the tests we ran, not a guarantee that no attack
            exists. The scope, methods, and limits of each engagement are fixed in the
            statement of work and reflected in the resulting report.
          </P>
        </div>
      </section>

      {/* 03 / Prohibited conduct */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">03 / Prohibited conduct</p>
          <H2>3. Prohibited conduct</H2>
          <P>You may not use kolm services to:</P>
          <UL>
            <LI>
              test, probe, or attack any system you do not own or are not authorized to
              assess;
            </LI>
            <LI>
              misrepresent the scope, date, findings, or signature status of a kolm
              evidence report;
            </LI>
            <LI>
              alter a signed report and present it as genuine (every report is
              Ed25519-signed and independently verifiable, and tampering is detectable);
            </LI>
            <LI>
              use the tooling to develop, stage, or distribute malware, ransomware, or
              denial-of-service capability;
            </LI>
            <LI>
              exfiltrate, retain, or resell data belonging to a third party encountered
              during an engagement;
            </LI>
            <LI>
              circumvent rate limits, access controls, or tenant isolation in kolm's own
              services.
            </LI>
          </UL>
        </div>
      </section>

      {/* 04 / Evidence integrity (the proof beat) */}
      <section className="border-b border-line bg-ink-deep text-on-ink">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3 text-on-ink-3">04 / Evidence integrity</p>
          <h2 className="font-display text-[clamp(22px,2.7vw,29px)] font-bold leading-[1.14] tracking-[-0.022em] text-on-ink">
            4. Integrity of evidence
          </h2>
          <p className="mt-4 text-[16px] leading-[1.72] text-on-ink-2">
            Each report carries a cryptographic signature over its exact contents and a
            verification path that anyone can run offline with the published public key.
            Presenting a modified report as kolm-issued, forging a signature, or claiming
            a scope broader than the one tested is a material breach of this policy and may
            be unlawful. A buyer who receives a report should verify it at{" "}
            <Link
              href="/verify"
              className="text-on-ink underline decoration-[var(--accent-on-ink-edge)] underline-offset-[3px] hover:decoration-[var(--accent-on-ink)]"
            >
              /verify
            </Link>{" "}
            rather than trust a forwarded claim.
          </p>
        </div>
      </section>

      {/* 05 / Responsible disclosure */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">05 / Responsible disclosure</p>
          <H2>5. Responsible disclosure</H2>
          <P>
            If you discover a vulnerability in kolm's own services or in a published
            report's verification path, contact us at{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk> before disclosing it publicly.
            We will acknowledge, investigate, and coordinate a fix and disclosure timeline
            with you.
          </P>
        </div>
      </section>

      {/* 06 / Suspension */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">06 / Suspension</p>
          <H2>6. Suspension</H2>
          <P>
            We may suspend or terminate access for any use that violates this policy,
            threatens the integrity of the evidence we sign, or exposes kolm or a third
            party to legal risk. Where practical we will give notice and an opportunity to
            cure; where the conduct is unlawful or endangers others, suspension may be
            immediate.
          </P>
        </div>
      </section>

      {/* 07 / Changes and contact */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">07 / Changes and contact</p>
          <H2>7. Changes &amp; contact</H2>
          <P>
            We may update this policy as our services evolve; material changes will be
            reflected in the "last updated" date above. Questions about acceptable use,
            scope, or authorization go to <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>
          <p className="mt-7 text-[14px] text-ink-3">
            See also: <Lk href="/terms">Terms</Lk> · <Lk href="/privacy">Privacy</Lk> ·{" "}
            <Lk href="/sla">SLA</Lk> ·{" "}
            <Lk href="/security/threat-model">Threat model</Lk>
          </p>
        </div>
      </section>

      {/* CTA final */}
      <section className="bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[26ch] font-display text-[clamp(26px,3.6vw,40px)] font-bold leading-[1.1] tracking-[-0.025em] text-on-ink">
            Authorized scope in. Verifiable evidence out.
          </h2>
          <p className="mx-auto mt-4 max-w-[54ch] text-[clamp(16px,1.5vw,19px)] leading-[1.55] text-on-ink-2">
            Every engagement starts with written authorization and ends with a report
            your buyer can check.
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
