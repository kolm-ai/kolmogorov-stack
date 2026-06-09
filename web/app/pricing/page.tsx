import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardKicker } from "@/components/ui/card";
import { CheckIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Flat, public prices. Scan free, hand your buyer a signed readiness report for $750, keep your evidence current from $299 a month, a full readiness audit at $15,000, continuous-plus at $3,500 a month, or a named co-signed attestation at $25,000. No quote, no per-seat meter, no contingency.",
};

type CtaVariant = "primary" | "ghost";

interface Tier {
  name: string;
  price: string;
  unit?: string;
  sub: string;
  features: string[];
  cta: { label: string; href: string; variant: CtaVariant };
  featured?: boolean;
  badge?: string;
}

const SELF_SERVE: Tier[] = [
  {
    name: "Free Scan",
    price: "Free",
    sub: "Run the full audit. See every finding before you pay.",
    features: [
      "Deterministic audit of your agent from its logs, across every control.",
      "Each finding mapped to SOC 2, ISO 42001, NIST AI RMF, the EU AI Act, OWASP LLM Top 10, and MITRE ATLAS.",
      "Watermarked preview report (not signed).",
      "No account needed to read your results.",
    ],
    cta: { label: "Run the free scan", href: "/signup", variant: "ghost" },
  },
  {
    name: "Signed Readiness Report",
    price: "$750",
    unit: "one-time",
    sub: "The same audit, signed. Your buyer verifies it offline.",
    features: [
      "Ed25519-signed evidence report tied to a stable report ID.",
      "Your buyer verifies the signature against your public key, in the browser, with no kolm server in the path.",
      "Full framework crosswalk included.",
      "A public Trust link you can send with the deal.",
    ],
    cta: { label: "Get the signed report", href: "/signup", variant: "primary" },
    featured: true,
    badge: "Most popular",
  },
  {
    name: "Continuous Starter",
    price: "$299",
    unit: "/mo",
    sub: "Keep the report current. Re-attested every week.",
    features: [
      "Everything in the Signed Readiness Report.",
      "Re-attested weekly, so evidence does not go stale during a review.",
      "One agent, one public Trust link.",
      "A fresh signed report on every re-attestation.",
    ],
    cta: { label: "Subscribe", href: "/signup", variant: "ghost" },
  },
  {
    name: "Continuous Growth",
    price: "$999",
    unit: "/mo",
    sub: "Evidence as fresh as your last release.",
    features: [
      "Everything in Continuous Starter.",
      "Re-attested on every deploy, not on a weekly clock.",
      "Prompt-injection regression on every release, so a new build cannot quietly reopen a closed finding.",
      "Your full agent fleet under one buyer portal.",
    ],
    cta: { label: "Subscribe", href: "/signup", variant: "ghost" },
  },
];

const REVIEWED: Tier[] = [
  {
    name: "Full Readiness",
    price: "$15,000",
    unit: "flat",
    sub: "We run the audit with you and help close the gaps.",
    features: [
      "A guided engagement across your full control set and agent fleet.",
      "Remediation guidance for every finding before you sign.",
      "Signed Readiness Report plus a buyer portal delivered at the end.",
      "Continuous re-attestation for the duration of the engagement.",
    ],
    // Self-serve: a new user signs up, then completes the $15,000 purchase via
    // POST /v1/audit/package/checkout. The next= param carries the chosen package.
    cta: { label: "Buy Full Readiness", href: "/signup?next=full", variant: "primary" },
  },
  {
    name: "Continuous-Plus",
    price: "$3,500",
    unit: "/mo",
    sub: "Continuous re-attestation across the full control set, with priority.",
    features: [
      "Everything in Full Readiness, re-run continuously.",
      "Your full control set re-attested on schedule.",
      "Priority review queue.",
      "Named technical contact.",
    ],
    cta: { label: "Start Continuous-Plus", href: "/signup?next=plus", variant: "ghost" },
  },
  {
    name: "Reviewed Attestation",
    price: "$25,000",
    unit: "flat",
    sub: "A named human reviewer co-signs the report.",
    features: [
      "Everything in Full Readiness.",
      "A named human reviewer co-signs the report alongside the cryptographic signature.",
      "Two-tier verdict: the Ed25519 signature plus issuer provenance.",
      "The strongest artifact kolm produces for a high-stakes review.",
    ],
    cta: { label: "Talk to us", href: "mailto:dev@kolm.ai", variant: "primary" },
    badge: "Reviewer-backed",
  },
  {
    name: "Enterprise",
    price: "Contact",
    sub: "MSA, custom scope, SAML and BAA. For programs with their own paper.",
    features: [
      "Everything in Reviewed Attestation.",
      "Master service agreement and custom scope.",
      "SAML SSO, SCIM, BAA on request.",
      "Dedicated reviewer and roadmap input.",
    ],
    cta: { label: "Talk to us", href: "/contact", variant: "ghost" },
  },
];

