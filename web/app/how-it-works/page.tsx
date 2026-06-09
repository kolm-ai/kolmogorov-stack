import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardKicker,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { CheckIcon, ArrowIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Run a security audit of the AI you ship on demand, end to end in minutes. kolm audits your agent from its own logs, maps each finding to SOC 2, ISO 42001, NIST AI RMF, the EU AI Act, OWASP LLM Top 10, and MITRE ATLAS, and signs the report with Ed25519. The audit is reproducible, so it re-runs on every change, and your buyer verifies the signature offline against your public key, with no kolm server in the trust path.",
};

/* page-local flow icons (the shared icon set covers check + arrow) */
function SearchIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function ShieldCheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 11.5l2.4 2.4L15.5 9.3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function BigCheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4 12.5l4.5 4.5L20 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const HERO_TRUST = [
  "On demand, end to end in minutes",
  "Reproducible, re-runs on every change",
  "Verified offline, no kolm server in the trust path",
];

const STALL = [
  {
    kicker: "The lead time",
    title: "Four to six weeks of waiting",
    body: "The old way is an outside firm and a scheduled engagement. The audit of the AI you ship waits in a queue. A deal that needed the report this quarter slips to next.",
    map: "weeks of lead time",
  },
  {
    kicker: "The faith",
    title: "A PDF taken on faith",
    body: "What the firm hands over is a static PDF the buyer takes on your word. It is stale the moment a PR merges, and the buyer cannot re-check it themselves.",
    map: "a stale PDF, taken on faith",
  },
  {
    kicker: "The fix",
    title: "Run it on demand, signed",
    body: "kolm runs the same audit on demand, from your own logs, in minutes, and signs the result. The buyer verifies the signature on their own machine. The question moves from whether they believe you to whether the signature holds.",
    map: "on demand, signed, verifiable",
  },
];

const FLOW = [
  {
    icon: SearchIcon,
    n: "01 / Audit",
    t: "We audit the agent on demand",
    d: "Point us at the agent through a log import or a sidecar proxy, then run it whenever you want. We check least privilege, audit-trail integrity, data egress and redaction, and prompt-injection resistance, and map each finding to the standards your buyer cites. The scan is compute, so it finishes in minutes.",
  },
  {
    icon: ShieldCheckIcon,
    n: "02 / Sign",
    t: "We sign the findings",
    d: "We canonicalize the report and sign it with Ed25519. The signature covers the exact bytes. A downgraded finding or an inflated score breaks it. The run is deterministic, so the same input gives the same signed result.",
  },
  {
    icon: BigCheckIcon,
    n: "03 / Verify",
    t: "Your buyer verifies it",
    d: "Your buyer verifies the signature offline, in their own browser, against your public key. No account. No upload. No kolm server in the trust path.",
  },
];

const ONRAMP = [
  {
    kicker: "Onramp A",
    title: "Import your logs",
    body: "Bring observability exports from tools such as LiteLLM, Helicone, or Portkey. We normalize tool calls, scopes, and traffic. No code change, and the fastest path to a first signed read in minutes.",
  },
  {
    kicker: "Onramp B",
    title: "Run a sidecar proxy",
    body: "Route the agent through a sidecar or MCP proxy. We capture exactly what it does, the calls, the tools, and the data paths, in an append-only log with tamper-evident hashing.",
  },
  {
    kicker: "What we look at",
    title: "Permissions, trail, egress, injection",
    body: "Least-privilege analysis of every scope held versus the scopes actually used. Audit-trail completeness and retention. Where data can leave, and what gets redacted. A red-team pass for prompt injection and jailbreaks. The full set also covers model provenance, agent identity, memory and retrieval, and multi-agent delegation.",
  },
];

