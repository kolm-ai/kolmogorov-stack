/* eslint-disable react/no-unescaped-entities */
import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Sub-processors",
  description:
    "The categories of sub-processors kolm engages to deliver its audit and verification services, the role each plays, and how we notify customers of changes.",
};

const linkCls =
  "text-accent-text underline decoration-[var(--accent-edge)] underline-offset-[3px] transition-colors hover:decoration-[var(--accent)]";

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
    <h2 className="mt-12 font-display text-[clamp(22px,2.7vw,29px)] font-bold leading-[1.14] tracking-[-0.022em] text-ink">
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-[16px] leading-[1.72] text-ink-2">{children}</p>;
}

const thCls =
  "border-b border-line bg-paper-sink px-4 py-3 text-left font-mono text-[11px] font-medium uppercase tracking-[0.07em] text-ink-3";
const tdCls = "px-4 py-3 align-top text-[14.5px] leading-[1.6] text-ink-2";

const ROLES: { role: string; purpose: string; data: string; region: string }[] = [
  {
    role: "Cloud hosting & compute",
    purpose:
      "Runs the kolm services, the verification endpoint, and the transparency log",
    data: "Service metadata; report contents at rest",
    region: "United States",
  },
  {
    role: "Object storage",
    purpose: "Durable storage of signed reports and append-only audit logs",
    data: "Report contents; integrity records",
    region: "United States",
  },
  {
    role: "Error & performance monitoring",
    purpose: "Operational reliability of the verification path and APIs",
    data: "Diagnostic and request metadata",
    region: "United States / EU",
  },
  {
    role: "Email & transactional messaging",
    purpose: "Engagement coordination and report delivery notices",
    data: "Contact name and email",
    region: "United States",
  },
  {
    role: "Payment processing",
    purpose: "Billing for paid engagements and retainers",
    data: "Billing contact; payment handled by the processor",
    region: "United States",
  },
];

export default function SubprocessorsPage() {
  return (
    <>
      {/* Hero */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">01 / Sub-processors</p>
          <h1 className="max-w-[20ch] font-display text-[clamp(34px,5vw,54px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-ink">
            Sub-processors
          </h1>
          <p className="mt-6 max-w-[64ch] font-sans text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-ink-2">
            A deliberately small footprint. kolm's audits run on a tight set of
            infrastructure providers, and we keep customer data out of any system
            that does not need it. This page lists sub-processors by the role they
            play. It is referenced by our{" "}
            <Lk href="/dpa">Data Processing Addendum</Lk> and kept current as the list
            changes.
          </p>
          <p className="mt-4 font-mono text-[12px] tracking-[0.02em] text-ink-3">
            Last updated 1 June 2026
          </p>
        </div>
      </section>

      {/* Disclosure */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-[78ch] px-6 py-[clamp(48px,6vw,72px)]">
          <p className="eyebrow mb-3">02 / By role</p>

          <h2 className="font-display text-[clamp(22px,2.7vw,29px)] font-bold leading-[1.14] tracking-[-0.022em] text-ink">
            By role
          </h2>
          <P>
            We name sub-processors by function rather than overstating relationships
            we don't have. Each handles only the data category required for its role,
            under a data-processing agreement with terms no less protective than our
            own commitments to you.
          </P>
          <div className="mt-6 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>Role</th>
                  <th className={thCls}>Purpose</th>
                  <th className={thCls}>Data category</th>
                  <th className={thCls}>Region</th>
                </tr>
              </thead>
              <tbody>
                {ROLES.map((r, i) => (
                  <tr
                    key={r.role}
                    className={
                      i < ROLES.length - 1 ? "border-b border-line" : undefined
                    }
                  >
                    <td className={`${tdCls} font-medium text-ink`}>{r.role}</td>
                    <td className={tdCls}>{r.purpose}</td>
                    <td className={tdCls}>{r.data}</td>
                    <td className={tdCls}>{r.region}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <H2>What does not leave</H2>
          <P>
            We don't retain your agent's underlying data beyond what an engagement
            requires. When we analyze imported logs, redaction is applied before
            storage, and the redacted material is deleted at the end of the retention
            window. The signing keys that make a report verifiable are held in a
            key-management service and never travel to a sub-processor outside that
            role.
          </P>

          <H2>Change notification</H2>
          <P>
            Before adding or replacing a sub-processor that handles customer data, we
            update this page and, for customers under a <Lk href="/dpa">DPA</Lk>,
            provide advance notice through the channel named there. If you object to a
            new sub-processor on reasonable data-protection grounds, contact us and we
            will work with you on alternatives.
          </P>

          <H2>Contact</H2>
          <P>
            Questions about sub-processors, data residency, or data handling go to{" "}
            <Lk href="mailto:dev@kolm.ai">dev@kolm.ai</Lk>.
          </P>

          <p className="mt-7 text-[14px] text-ink-3">
            See also: <Lk href="/dpa">DPA</Lk> · <Lk href="/privacy">Privacy</Lk> ·{" "}
            <Lk href="/security">Security</Lk>
          </p>
        </div>
      </section>

      {/* CTA final */}
      <section className="bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(26px,3.6vw,40px)] font-bold leading-[1.1] tracking-[-0.025em] text-on-ink">
            Questions about a sub-processor?
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(16px,1.5vw,19px)] leading-[1.55] text-on-ink-2">
            Data residency, change objections, and data-handling questions all route to
            one inbox.
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
              <Link href="/dpa">Read the DPA</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