function TierCard({ tier }: { tier: Tier }) {
  return (
    <Card
      className={
        tier.featured
          ? "border-accent-edge shadow-[0_24px_60px_-40px_rgba(17,135,90,0.5)]"
          : ""
      }
    >
      <div className="flex items-center justify-between gap-2">
        <CardKicker>{tier.name}</CardKicker>
        {tier.badge && <Badge variant="verified">{tier.badge}</Badge>}
      </div>
      <p className="mt-2 font-display text-[40px] font-extrabold leading-none tracking-[-0.03em] text-ink">
        {tier.price}
        {tier.unit && (
          <span className="ml-1 align-baseline font-sans text-[15px] font-medium text-ink-3">
            {tier.unit}
          </span>
        )}
      </p>
      <p className="mt-2 min-h-[44px] text-[14px] leading-snug text-ink-2">
        {tier.sub}
      </p>
      <Button
        asChild
        variant={tier.cta.variant}
        className="mt-4 w-full"
      >
        <Link href={tier.cta.href}>{tier.cta.label}</Link>
      </Button>
      <ul className="mt-5 grid gap-2.5">
        {tier.features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-[14px] text-ink-2">
            <CheckIcon className="mt-[5px] h-3.5 w-3.5 flex-none text-[var(--accent)]" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function PricingPage() {
  return (
    <>
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(56px,7vw,96px)]">
          <p className="eyebrow mb-4">Pricing</p>
          <h1 className="max-w-[20ch] font-display text-[clamp(38px,6vw,60px)] font-extrabold leading-[1.0] tracking-[-0.035em] text-ink">
            Flat, public prices. No quote, no contingency.
          </h1>
          <p className="mt-6 max-w-[58ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
            Scan for free, hand your buyer a signed readiness report for $750,
            or keep your evidence current from $299 a month. When an enterprise
            reviewer wants a person to stand behind the report, add a named
            co-signer. The only thing you pay for is evidence your buyer can verify.
          </p>
        </div>
      </section>

      {/* self-serve ladder */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[72px]">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-2">
            <h2 className="font-display text-[28px] font-bold tracking-[-0.028em] text-ink">
              Self-serve. No human in the loop.
            </h2>
            <p className="text-[14px] text-ink-3">
              Flat fees. No call to book.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {SELF_SERVE.map((t) => (
              <TierCard key={t.name} tier={t} />
            ))}
          </div>
        </div>
      </section>

      {/* reviewed + enterprise */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[72px]">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-2">
            <h2 className="font-display text-[28px] font-bold tracking-[-0.028em] text-on-ink">
              Reviewer-backed. A person stands behind it.
            </h2>
            <p className="text-[14px] text-on-ink-3">
              Your full control set. SLA-bounded. Days, not weeks.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {REVIEWED.map((tier) => (
              <Card
                key={tier.name}
                ledger
                className={
                  tier.badge
                    ? "border-[var(--accent-on-ink-edge)]"
                    : undefined
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <CardKicker className="text-on-ink-3">{tier.name}</CardKicker>
                  {tier.badge && (
                    <Badge
                      variant="default"
                      className="border-[var(--accent-on-ink-edge)] text-on-ink"
                    >
                      {tier.badge}
                    </Badge>
                  )}
                </div>
                <p className="mt-2 font-display text-[36px] font-extrabold leading-none tracking-[-0.03em] text-on-ink">
                  {tier.price}
                  {tier.unit && (
                    <span className="ml-1 align-baseline font-sans text-[14px] font-medium text-on-ink-3">
                      {tier.unit}
                    </span>
                  )}
                </p>
                <p className="mt-2 min-h-[44px] text-[14px] leading-snug text-on-ink-2">
                  {tier.sub}
                </p>
                <Button
                  asChild
                  variant="ghost"
                  className="mt-4 w-full border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
                >
                  <Link href={tier.cta.href}>{tier.cta.label}</Link>
                </Button>
                <ul className="mt-5 grid gap-2.5">
                  {tier.features.map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2 text-[14px] text-on-ink-2"
                    >
                      <CheckIcon className="mt-[5px] h-3.5 w-3.5 flex-none text-[var(--accent-on-ink)]" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* note */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-wrap px-6 py-[64px]">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardKicker>No contingency</CardKicker>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
                Every price on this page is the whole price. No percentage of
                your deal, no surprise true-up. The automated tiers need no
                human; the Full Readiness, Continuous-Plus and Reviewed
                Attestation tiers add one, on purpose.
              </p>
            </Card>
            <Card>
              <CardKicker>Why pay monthly?</CardKicker>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
                A point-in-time report goes stale on your next deploy. A
                permission you granted in January can still fire in August.
                Continuous re-attests on a schedule, so the evidence your buyer
                checks is never older than your last release. Questions?{" "}
                <a
                  className="border-b border-line-2 text-ink hover:border-ink"
                  href="mailto:dev@kolm.ai"
                >
                  dev@kolm.ai
                </a>
                .
              </p>
            </Card>
          </div>
        </div>
      </section>
    </>
  );
}
