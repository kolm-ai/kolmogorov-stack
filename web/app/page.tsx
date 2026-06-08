import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardKicker,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { VerifyWidget } from "@/components/verify-widget";
import { HeroLoop } from "@/components/hero-loop";
import {
  CheckIcon,
  ShieldIcon,
  LogIcon,
  KeyIcon,
  ArrowIcon,
} from "@/components/icons";

const FRAMEWORKS = [
  "SOC 2",
  "ISO 42001",
  "NIST AI RMF",
  "EU AI Act",
  "OWASP",
  "MITRE ATLAS",
];

const TRUST = [
  {
    icon: CheckIcon,
    title: "Ed25519-signed",
    body: "Every report is canonicalized and signed. The signature covers the exact bytes, so an inflated score or a deleted finding breaks the seal.",
  },
  {
    icon: LogIcon,
    title: "Append-only transparency log",
    body: "Each issuance is written to a hash-chained log a reviewer can audit. Evidence that cannot be quietly revised after the fact.",
  },
  {
    icon: KeyIcon,
    title: "Public-key pinning",
    body: "Your buyer verifies offline against your published key. No kolm server in the trust path, no account, no upload.",
  },
];

const STALL = [
  {
    kicker: "Over-permissioned",
    title: "More access than the job needs",
    body: "Ten times the privileges it uses, often on one shared key. The first thing a reviewer flags.",
    map: "ASR-1 · least privilege",
  },
  {
    kicker: "No tamper-evidence",
    title: "A log nobody can trust",
    body: "If the trail can be edited after the fact, it is not evidence. Reviewers want it append-only and hash-chained.",
    map: "ASR-2 · audit trail",
  },
  {
    kicker: "Say-so does not scale",
    title: "Questionnaires are not proof",
    body: "Self-attested answers shift the burden to the buyer. They want evidence they can verify themselves.",
    map: "ASR-3 · data egress",
  },
];

const FLOW = [
  {
    n: "01 · Audit",
    t: "We examine the agent",
    d: "Onramp through a log import or a sidecar proxy. Permissions, audit trail and data egress, each mapped to the standards your buyer cites.",
  },
  {
    n: "02 · Sign",
    t: "We seal the findings",
    d: "The report is canonicalized and signed with Ed25519. A downgraded finding or an inflated score breaks it. Each issuance enters an append-only log.",
  },
  {
    n: "03 · Verify",
    t: "Your buyer checks it",
    d: "They verify the signature offline, in their own browser, against your public key. No account, no upload, no kolm server in the trust path.",
  },
];

