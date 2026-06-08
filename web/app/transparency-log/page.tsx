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
  title: "Transparency log: append-only, per-report inclusion proofs",
  description:
    "Every kolm evidence report is entered into an append-only, hash-chained transparency log that returns a per-report Merkle inclusion proof, so a reviewer can confirm a report was logged when it claims and was never quietly replaced.",
};

const ADDS = [
  {
    kicker: "Append-only",
    title: "You can add, never edit",
    body: "Entries are chained by hash. Rewriting any past entry changes every hash after it, so tampering is self-evident.",
  },
  {
    kicker: "Inclusion proof",
    title: "Proof per report",
    body: "Each report carries a Merkle proof binding it to the log's root, checkable without trusting the log operator.",
  },
  {
    kicker: "No replacement",
    title: "History you can rely on",
    body: "A reviewer can confirm the report they hold is the one that was logged, not a quietly swapped re-issue.",
  },
];

const PIPELINE: { k: string; v: React.ReactNode }[] = [
  { k: "leaf", v: <b className="text-on-ink">sha256(report)</b> },
  { k: "append", v: "tree.add(leaf) -> index" },
  {
    k: "root",
    v: (
      <>
        <b className="text-on-ink">merkle_root</b>{" "}
        <span className="text-on-ink-3">chained</span>
      </>
    ),
  },
  { k: "proof", v: <b className="text-on-ink">audit_path(index)</b> },
  {
    k: "verify",
    v: (
      <>
        <b className="text-on-ink">recompute -&gt; root</b>{" "}
        <span className="text-on-ink-3">offline</span>
      </>
    ),
  },
];

const NOT = [
  {
    kicker: "Offline",
    title: "No network to verify",
    body: "The inclusion proof checks against the report itself, with no network call needed.",
  },
  {
    kicker: "Familiar",
    title: "Supply-chain lineage",
    body: "The same transparency-log idea behind modern artifact signing.",
  },
  {
    kicker: "No custody",
    title: "Nothing to hold",
    body: "No tokens, no wallets, no chain in the enterprise trust path.",
  },
];

const darkGhost =
  "border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]";

export default function TransparencyLogPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">01 / Transparency log</p>
          <h1 className="max-w-[20ch] font-display text-[clamp(38px,6vw,60px)] font-extrabold leading-[1.0] tracking-[-0.035em] text-ink">
            A report can&rsquo;t be quietly replaced.
          </h1>
          <p className="mt-6 max-w-[66ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
            A signature proves a report wasn&rsquo;t altered. The transparency
            log proves something else: that this exact report existed when it
            claims, and that a different one wasn&rsquo;t slipped in later. Every
            report becomes a leaf in an append-only, hash-chained Merkle log,
            each shipping with its own inclusion proof.
          </p>
        </div>
      </section>

      {/* ============================== 02 / WHAT THE LOG ADDS ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <p className="eyebrow mb-8">02 / What the log adds</p>
          <div className="grid gap-4 md:grid-cols-3">
            {ADDS.map((c) => (
              <Card key={c.kicker}>
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2">{c.body}</CardDescription>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 03 / HOW IT WORKS (ledger) ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto grid max-w-wrap items-center gap-10 px-6 py-[clamp(64px,8vw,96px)] lg:grid-cols-2">
          <div>
            <p className="eyebrow mb-3 text-on-ink-3">03 / How it works</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Hash the report, append the leaf, return the path.
            </h2>
            <p className="mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              When a report is signed, its hash is appended as a leaf to the
              Merkle tree. The log returns the audit path from that leaf to the
              root. Anyone can recompute the path and confirm the leaf is
              included. The chained roots make removing or reordering history
              detectable.
            </p>
            <p className="mt-5 font-mono text-[12px] leading-relaxed text-on-ink-3">
              RFC 6962-style Merkle log · SHA-256 leaves · per-report audit path
            </p>
          </div>
          <Card ledger className="font-mono text-[13px] leading-relaxed">
            {PIPELINE.map((r) => (
              <div
                key={r.k}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 border-b border-[var(--line-ink)] py-2.5 last:border-0"
              >
                <span className="w-[72px] flex-none text-on-ink-3">{r.k}</span>
                <span className="text-on-ink-2">{r.v}</span>
              </div>
            ))}
          </Card>
        </div>
      </section>

      {/* ============================== 04 / WHAT IT IS NOT ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto grid max-w-wrap items-center gap-10 px-6 py-[clamp(64px,8vw,96px)] lg:grid-cols-2">
          <div>
            <p className="eyebrow mb-3">04 / What it is not</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Math reviewers already accept.
            </h2>
            <p className="mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Enterprise security teams are wary of crypto custody and
              public-chain exposure, so we keep none of that in the path. The
              transparency log is the same well-understood, Sigstore-style
              construction reviewers know from software supply-chain security.
              It&rsquo;s offline-verifiable, with zero tokens, wallets, or chains
              to trust.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button asChild variant="ghost" size="sm">
                <Link href="/report">Anatomy of a report</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href="/verify">Verify a report</Link>
              </Button>
            </div>
          </div>
          <div className="grid gap-3">
            {NOT.map((c) => (
              <Card key={c.kicker}>
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2">{c.body}</CardDescription>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Signed, logged, and checkable by anyone.
          </h2>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/verify">Verify a report</Link>
            </Button>
            <Button asChild variant="ghost" className={darkGhost}>
              <Link href="/platform">See the platform</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
