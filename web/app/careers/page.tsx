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
  title: "Careers: build the evidence layer for AI agents",
  description:
    "Help build the evidence layer for AI agents entering the enterprise. We are assembling a network of elite AI-agent security researchers to co-review and co-sign audits, and a small founding team obsessed with verifiable, offline-checkable evidence.",
};

const FIT = [
  {
    kicker: "You have",
    title: "Broken real agents",
    body: "Prompt injection, tool abuse, exfiltration. You have found the failure modes, not just read about them.",
  },
  {
    kicker: "You value",
    title: "Proof over theater",
    body: "You would rather sign something true and scoped than rubber-stamp a questionnaire.",
  },
];

const ROLES = [
  {
    kicker: "Research network",
    title: "AI-agent security researcher",
    body: "Co-review and co-sign audits; help shape the ASR checklist and the red-team methodology.",
  },
  {
    kicker: "Engineering",
    title: "Founding security engineer",
    body: "Build the audit modules and the attestation core: permissions, egress, injection, signing, the verifier.",
  },
  {
    kicker: "Go-to-market",
    title: "Founding GTM",
    body: "Take the deal-unblocker to AI-native startups stuck in security review, and turn first wins into a referral engine.",
  },
];

export default function CareersPage() {
  return (
    <>
      {/* ============================== 1. CAREERS ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(56px,7vw,96px)]">
          <div className="max-w-[64ch]">
            <p className="eyebrow mb-3">01 / Careers</p>
            <h1 className="font-display text-[clamp(34px,5.4vw,56px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink">
              Build the evidence layer for AI agents.
            </h1>
            <p className="mt-5 max-w-[60ch] font-sans text-[clamp(17px,1.5vw,20px)] leading-[1.55] text-ink-2">
              Enterprises are about to let autonomous agents touch their most
              sensitive systems, and the way they decide whom to trust is broken.
              We build the proof layer that fixes it: signed, scoped,
              offline-verifiable evidence. If you care more about what can be
              checked than what can be claimed, we should talk.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <a href="mailto:dev@kolm.ai">Get in touch</a>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/research">Read our research</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ============================== 2. RESEARCH NETWORK ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="grid items-center gap-7 md:grid-cols-2">
            <div>
              <p className="eyebrow mb-3 text-on-ink-3">02 / Research network</p>
              <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
                Elite agent-security researchers.
              </h2>
              <p className="mt-4 max-w-[54ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
                The hardest audits deserve the best reviewers. We are assembling
                a network of top AI-agent security researchers to co-review and
                co-sign reports (their name and reputation on the evidence,
                alongside ours). Per-engagement, advisory, or deeper involvement;
                the work is real and the credit is yours.
              </p>
              <p className="mt-4 font-mono text-[12px] text-on-ink-3">
                Co-review · co-sign · named · per-engagement or advisory
              </p>
            </div>
            <div className="grid gap-3.5">
              {FIT.map((f) => (
                <Card key={f.title} ledger>
                  <CardKicker className="text-on-ink-3">{f.kicker}</CardKicker>
                  <CardTitle className="mt-2 text-on-ink">{f.title}</CardTitle>
                  <CardDescription className="mt-2 text-on-ink-2">
                    {f.body}
                  </CardDescription>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ============================== 3. OPEN ROLES ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">03 / Open roles</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Open conversations.
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {ROLES.map((r) => (
              <Card key={r.title}>
                <CardKicker>{r.kicker}</CardKicker>
                <CardTitle className="mt-2">{r.title}</CardTitle>
                <CardDescription className="mt-2">{r.body}</CardDescription>
              </Card>
            ))}
          </div>
          <p className="mt-6 max-w-[72ch] text-[15px] leading-relaxed text-ink-2">
            No formal listings yet. If any of this is you, write to{" "}
            <a
              className="font-medium text-accent-text hover:underline"
              href="mailto:dev@kolm.ai"
            >
              dev@kolm.ai
            </a>{" "}
            and tell us what you have built or broken.
          </p>
        </div>
      </section>

      {/* ============================== 4. FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Put your name on evidence worth trusting.
          </h2>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <a href="mailto:dev@kolm.ai">Get in touch</a>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/verify">See what we build</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
