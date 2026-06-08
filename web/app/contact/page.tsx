import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardKicker, CardTitle } from "@/components/ui/card";
import { CheckIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "Start an audit",
  description:
    "Start an agent security audit with no sales call. Run a free scan, or get a $750 signed, offline-verifiable readiness report your buyer checks against our public key. One channel: dev@kolm.ai.",
};

const ENTRY = [
  {
    kicker: "Start here · no card",
    price: "Free",
    sub: "A signed snapshot in minutes. Self-serve, no call.",
    features: [
      "Upload redacted logs, read findings in minutes",
      "Least-privilege and audit-trail read",
      "Signed, offline-verifiable snapshot (watermarked)",
      "No account to run it, none to verify it",
    ],
    cta: {
      label: "Run a free scan",
      href: "mailto:dev@kolm.ai?subject=Free%20scan",
      variant: "ghost" as const,
    },
  },
  {
    kicker: "The buyer-ready artifact",
    price: "$750",
    sub: "one-time. The full automated audit, signed.",
    features: [
      "Permissions, audit trail, egress, injection",
      "Mapped to SOC 2, ISO 42001, NIST AI RMF, OWASP, ATLAS",
      "Ed25519-signed, offline-verifiable report",
      "Remediation checklist for every finding",
    ],
    cta: {
      label: "Get the signed report",
      href: "mailto:dev@kolm.ai?subject=Signed%20Readiness%20Report",
      variant: "primary" as const,
    },
  },
];

const STEPS = [
  {
    n: "01 · Choose your entry",
    t: "Free scan or the $750 report",
    d: "Email dev@kolm.ai and upload redacted logs. Pick the free watermarked snapshot, or the full signed readiness report. No account, no sales call.",
  },
  {
    n: "02 · We run the audit",
    t: "Automated, then signed",
    d: "Permission read, audit-trail and egress checks, and the prompt-injection battery run as compute. The findings are canonicalized and Ed25519-signed, mapped to the frameworks your buyer cites.",
  },
  {
    n: "03 · Your buyer verifies",
    t: "Offline, against our key",
    d: "They open the report and verify the signature in their own browser with WebCrypto. No account, no upload, no kolm server in the trust path. The four-to-eight-week review compresses to days.",
  },
];

const BEFORE = [
  "What your agent does (one paragraph is plenty)",
  "What systems or APIs it can reach",
  "Which buyer or deal is blocked, and why",
  "Your target delivery date",
];