const CLOCKS = [
  {
    kicker: "Automated",
    title: "The scan needs no person",
    body: "Permission reads, audit-trail and egress checks, and the prompt-injection battery are compute. They run in minutes to hours. They re-run on every deploy. The free scan, the Signed Readiness Report, and both Continuous plans need no person in the loop.",
    map: "minutes to hours, automated",
  },
  {
    kicker: "Co-signed",
    title: "A named reviewer stands behind it",
    body: "Some reviewers want a person behind the finding. On the Reviewed Attestation, a named co-signer reviews the report and signs it alongside the Ed25519 signature. That takes days, against the four to six weeks a from-scratch firm review takes.",
    map: "days, with a named co-signer",
  },
];

const CONTINUOUS = [
  {
    kicker: "Versioned",
    title: "Every report carries a spec version",
    body: "When the agent changes, we re-run the affected checks and re-sign. You do not pay for a full audit again to keep the evidence current.",
  },
  {
    kicker: "Provable history",
    title: "The log shows nothing was swapped",
    body: "Each issuance enters an append-only Merkle log (Ed25519 and SHA-256, RFC 6962 style). A reviewer can confirm a report was issued when it claims, and never quietly replaced.",
  },
  {
    kicker: "Live Trust link",
    title: "One link your buyer re-checks",
    body: "Hand any reviewer a live link that always resolves to the current signed report. No new email, and no waiting on you.",
  },
];

