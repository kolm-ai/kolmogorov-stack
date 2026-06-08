import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardKicker,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { CheckIcon, ShieldIcon, LogIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "For enterprise buyers",
  description:
    "You are vetting a vendor's autonomous agent. Do not take their word for it. Open their signed kolm report, verify it offline against their public key, and read every finding in the frameworks you already enforce. No account, no kolm server in the trust path.",
};

const FRAMEWORKS = [
  "SOC 2 TSC",
  "ISO 42001",
  "NIST AI RMF",
  "EU AI Act Art.12 · Art.14",
  "OWASP Agentic / LLM Top 10",
  "MITRE ATLAS",
];

const SITUATION = [
  {
    kicker: "It acts, it doesn’t just answer",
    title: "The blast radius is everything it can reach",
    body: "An agent runs on the scopes you grant it. If it holds more access than the job needs, often on one shared key, every one of those scopes is exposed the moment it is compromised or redirected.",
    map: "ASR-1 · least privilege",
  },
  {
    kicker: "A log you can edit is not evidence",
    title: "The trail has to survive an investigation",
    body: "When something goes wrong, you reconstruct it from the activity log. If that log can be changed after the fact, it cannot anchor an incident. You need it append-only and tamper-evident.",
    map: "ASR-2 · audit trail",
  },
  {
    kicker: "Confidence is not a control",
    title: "A polished answer is the vendor grading itself",
    body: "A questionnaire tells you what the vendor believes. It does not let you test a single claim. You are left to weigh how convincing the seller is, which is exactly the burden you want off your desk.",
    map: "ASR-6 · evidence",
  },
];

const COMPARE = [
  {
    kicker: "What you get today",
    title: "A questionnaire",
    body: "Self-attested answers in a spreadsheet. Already stale the moment it is signed, with no way to test a single line. The burden of proof lands on your team, every vendor, every renewal.",
  },
  {
    kicker: "What to require instead",
    title: "A signed evidence report",
    body: "One canonical object, signed with Ed25519, with the issuer's public key inside it. You open it, check the signature yourself, and trace each finding to a control. The proof travels with the document.",
  },
];

const REQUIRE = [
  "A signed report, not a slide or a spreadsheet",
  "The issuer's public key, so you can verify provenance, not just integrity",
  "Findings mapped to the frameworks you already enforce",
  "The scope statement carried inside the signed object, so you read exactly what was tested",
];

const CHECKS = [
  {
    kicker: "Tier 1 · signature",
    title: "Edit one field, the seal breaks",
    body: "The Ed25519 signature covers the canonical bytes of the report. Change a finding or inflate a score, and the signature no longer matches, in front of you. This is integrity.",
  },
  {
    kicker: "Tier 2 · issuer",
    title: "A rogue key clears Tier 1, fails Tier 2",
    body: "Issuer provenance is checked against the keyring you expect. A fresh forged key can sign a clean report and pass the math, but it is not the issuer you pinned, so Tier 2 exposes it.",
  },
  {
    kicker: "Offline · no server",
    title: "Nothing for anyone to fake",
    body: "Both checks run in-browser with WebCrypto. No account, no upload, no kolm server in the trust path. An asymmetric signature needs only the public key, and that key travels inside the report.",
  },
];

const CROSSWALK = [
  {
    id: "ASR-1",
    name: "Least privilege",
    checks: "Scopes the agent holds versus the scopes it uses",
    maps: "SOC 2 CC6 · OWASP ASI · NIST MANAGE-1",
  },
  {
    id: "ASR-2",
    name: "Audit trail",
    checks: "Append-only, hash-chained, retained activity log",
    maps: "EU AI Act Art.12 · SOC 2 CC7",
  },
  {
    id: "ASR-3",
    name: "Data egress",
    checks: "Destinations, approved sub-processors, redaction",
    maps: "OWASP LLM02 · EU AI Act Art.10",
  },
  {
    id: "ASR-4",
    name: "Injection",
    checks: "Instruction hijack, indirect injection, guardrail bypass",
    maps: "OWASP LLM01 · MITRE ATLAS",
  },
  {
    id: "ASR-5",
    name: "Provenance",
    checks: "Model and dependency provenance",
    maps: "ISO 42001 · NIST MAP-1",
  },
  {
    id: "ASR-6",
    name: "Evidence",
    checks: "Signed, logged, offline-verifiable report",
    maps: "SOC 2 CC7 · ISO 42001",
  },
];

const SCOPE_LINE =
  "Scope is contractual. Permission posture, redaction and audit-trail integrity are assessed. Injection is tested and reported, not warranted.";

