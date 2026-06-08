import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardKicker,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Changelog: what shipped, with dates",
  description:
    "A running log of what kolm has shipped: the open offline verifier, the published Agent Security Readiness checklist, framework mappings, and the append-only transparency log.",
};

const SHIPPED = [
  {
    date: "2026 · June",
    title: "Site rebuilt around verifiable evidence",
    body: "A ground-up redesign around verifiable evidence: a live in-browser verifier on the homepage, the report anatomy, and the four-pillar check catalog. Everything centers on a signed artifact you can check yourself.",
  },
  {
    date: "2026 · June",
    title: "Open offline verifier",
    body: (
      <>
        A dependency-free WebCrypto Ed25519 verifier, shipped open. The browser
        widget, CLI, and library share one canonicalization. Paste a report and
        the check runs in-page, with a tamper demo to prove altered evidence
        can&rsquo;t pass.
      </>
    ),
  },
  {
    date: "2026 · June",
    title: "Agent Security Readiness (ASR) checklist",
    body: (
      <>
        Published openly under CC0: the six-control readiness checklist for
        agentic products, each control mapped into SOC 2, NIST AI RMF, EU AI Act,
        and the OWASP LLM &amp; Agentic Top 10.
      </>
    ),
  },
  {
    date: "2026 · Q1",
    title: "Transparency log + inclusion proofs",
    body: "Every report enters an append-only, hash-chained Merkle log and ships with a per-report inclusion proof, so a report can be shown to have been logged and never quietly replaced.",
  },
];

const darkGhost =
  "border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]";

export default function ChangelogPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">Changelog</p>
          <h1 className="max-w-[18ch] font-display text-[clamp(38px,6vw,60px)] font-extrabold leading-[1.0] tracking-[-0.035em] text-ink">
            What shipped, with dates.
          </h1>
          <p className="mt-6 max-w-[62ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
            A short, plain record of what&rsquo;s live: we list what&rsquo;s
            shipped, not what&rsquo;s promised.
          </p>
        </div>
      </section>

      {/* ============================== 01 / SHIPPED ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-10">
            <p className="eyebrow mb-3">01 / Shipped</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              What&rsquo;s live now.
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {SHIPPED.map((c) => (
              <Card key={c.title}>
                <CardKicker>{c.date}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2">{c.body}</CardDescription>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 02 / NOT YET LISTED (ledger) ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="max-w-[62ch]">
            <p className="eyebrow mb-3 text-on-ink-3">02 / Not yet listed</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              What we won&rsquo;t claim yet.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              kolm does not yet hold a SOC 2 report or a published third-party
              pentest of its own. We&rsquo;ll list either here only once it is
              real and verifiable.
            </p>
          </div>
        </div>
      </section>

      {/* ============================== FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            See the latest, verify it yourself.
          </h2>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/verify">Verify a report</Link>
            </Button>
            <Button asChild variant="ghost" className={darkGhost}>
              <Link href="/research">Read the research</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
