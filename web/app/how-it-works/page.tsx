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
    "A six-figure deal stalls the moment a CISO has to vet an autonomous agent. kolm runs one lifecycle, audit, sign, verify, ending in an Ed25519-signed report your buyer checks offline against your key, with no kolm server in the trust path. The four-to-eight-week review compresses back to days.",
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
  "Ed25519-signed",
  "Verified offline, no kolm server in the path",
  "Re-attested on every deploy",
];

const STALL = [
  {
    kicker: "The clock",
    title: "One week becomes eight",
    body: "A CISO who has to vet an agent reopens every assumption. The schedule slips, the champion goes quiet, and a deal that was ready to sign sits in a queue.",
    map: "ASR-1 · least privilege",
  },
  {
    kicker: "The burden",
    title: "Say-so does not scale",
    body: "Self-attested answers shift the burden of proof onto the buyer. They want evidence they can verify, not a promise that the trail cannot be edited after the fact.",
    map: "ASR-2 · audit trail",
  },
  {
    kicker: "The fix",
    title: "Make trust checkable",
    body: "Hand them one signed artifact they verify on their own machine. The conversation moves from whether they believe you to whether the math checks out.",
    map: "ASR-6 · evidence",
  },
];

const FLOW = [
  {
    icon: SearchIcon,
    n: "01 · Audit",
    t: "We examine the agent",
    d: "Onramp through a log import or a sidecar proxy. Permissions, audit trail, data egress and injection resistance, each mapped to the standards your buyer cites.",
  },
  {
    icon: ShieldCheckIcon,
    n: "02 · Sign",
    t: "We seal the findings",
    d: "The report is canonicalized and signed with Ed25519. The signature covers the exact bytes, so a downgraded finding or an inflated score breaks it. Each issuance enters an append-only log.",
  },
  {
    icon: BigCheckIcon,
    n: "03 · Verify",
    t: "Your buyer checks it",
    d: "They verify the signature offline, in their own browser, against your public key. No account, no upload, no kolm server in the trust path.",
  },
];

const ONRAMP = [
  {
    kicker: "Onramp A",
    title: "Import your logs",
    body: "Bring observability exports from LiteLLM, Helicone or Portkey. We normalize tool calls, scopes and traffic. No code change, the fastest path to a first read.",
  },
  {
    kicker: "Onramp B",
    title: "Run a sidecar proxy",
    body: "Route the agent through a sidecar or MCP proxy for a live, append-only capture of exactly what it does (calls, tools and data paths) with tamper-evident hashing.",
  },
  {
    kicker: "What we look at",
    title: "Permissions · trail · egress · injection",
    body: "Least-privilege analysis of every scope held versus the scopes actually used, audit-trail completeness and retention, where data can leave, and a red-team pass for prompt injection and jailbreaks.",
  },
];

const CLOCKS = [
  {
    kicker: "The machine clock",
    title: "No human waits here",
    body: "Permission reads, audit-trail and egress checks, and the prompt-injection battery are compute. They run in minutes to hours and re-run on every deploy, with nobody in the loop. The free scan, the signed report, and both continuous plans need no person.",
    map: "minutes to hours · automated",
  },
  {
    kicker: "The human clock",
    title: "A name behind the result",
    body: "Some reviewers want a person to stand behind the finding, not a machine that approved a machine. A named co-signer reviews and signs alongside the math. That is days, bounded by an SLA, against the four to eight weeks a from-scratch review takes.",
    map: "days · bounded by an SLA",
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
    body: "Each issuance enters an append-only Merkle log (Ed25519 and SHA-256, RFC 6962 style), so a reviewer can confirm a report was issued when it claims and never quietly replaced.",
  },
  {
    kicker: "Live Trust link",
    title: "One link your buyer re-checks",
    body: "Hand any reviewer a live link that always resolves to the current signed report. No new email, no waiting on you, no human in the loop.",
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
              From stalled review to signed proof.
            </h1>
            <p className="mt-5 max-w-[60ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A six-figure deal stops the moment a CISO has to vet an autonomous
              agent. kolm runs one lifecycle, audit, sign, verify, that turns
              your word into math your buyer can check. An Ed25519-signed report,
              verified offline against your own key, with no kolm server in the
              trust path. The four-to-eight-week review compresses back to days.
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
            <p className="eyebrow mb-3">01 / The stall</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              The deal stalls on one question: can they take your word?
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A one-week security review runs four to eight the moment an
              autonomous agent touches customer data. The buyer&rsquo;s review
              group cannot accept a self-attested questionnaire on faith, and you
              have no way to prove the agent is least-privileged, logged and
              injection-tested in a form they can check themselves.
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
              One pipeline. Three moves.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              Audit the agent, sign the findings, hand your buyer a report they
              verify themselves. Each step is reproducible, scoped to what was
              tested, and checkable by anyone you give it to.
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
            Trust moves from our word to the math. The same Ed25519 check runs in
            the verifier your buyer opens.
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
                Two ways in, no rebuild.
              </h2>
              <p className="mt-4 max-w-[50ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
                You do not change the agent to audit it. Point us at the evidence
                and we go to work, through a log import for the fastest first read
                or a sidecar proxy for a live capture.
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
            Scope is contractual. Permission posture, redaction and audit-trail
            integrity are assessed. Injection is tested and reported, not
            warranted.
          </p>
        </div>
      </section>

      {/* ======================= TWO CLOCKS (LEDGER) ===================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">04 / Two clocks</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Minutes for the scan. Days for a name on it.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              A review stalls on two different clocks. We compress both, and we
              are candid about which one needs a person.
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
            Minutes for the automated scan, days for a named co-signed
            attestation. The automated tiers add no human. The reviewed
            attestation adds one, on purpose.
          </p>
        </div>
      </section>

      {/* ============================ CONTINUOUS ========================= */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">05 / Continuous</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A point-in-time report goes stale on the next deploy.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A permission granted in January can still fire in August. Continuous
              re-attests weekly or on every deploy and exposes a live Trust link
              you hand any buyer, so the evidence they check is never older than
              your last release.
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
            Your enterprise buyer&rsquo;s 2026 vendor questionnaires already ask
            whether your system can automatically log agent events, citing EU AI
            Act Article 12 (current enforcement date August 2 2026; a proposed
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
            Clear the review. Close the deal.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            One audit, one signed evidence report, and a review that moves at the
            speed of math.
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