function Crosswalk() {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[640px] border-collapse text-[14px]">
        <thead>
          <tr>
            {["Control", "What it checks", "Maps to"].map((h) => (
              <th
                key={h}
                scope="col"
                className="border-b border-line bg-paper-sink px-[15px] py-[15px] text-left font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink-3"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CROSSWALK.map((r) => (
            <tr key={r.id} className="hover:bg-paper-sink">
              <td className="border-b border-line px-[15px] py-[15px] align-top font-sans text-ink-2 [tr:last-child_&]:border-b-0">
                <b className="font-mono font-semibold text-ink">{r.id}</b>{" "}
                {r.name}
              </td>
              <td className="border-b border-line px-[15px] py-[15px] align-top font-sans text-ink-2 [tr:last-child_&]:border-b-0">
                {r.checks}
              </td>
              <td className="whitespace-nowrap border-b border-line px-[15px] py-[15px] align-top font-mono text-[12.5px] text-accent-text [tr:last-child_&]:border-b-0">
                {r.maps}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function EnterpriseBuyersPage() {
  return (
    <>
      {/* ============================== 1. HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(56px,7vw,96px)]">
          <div className="max-w-[70ch]">
            <h1 className="font-display text-[clamp(34px,5.4vw,56px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink">
              Don&rsquo;t take the vendor&rsquo;s word. Run the check yourself.
            </h1>
            <p className="mt-5 max-w-[66ch] font-sans text-[clamp(17px,1.5vw,20px)] leading-[1.55] text-ink-2">
              An autonomous agent is asking for access to your environment. A
              questionnaire moves the risk onto your desk. A signed evidence
              report does not. Open the vendor&rsquo;s kolm report, verify it
              offline against their public key, and read every finding in the
              frameworks you already enforce. No account, and no kolm server in
              the trust path.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <Link href="/verify">Verify a report</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/checks">See what we test</Link>
              </Button>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Verified offline, in your browser
              </span>
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Pinned to the issuer&rsquo;s key
              </span>
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Mapped to SOC 2, ISO 42001, NIST AI RMF, EU AI Act
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ============================== 2. PROOF STRIP ============================== */}
      <section className="border-b border-line" aria-label="Frameworks">
        <div className="mx-auto max-w-wrap px-6 py-12">
          <h2 className="sr-only">Mapped to the standards you cite</h2>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <Badge variant="verified">Ed25519-signed</Badge>
            <span className="inline-flex items-center gap-2.5 text-[13.5px] text-ink-2">
              <ShieldIcon className="h-4 w-4 flex-none text-ink-3" />
              Verified offline. Zero servers in the trust path
            </span>
            <span className="inline-flex items-center gap-2.5 text-[13.5px] text-ink-2">
              <LogIcon className="h-4 w-4 flex-none text-ink-3" />
              <Link
                className="border-b border-line-2 text-ink hover:border-ink"
                href="/transparency-log"
              >
                Append-only transparency log
              </Link>
            </span>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {FRAMEWORKS.map((f) => (
              <span key={f} className="ctrlid">
                {f}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 3. THE SITUATION ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">
              01 / You are vetting an autonomous agent
            </p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A new kind of thing is asking for access.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              This is not another SaaS integration. An agent holds credentials
              and acts on its own, calling tools and reading customer data
              without a human at each step. Three things change what your review
              has to confirm before it touches anything.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {SITUATION.map((s) => (
              <Card key={s.title}>
                <CardKicker>{s.kicker}</CardKicker>
                <CardTitle className="mt-2">{s.title}</CardTitle>
                <CardDescription className="mt-2">{s.body}</CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">{s.map}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 4. DEMAND EVIDENCE ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">02 / Demand evidence you can verify</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Ask for proof you can check, not answers you have to trust.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A questionnaire is point-in-time, unverifiable, and impossible to
              compare across vendors. Require an artifact that carries its own
              proof, so the question stops being whether you believe the vendor
              and becomes whether the math checks out.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {COMPARE.map((c) => (
              <Card key={c.title}>
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2">{c.body}</CardDescription>
              </Card>
            ))}
          </div>
          <ul className="mt-8 grid gap-2.5">
            {REQUIRE.map((r) => (
              <li
                key={r}
                className="flex items-start gap-2 text-[15px] text-ink-2"
              >
                <CheckIcon className="mt-[5px] h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ============================== 5. HOW TO CHECK A REPORT ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">
              03 / How to check a kolm report
            </p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Two checks. Your browser. No server.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              Verification is two tiers, and both run on WebCrypto in your own
              browser. One confirms the bytes are intact. The other confirms who
              signed them. kolm is never in the path, so there is nothing for
              anyone to fake.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {CHECKS.map((c) => (
              <Card key={c.kicker} ledger>
                <CardKicker className="text-on-ink-3">{c.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">{c.title}</CardTitle>
                <CardDescription className="mt-2 text-on-ink-2">
                  {c.body}
                </CardDescription>
              </Card>
            ))}
          </div>
          <div className="mt-12 flex flex-wrap gap-3">
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/verify">Verify a report</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <a href="/sample-audit-report.json" download>
                Download a sample
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* ============================== 6. THE CROSSWALK ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">04 / What the crosswalk tells you</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Every finding lands in a control you already enforce.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              You should not have to translate a vendor&rsquo;s terms into yours.
              Six agent-security controls map directly to the frameworks your
              review group already cites, so a reviewer traces each result to a
              standard without leaving the report.
            </p>
          </div>
          <Crosswalk />
          <p className="mt-6 max-w-[72ch] text-[13px] leading-[1.6] text-ink-3">
            {SCOPE_LINE}
          </p>
        </div>
      </section>

      {/* ============================== 7. FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Require evidence, not assurances.
          </h2>
          <p className="mx-auto mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            Make &ldquo;show me, don&rsquo;t tell me&rdquo; the default for every
            agent entering your environment. Open a signed report and check it
            yourself, in your own browser.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/verify">Verify a report</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/contact">Talk to us</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
