/* eslint-disable react/no-unescaped-entities */
import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Service Level Agreement",
  description:
    "kolm's service commitments: audit turnaround targets, verification-endpoint availability, support response times, and the remedies that apply when we miss them.",
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

const SUPPORT_ROWS: { sev: string; def: string; target: string }[] = [
  {
    sev: "Critical",
    def: "Verification path down, or a signed report cannot be validated",
    target: "4 business hours",
  },
  {
    sev: "High",
    def: "Active engagement blocked; delivery at risk",
    target: "1 business day",
  },
  {
    sev: "Normal",
    def: "Questions, scoping, report clarifications",
    target: "2 business days",
  },
];

export default function SlaPage() {
  return (
    <>
      {/* Hero */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">01 / Service levels</p>
          <h1 className="max-w-[22ch] font-display text-[clamp(34px,5vw,54px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-ink">
            Service Level Agreement
          </h1>
          <p className="mt-6 max-w-[64ch] font-sans text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-ink-2">
            What you can count on from kolm: how fast we deliver an audit, the
            availability of the verification path your buyers rely on, and how
            quickly we respond when something needs attention. These commitments
            apply to paid engagements as set out in your order form.
          </p>
          <p className="mt-4 font-mono text-[12px] tracking-[0.02em] text-ink-3">
            Last updated 1 June 2026 · supersedes prior versions
          </p>
        </div>
      </section>

      {/* 02 / Audit turnaround */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">02 / Audit turnaround</p>
          <H2>1. Audit turnaround</H2>
          <P>
            Turnaround is the commitment we price on. It is a clock, not a dollar
            figure. From the moment we have the inputs we need (agreed scope, access
            or log import, and a named technical contact), we target delivery of the
            signed evidence report within the window stated on your order form for
            the tier you selected. Express engagements target the shortest window;
            Standard and Advanced add depth and adjust the window accordingly. If we
            are tracking behind, we tell you before the deadline, not after.
          </P>
        </div>
      </section>

      {/* 03 / Verification availability */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">03 / Verification availability</p>
          <H2>2. Verification availability</H2>
          <P>
            A report is only useful if a buyer can check it. Verification has two
            independent paths, and the durable one does not depend on us:
          </P>
          <UL>
            <LI>
              <B>Offline, in-browser verification</B> at <Lk href="/verify">/verify</Lk>{" "}
              runs entirely in the buyer's browser against the signature embedded in
              the report. It works with no kolm account and no call to our servers, so
              it is available whenever the buyer's own device is.
            </LI>
            <LI>
              <B>The hosted verification endpoint and transparency log</B> carry a
              target monthly availability of 99.9%, measured as successful responses
              over total valid requests in a calendar month, excluding scheduled
              maintenance announced at least 48 hours in advance.
            </LI>
          </UL>
          <P>
            Because verification can be performed offline, a hosted-endpoint outage
            never invalidates a report you already hold.
          </P>
        </div>
      </section>

      {/* 04 / Support response targets (the ledger beat) */}
      <section className="border-b border-line bg-ink-deep text-on-ink">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3 text-on-ink-3">04 / Support response targets</p>
          <h2 className="font-display text-[clamp(22px,2.7vw,29px)] font-bold leading-[1.14] tracking-[-0.022em] text-on-ink">
            3. Support response targets
          </h2>
          <div className="mt-6 overflow-x-auto rounded-lg border border-[var(--line-ink)] bg-[var(--ink-deep-2)]">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr>
                  <th className="border-b border-[var(--line-ink)] px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.07em] text-on-ink-3">
                    Severity
                  </th>
                  <th className="border-b border-[var(--line-ink)] px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.07em] text-on-ink-3">
                    Definition
                  </th>
                  <th className="border-b border-[var(--line-ink)] px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.07em] text-on-ink-3">
                    Target first response
                  </th>
                </tr>
              </thead>
              <tbody>
                {SUPPORT_ROWS.map((r, i) => (
                  <tr
                    key={r.sev}
                    className={
                      i < SUPPORT_ROWS.length - 1
                        ? "border-b border-[var(--line-ink)]"
                        : undefined
                    }
                  >
                    <td className="px-4 py-3 align-top text-[14.5px] font-medium text-on-ink">
                      {r.sev}
                    </td>
                    <td className="px-4 py-3 align-top text-[14.5px] leading-[1.6] text-on-ink-2">
                      {r.def}
                    </td>
                    <td className="px-4 py-3 align-top text-[14.5px] leading-[1.6] text-on-ink-2">
                      {r.target}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-[16px] leading-[1.72] text-on-ink-2">
            Business hours are 09:00 to 18:00 US Eastern, Monday to Friday, excluding
            US public holidays. The contact for all severities is{" "}
            <a
              href="mailto:dev@kolm.ai"
              className="text-on-ink underline decoration-[var(--accent-on-ink-edge)] underline-offset-[3px] hover:decoration-[var(--accent-on-ink)]"
            >
              dev@kolm.ai
            </a>
            .
          </p>
        </div>
      </section>

      {/* 05 / Remedies */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">05 / Remedies</p>
          <H2>4. Remedies</H2>
          <P>
            If we miss the verification-availability target in a calendar month, you
            may request a service credit against the next invoice, proportional to the
            shortfall, up to one month of the applicable recurring fee. If we miss a
            committed audit-turnaround window for reasons within our control, the remedy
            is set out in your order form, typically a fee adjustment on that engagement.
            Service credits are the sole and exclusive remedy for missed targets, and are
            requested in writing to <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk> within
            30 days of the affected period.
          </P>
        </div>
      </section>

      {/* 06 / Exclusions */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">06 / Exclusions</p>
          <H2>5. Exclusions</H2>
          <P>
            These targets do not apply to delays caused by incomplete or late inputs
            from the customer, scope changes mid-engagement, factors outside our
            reasonable control (including upstream provider or network outages), or use
            of the services outside the{" "}
            <Lk href="/acceptable-use">Acceptable Use Policy</Lk>. Findings in a report
            describe the posture we observed within the agreed scope; this SLA covers
            service delivery, not the security outcome of any tested system.
          </P>
        </div>
      </section>

      {/* 07 / Changes and contact */}
      <section className="border-b border-line">
        <div className={clauseWrap}>
          <p className="eyebrow mb-3">07 / Changes and contact</p>
          <H2>6. Changes &amp; contact</H2>
          <P>
            We may revise these commitments; material changes appear in the "last
            updated" date and apply to engagements ordered after that date. Questions go
            to <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>
          <p className="mt-7 text-[14px] text-ink-3">
            See also: <Lk href="/terms">Terms</Lk> · <Lk href="/status">Status</Lk> ·{" "}
            <Lk href="/pricing">Pricing</Lk>
          </p>
        </div>
      </section>

      {/* CTA final */}
      <section className="bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(26px,3.6vw,40px)] font-bold leading-[1.1] tracking-[-0.025em] text-on-ink">
            Commitments you can hold us to.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(16px,1.5vw,19px)] leading-[1.55] text-on-ink-2">
            These targets apply the moment an engagement starts. Begin one, or read the
            terms behind them.
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
              <Link href="/terms">Read the terms</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