export default function HowItWorksPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <div className="max-w-[68ch]">
            <h1 className="font-display text-[clamp(34px,5.2vw,56px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink">
              Run the audit on demand. From your logs to a signed report in minutes.
            </h1>
            <p className="mt-5 max-w-[60ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Every enterprise deal puts the AI you ship through a security review,
              and the AI is the part they dig into. The old way is an outside firm,
              a four to six week wait, and a PDF the buyer takes on faith. kolm runs
              the audit on demand, from your own logs, end to end in minutes. It maps
              each finding to SOC 2, ISO 42001, NIST AI RMF, the EU AI Act, OWASP LLM
              Top 10, and MITRE ATLAS, and signs the report with Ed25519. The run is
              reproducible, so it re-runs on every change, and your buyer verifies the
              signature offline against your public key, with no kolm server in the
              trust path.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <Link href="/contact">Start an audit</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/verify">Verify a report</Link>
              </Button>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
              {HERO_TRUST.map((t) => (
                <span key={t} className="inline-flex items-center gap-2">
                  <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ============================ THE STALL =========================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / The old way</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              An outside firm, weeks of wait, a PDF taken on faith.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              The standard security audit of the AI you ship is an outside firm and
              a scheduled engagement: a four to six week wait, and a PDF the buyer
              takes on your word. It is stale the moment a PR merges, and the buyer
              cannot re-check it. You need an audit you run on demand, in minutes,
              that the buyer verifies for themselves.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {STALL.map((s) => (
              <Card key={s.kicker}>
                <CardKicker>{s.kicker}</CardKicker>
                <CardTitle className="mt-2">{s.title}</CardTitle>
                <CardDescription className="mt-2">{s.body}</CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">{s.map}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* =================== AUDIT, SIGN, VERIFY (LEDGER) ================= */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">02 / Audit, Sign, Verify</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              One pipeline, three steps, minutes end to end.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              We audit the agent. We sign the findings. Your buyer verifies the
              report on their own machine. Each step is reproducible and scoped to
              exactly what was tested, so the same input gives the same signed result
              every time you run it.
            </p>
          </div>

          <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
            {FLOW.map((node, i) => (
              <div key={node.n} className="contents">
                <div className="flex flex-col gap-3 rounded-lg border border-[var(--line-ink)] bg-[var(--ink-deep-2)] p-5">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[var(--line-ink-2)] text-[var(--accent-on-ink)]">
                    <node.icon className="h-[21px] w-[21px]" />
                  </span>
                  <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-on-ink-3">
                    {node.n}
                  </span>
                  <span className="font-sans text-[17px] font-semibold tracking-[-0.01em] text-on-ink">
                    {node.t}
                  </span>
                  <p className="text-[13.5px] leading-[1.5] text-on-ink-2">
                    {node.d}
                  </p>
                </div>
                {i < FLOW.length - 1 && (
                  <div
                    aria-hidden="true"
                    className="hidden items-center justify-center px-2 text-on-ink-3 md:flex"
                  >
                    <ArrowIcon className="h-3.5 w-[26px]" />
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="mt-10 max-w-[56ch] text-[13px] leading-[1.6] text-on-ink-3">
            The same Ed25519 check runs in the verifier your buyer opens. Change
            one byte of the report and the signature reports VOID.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/verify">Verify the sample now</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/report">Anatomy of a report</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ============================== ONRAMP =========================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
            <div>
              <p className="eyebrow mb-3">03 / Onramp</p>
              <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
                Two ways in, no rebuild, self-serve.
              </h2>
              <p className="mt-4 max-w-[50ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
                You do not change the agent to audit it. Point us at the evidence
                once and run the audit whenever you want. Use a log import for the
                fastest first signed read, or a sidecar proxy for a live capture.
              </p>
              <div className="mt-6">
                <Button asChild variant="ghost" size="sm">
                  <Link href="/checks">See the full check catalog</Link>
                </Button>
              </div>
            </div>
            <div className="grid gap-3.5">
              {ONRAMP.map((o) => (
                <Card key={o.kicker}>
                  <CardKicker>{o.kicker}</CardKicker>
                  <CardTitle className="mt-2">{o.title}</CardTitle>
                  <CardDescription className="mt-2">{o.body}</CardDescription>
                </Card>
              ))}
            </div>
          </div>
          <p className="mt-10 max-w-[64ch] text-[13px] leading-[1.6] text-ink-3">
            Scope is contractual. We assess permission posture, redaction, and
            audit-trail integrity. Injection is tested and reported, not
            warranted.
          </p>
        </div>
      </section>

      {/* ========================= TIMING (LEDGER) ======================= */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">04 / Timing</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              No lead time. The scan takes minutes.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              There is no engagement to schedule and no queue to wait in. Most of
              the audit is automated and runs in minutes, on demand. One paid tier
              adds a named human reviewer, and that part takes days, against the four
              to six weeks a from-scratch firm review takes. We are clear about which
              is which.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {CLOCKS.map((c) => (
              <Card key={c.kicker} ledger>
                <CardKicker className="text-on-ink-3">{c.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">{c.title}</CardTitle>
                <CardDescription className="mt-2 text-on-ink-2">
                  {c.body}
                </CardDescription>
                <p className="mt-4 font-mono text-[12px] text-on-ink-3">
                  {c.map}
                </p>
              </Card>
            ))}
          </div>
          <p className="mt-10 max-w-[64ch] text-[13px] leading-[1.6] text-on-ink-3">
            Minutes for the automated scan, run on demand. Days for a named
            co-signed attestation. The automated tiers add no person. The Reviewed
            Attestation adds one, on purpose.
          </p>
        </div>
      </section>

      {/* ============================ CONTINUOUS ========================= */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">05 / Continuous</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              The firm&rsquo;s PDF goes stale on the next deploy. This re-runs.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A permission granted in January can still fire in August. Because the
              audit is reproducible, Continuous re-runs and re-attests weekly, or on
              every deploy. It exposes a live Trust link you hand any buyer. The
              evidence they check is never older than your last release.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {CONTINUOUS.map((c) => (
              <Card key={c.kicker}>
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2">{c.body}</CardDescription>
              </Card>
            ))}
          </div>
          <p className="mt-10 max-w-[72ch] text-[13px] leading-[1.6] text-ink-3">
            Your enterprise buyer runs 2026 vendor questionnaires that already ask
            whether your system can automatically log agent events, citing EU AI
            Act Article 12 (current enforcement date August 2, 2026; a proposed
            Digital Omnibus delay for some high-risk systems is not yet law).
            Continuous keeps that audit-trail evidence current, so you answer with
            proof, not a promise.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild variant="ghost">
              <Link href="/trust">See a live Trust link</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ============================ CTA FINAL ========================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[22ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Run the free scan.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            One audit, on demand, end to end in minutes. One signed evidence report
            your buyer verifies offline.
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
