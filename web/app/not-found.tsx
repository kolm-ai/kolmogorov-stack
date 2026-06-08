import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardKicker, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Page not found",
  description:
    "The page you requested has moved or never existed. Head back to kolm.ai to explore the evidence layer for AI agents entering the enterprise.",
  robots: { index: false, follow: true },
};

const DESTINATIONS = [
  {
    kicker: "Product",
    title: "Platform",
    href: "/platform",
    body: "The full audit and signing platform for AI agents entering enterprise review.",
  },
  {
    kicker: "Product",
    title: "How it works",
    href: "/how-it-works",
    body: "End-to-end walkthrough of the audit, evidence generation, and offline verification flow.",
  },
  {
    kicker: "Product",
    title: "What we test",
    href: "/checks",
    body: "The full ASR checklist: permissions, egress, injection, tool scope, and more.",
  },
  {
    kicker: "Verification",
    title: "Verify a report",
    href: "/verify",
    body: "Confirm a signed evidence report offline using WebCrypto. No account, no kolm servers.",
  },
  {
    kicker: "Verification",
    title: "Sample report",
    href: "/sample",
    body: "See a real signed evidence report: Ed25519 signature, scoped findings, and the public key.",
  },
  {
    kicker: "Trust",
    title: "Trust center",
    href: "/trust",
    body: "Security posture, sub-processor details, and our evidence model.",
  },
  {
    kicker: "Research",
    title: "Research",
    href: "/research",
    body: "Published findings on AI-agent attack surfaces, policy mapping, and methodology.",
  },
  {
    kicker: "Pricing",
    title: "Pricing",
    href: "/pricing",
    body: "Per-audit and enterprise pricing: start with a single report or engage at scale.",
  },
  {
    kicker: "Contact",
    title: "Contact",
    href: "/contact",
    body: "Talk to the team about an audit, a partnership, or anything else. dev@kolm.ai",
  },
];

export default function NotFound() {
  return (
    <>
      {/* ============================== 1. NOT FOUND ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(56px,7vw,96px)]">
          <div className="mx-auto max-w-[56ch] text-center">
            <p className="eyebrow mb-3 justify-center">01 / Not found</p>
            <h1 className="font-display text-[clamp(34px,5.4vw,56px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink">
              This page moved or never existed.
            </h1>
            <p className="mx-auto mt-5 max-w-[52ch] font-sans text-[clamp(17px,1.5vw,20px)] leading-[1.55] text-ink-2">
              The URL you followed does not match any current path on kolm.ai.
              Use the links below, or head straight back home.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Button asChild>
                <Link href="/">Back to home</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/verify">Verify a report</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* ============================== 2. FIND YOUR WAY ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">02 / Find your way</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Where would you like to go?
            </h2>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {DESTINATIONS.map((d) => (
              <Card key={d.href} ledger>
                <CardKicker className="text-on-ink-3">{d.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">
                  <Link href={d.href} className="hover:text-accent-ink">
                    {d.title}
                  </Link>
                </CardTitle>
                <p className="mt-2 text-[15px] leading-relaxed text-on-ink-2">
                  {d.body}
                </p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 3. FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[22ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Reach us directly.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            If the page you needed is genuinely missing, write to{" "}
            <a
              href="mailto:dev@kolm.ai"
              className="text-accent-ink hover:underline"
            >
              dev@kolm.ai
            </a>{" "}
            and we will point you in the right direction.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/">Back to home</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/contact">Contact us</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