export default function HomePage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.02fr)]">
            <div>
              <p className="eyebrow mb-4">The SOC 2 for AI agents</p>
              <h1 className="max-w-[18ch] font-display text-[clamp(38px,6vw,64px)] font-extrabold leading-[1.0] tracking-[-0.035em] text-ink">
                Your AI agent is ready for enterprise. Here&rsquo;s the signed
                proof.
              </h1>
              <p className="mt-6 max-w-[52ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
                The deal is not lost. It is stalled in security review. When a
                buyer&rsquo;s security team has to vet your autonomous agent,
                hand them a signed evidence report they verify offline, against
                your own key. The four-to-eight-week review becomes days.
              </p>

              <div className="mt-7 flex flex-wrap gap-3">
                <Button asChild>
                  <Link href="/signup">Start free</Link>
                </Button>
                <Button asChild variant="ghost">
                  <Link href="/sample">See sample report</Link>
                </Button>
                <Button asChild variant="ghost">
                  <Link href="/contact">Book a demo</Link>
                </Button>
              </div>

              <p className="mt-3 text-[13px] text-ink-3">
                Or{" "}
                <a
                  className="border-b border-line-2 text-ink hover:border-ink"
                  href="/sample-audit-report.json"
                  download
                >
                  download the sample report
                </a>{" "}
                and verify it yourself. Real Ed25519, no account.
              </p>

              <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
                <span className="inline-flex items-center gap-2">
                  <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                  Ed25519-signed
                </span>
                <span className="inline-flex items-center gap-2">
                  <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                  Verifiable offline
                </span>
                <span className="inline-flex items-center gap-2">
                  <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                  Mapped to SOC 2, ISO 42001, your buyer&rsquo;s questionnaire
                </span>
              </div>
            </div>

            {/* proof above the fold: the real verifier, live, in this browser */}
            <aside aria-label="Live offline verification of a signed evidence report">
              <VerifyWidget />
            </aside>
          </div>

          {/* the narrative: stall -> verify offline -> close, on a 15s loop */}
          <div className="mt-[clamp(40px,5vw,64px)]">
            <div className="mb-4 flex items-center gap-3">
              <span className="eyebrow">The deal, end to end</span>
              <span className="h-px flex-1 bg-line" aria-hidden="true" />
            </div>
            <HeroLoop />
          </div>
        </div>
      </section>

      {/* ====================== VERIFIED-BY STRIP ====================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-12">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="verified">Verified by</Badge>
            {FRAMEWORKS.map((f) => (
              <span key={f} className="ctrlid">
                {f}
              </span>
            ))}
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {TRUST.map((t) => (
              <Card key={t.title} className="p-5">
                <t.icon className="h-5 w-5 text-[var(--accent)]" />
                <p className="mt-3 font-sans text-[16px] font-semibold text-ink">
                  {t.title}
                </p>
                <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                  {t.body}
                </p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ THE STALL =========================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / The stall</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A CISO will not take your word for it.
            </h2>
            <p className="mt-4 max-w-[50ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              The moment an autonomous agent touches customer data, the week-long
              review runs four to eight. A questionnaire no longer clears it.
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

      {/* ====================== HOW IT WORKS (LEDGER) ===================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">02 / How it works</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Audit. Sign. Verify.
            </h2>
            <p className="mt-4 max-w-[50ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              One lifecycle. The report is reproducible, scoped to what was
              tested, and checkable by anyone you hand it to.
            </p>
          </div>
          <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
            {FLOW.map((node, i) => (
              <div key={node.n} className="contents">
                <Card ledger className="flex flex-col">
                  <span className="font-mono text-[12px] font-medium text-on-ink-3">
                    {node.n}
                  </span>
                  <span className="mt-2 font-sans text-[18px] font-semibold text-on-ink">
                    {node.t}
                  </span>
                  <p className="mt-2 text-[14px] leading-relaxed text-on-ink-2">
                    {node.d}
                  </p>
                </Card>
                {i < FLOW.length - 1 && (
                  <div
                    aria-hidden="true"
                    className="hidden items-center justify-center text-on-ink-3 md:flex"
                  >
                    <ArrowIcon className="h-3.5 w-[26px]" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* =========================== WHAT WE TEST ========================= */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">03 / What we test</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Three deterministic controls, mapped to the questionnaire.
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <ShieldIcon className="h-5 w-5 text-[var(--accent)]" />
              <CardTitle className="mt-3">ASR-1 · Least privilege</CardTitle>
              <CardDescription className="mt-2">
                Scopes held match scopes used. No shared keys across isolation
                boundaries. We flag every grant the agent never exercises.
              </CardDescription>
            </Card>
            <Card>
              <LogIcon className="h-5 w-5 text-[var(--accent)]" />
              <CardTitle className="mt-3">ASR-2 · Audit trail</CardTitle>
              <CardDescription className="mt-2">
                Append-only, tamper-evident activity log with a stated retention
                policy. If the trail can be rewritten, it is not evidence.
              </CardDescription>
            </Card>
            <Card>
              <KeyIcon className="h-5 w-5 text-[var(--accent)]" />
              <CardTitle className="mt-3">ASR-3 · Data egress</CardTitle>
              <CardDescription className="mt-2">
                Egress destinations enumerated. Sensitive fields redacted before
                they leave the boundary. Every external call accounted for.
              </CardDescription>
            </Card>
          </div>
        </div>
      </section>

      {/* ============================ CTA FINAL =========================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[22ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Turn the security review into a download.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            A fixed-fee audit, a signed evidence report, and a review that moves
            at the speed of math.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/signup">Start free</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/sample">See sample report</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/contact">Book a demo</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