export default function ContactPage() {
  return (
    <>
      {/* ============================== 1. START AN AUDIT ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(56px,7vw,96px)]">
          <div className="max-w-[66ch]">
            <p className="eyebrow mb-3">01 / Start an audit</p>
            <h1 className="font-display text-[clamp(34px,5.4vw,56px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink">
              Your deal is stalled in security review. Start here.
            </h1>
            <p className="mt-5 max-w-[60ch] font-sans text-[clamp(17px,1.5vw,20px)] leading-[1.55] text-ink-2">
              A six-figure deal slows the moment a CISO has to vet an autonomous
              agent, and a one-week review stretches to four to eight weeks. The
              first move is not a meeting. Run a free scan, or get the $750
              signed readiness report your buyer verifies offline, against our
              public key.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <a href="mailto:dev@kolm.ai?subject=Start%20an%20audit">
                  Email dev@kolm.ai
                </a>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/verify">Verify a sample report</Link>
              </Button>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Free scan, no card
              </span>
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                No account for your buyer
              </span>
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Verified offline against our key
              </span>
            </div>
          </div>

          {/* the two ways in: a free scan or the signed report */}
          <div className="mt-12 grid gap-4 md:grid-cols-2">
            {ENTRY.map((e) => (
              <Card key={e.kicker} className="flex flex-col">
                <CardKicker>{e.kicker}</CardKicker>
                <p className="mt-3 font-display text-[clamp(32px,3.8vw,46px)] font-extrabold leading-none tracking-[-0.035em] text-ink">
                  {e.price}
                </p>
                <p className="mt-2 min-h-[34px] text-[13px] leading-snug text-ink-3">
                  {e.sub}
                </p>
                <ul className="my-5 grid gap-2.5">
                  {e.features.map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2 text-[15px] text-ink-2"
                    >
                      <CheckIcon className="mt-[5px] h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  asChild
                  variant={e.cta.variant}
                  className="mt-auto w-full"
                >
                  <a href={e.cta.href}>{e.cta.label}</a>
                </Button>
              </Card>
            ))}
          </div>
          <p className="mt-6 max-w-[56ch] text-[13px] leading-[1.6] text-ink-3">
            Both are self-serve and need nobody in the loop. Every fee is flat
            and listed on{" "}
            <Link
              className="border-b border-line-2 text-ink hover:border-ink"
              href="/pricing"
            >
              pricing
            </Link>
            .
          </p>
        </div>
      </section>

      {/* ============================== 2. WHAT HAPPENS NEXT ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">02 / What happens next</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Three steps. No call in any of them.
            </h2>
            <p className="mt-4 max-w-[54ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              The automated audit is compute, minutes for the scan and the
              report. The only human step is a named co-signer when a deal needs
              one, and that is days, not weeks.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {STEPS.map((s) => (
              <Card key={s.n} ledger className="flex flex-col">
                <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-on-ink-3">
                  {s.n}
                </span>
                <CardTitle className="mt-3 text-on-ink">{s.t}</CardTitle>
                <p className="mt-2 text-[15px] leading-relaxed text-on-ink-2">
                  {s.d}
                </p>
              </Card>
            ))}
          </div>
          <p className="mt-12 max-w-[72ch] text-[13px] leading-[1.6] text-on-ink-3">
            Scope is contractual. Permission posture, redaction and audit-trail
            integrity are assessed. Injection is tested and reported, not
            warranted.
          </p>
        </div>
      </section>

      {/* ============================== 3. REACH US ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[60ch]">
            <p className="eyebrow mb-3">03 / Reach us</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              One channel. Always the same address.
            </h2>
            <p className="mt-4 max-w-[54ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              There is no phone line, no chat widget, and no ticket queue. Every
              engagement starts with a written scope, and email keeps a clear
              record of what both sides agreed.
            </p>
          </div>
          <div className="grid items-start gap-7 md:grid-cols-2">
            <Card className="flex flex-col">
              <CardKicker>Write to</CardKicker>
              <p className="my-3 font-display text-[clamp(1.5rem,4vw,2rem)] font-semibold leading-[1.1]">
                <a
                  href="mailto:dev@kolm.ai"
                  className="text-[var(--accent)] hover:text-[var(--accent-deep)]"
                >
                  dev@kolm.ai
                </a>
              </p>
              <p className="text-[13px] leading-snug text-ink-3">
                We reply within one business day, with a scope draft or a
                clarifying question.
              </p>
              <Button asChild className="mt-5 w-full">
                <a href="mailto:dev@kolm.ai?subject=Start%20an%20audit&body=Agent%20description%3A%0A%0ASystems%20it%20can%20reach%3A%0A%0ADeal%20or%20evaluation%20context%3A%0A%0ATarget%20delivery%20date%3A">
                  Email dev@kolm.ai
                </a>
              </Button>
              <p className="mt-4 text-center text-[13px] leading-[1.6] text-ink-3">
                dev@kolm.ai is the only contact address.
              </p>
            </Card>
            <div>
              <h3 className="font-sans text-[20px] font-semibold leading-[1.3] tracking-[-0.012em] text-ink">
                Before you write
              </h3>
              <p className="my-4 text-[15px] leading-relaxed text-ink-2">
                A few lines is enough to scope the audit. Tell us what the agent
                does and which deal is waiting, and we can size the work on the
                first reply.
              </p>
              <ul className="mb-6 grid gap-2.5">
                {BEFORE.map((b) => (
                  <li
                    key={b}
                    className="flex items-start gap-2 text-[15px] text-ink-2"
                  >
                    <CheckIcon className="mt-[5px] h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-3">
                <Button asChild variant="ghost" size="sm">
                  <Link href="/pricing">See full pricing</Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/verify">Verify a report</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================== 4. FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[22ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Start with one email.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            A free scan or a $750 signed report. No sales call, and evidence
            your buyer verifies without trusting us.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <a href="mailto:dev@kolm.ai?subject=Start%20an%20audit">
                Email dev@kolm.ai
              </a>
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
