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
import { CheckIcon, ShieldIcon, LogIcon, KeyIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "For healthcare AI vendors",
  description:
    "The moment your agent can read PHI, a health system's security and privacy review stops accepting a questionnaire. Hand them a signed evidence report they verify offline - a Business Associate Agreement, PHI minimized and redacted before egress, and a tamper-evident audit trail, mapped to the HIPAA Security Rule and ISO 42001.",
};

const FRAMEWORKS = [
  "HIPAA Security Rule",
  "BAA",
  "ISO 42001",
  "NIST AI RMF",
  "OWASP LLM / Agentic Top 10",
  "MITRE ATLAS",
];

const TRUST = [
  "Ed25519-signed",
  "BAA available",
  "PHI redaction tested and reported",
];

const METRICS = [
  {
    n: "4 to 8 wks",
    l: "how long a PHI-touching agent review runs once security and privacy reviewers are both in the loop",
  },
  {
    n: "2 reviews",
    l: "the security assessment and the privacy assessment, each asking for evidence a questionnaire cannot give",
  },
  {
    n: "Days",
    l: "the same review when you hand over a signed report and a Business Associate Agreement",
  },
];

const ASKS = [
  {
    kicker: "Minimum necessary",
    title: "Minimum-necessary access to PHI",
    body: "An agent that can read protected health information is judged by everything its credentials can reach. Reviewers flag every scope it holds but never uses, and any access that exceeds the minimum the job needs.",
    map: "ASR-1 · least privilege",
    icon: ShieldIcon,
  },
  {
    kicker: "Audit controls",
    title: "Audit controls that survive an investigation",
    body: "The HIPAA Security Rule expects a record of activity on systems that handle PHI. That trail has to be append-only and tamper-evident, because a log you can edit after the fact cannot anchor a breach inquiry.",
    map: "ASR-2 · audit trail",
    icon: LogIcon,
  },
  {
    kicker: "PHI redaction",
    title: "PHI redacted before it leaves the boundary",
    body: "Every egress destination is enumerated and every sub-processor accounted for, and identifying fields are redacted before any data crosses the boundary. The privacy reviewer reads exactly where PHI can go.",
    map: "ASR-3 · data egress",
    icon: KeyIcon,
  },
  {
    kicker: "Business associate",
    title: "A BAA and a clean sub-processor chain",
    body: "A health system needs a Business Associate Agreement in place and a clear list of who else touches the data. kolm signs a BAA, and the report names the sub-processors so the chain is legible end to end.",
    map: "ASR-6 · evidence",
    icon: CheckIcon,
  },
];

const HANDOFF = [
  {
    title: "One canonical, signed object",
    body: "Key-sorted, whitespace-free JSON, signed with Ed25519. The signature covers these exact bytes, so a downgraded finding or an inflated score is self-evident the instant the reviewer checks it.",
  },
  {
    title: "Your key travels in the report",
    body: "The signature and the public key it was made with ship together. The health system's team needs nothing from us: the verifier runs offline against the key inside the report, no account, no upload.",
  },
  {
    title: "Framework crosswalk for privacy and security",
    body: "Every finding maps to the HIPAA Security Rule and ISO 42001, so the security reviewer and the privacy officer each read results in the vocabulary they already enforce.",
  },
];

const CROSSWALK = [
  {
    id: "ASR-1",
    name: "Least privilege",
    checks: "Scopes the agent holds versus the scopes it uses",
    maps: "HIPAA 164.312(a) · 164.502(b) minimum necessary · SOC 2 CC6",
  },
  {
    id: "ASR-2",
    name: "Audit trail",
    checks: "Append-only, hash-chained, retained activity log",
    maps: "HIPAA 164.312(b) audit controls · SOC 2 CC7",
  },
  {
    id: "ASR-3",
    name: "Data egress",
    checks: "Destinations, approved sub-processors, PHI redaction",
    maps: "HIPAA 164.514 de-identification · OWASP LLM02",
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
    maps: "HIPAA 164.308 risk management · ISO 42001",
  },
];

export default function HealthcarePage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">For healthcare AI vendors</p>
          <h1 className="max-w-[20ch] font-display text-[clamp(36px,5.6vw,60px)] font-extrabold leading-[1.0] tracking-[-0.035em] text-ink">
            Your agent can read PHI. The health system&rsquo;s security review
            stopped.
          </h1>
          <p className="mt-6 max-w-[58ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
            The moment an autonomous agent can read PHI, a hospital&rsquo;s
            security and privacy reviewers stop accepting a questionnaire. They
            want a Business Associate Agreement, evidence that PHI is minimized
            and redacted before it leaves your boundary, and an audit trail they
            can trust. kolm signs that evidence into a report they verify
            offline, against your own key, mapped to the HIPAA Security Rule and
            ISO 42001. The review compresses back to days.
          </p>

          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/signup">Start free</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/contact">Talk to us</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/sample">See a sample report</Link>
            </Button>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
            {TRUST.map((t) => (
              <span key={t} className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                {t}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ====================== FRAMEWORK STRIP ====================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-12">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="verified">Mapped to</Badge>
            {FRAMEWORKS.map((f) => (
              <span key={f} className="ctrlid">
                {f}
              </span>
            ))}
          </div>
          <p className="mt-5 max-w-[74ch] text-[13.5px] leading-relaxed text-ink-3">
            kolm maps your agent&rsquo;s controls to the HIPAA Security Rule and
            ISO 42001 and will sign a Business Associate Agreement. It does not
            issue a HIPAA certification or an audit opinion, and it tests and
            reports PHI redaction and injection resistance rather than
            warranting them.
          </p>
        </div>
      </section>

      {/* ============================ THE STALL =========================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / The stall</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A health system will not take your word for it.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              The day your agent can read PHI, a one-week review runs four to
              eight. Security and privacy each open their own assessment, and a
              filled-in questionnaire proves nothing either of them can verify.
            </p>
          </div>
          <dl className="grid gap-4 sm:grid-cols-3">
            {METRICS.map((m) => (
              <div
                key={m.l}
                className="rounded-lg border border-line bg-card p-5"
              >
                <dt className="font-display text-[clamp(26px,3vw,34px)] font-extrabold leading-none tracking-[-0.03em] text-ink">
                  {m.n}
                </dt>
                <dd className="mt-3 text-[14px] leading-relaxed text-ink-2">
                  {m.l}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ====================== WHAT THE REVIEWER ASKS ===================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">02 / What the reviewer asks</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Four questions a healthcare reviewer will not skip.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Each maps to a control your buyer already enforces, and each is
              answered with a signed finding rather than a sentence you wrote.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {ASKS.map((a) => (
              <Card key={a.title}>
                <a.icon className="h-5 w-5 text-[var(--accent)]" />
                <CardKicker className="mt-3">{a.kicker}</CardKicker>
                <CardTitle className="mt-2">{a.title}</CardTitle>
                <CardDescription className="mt-2">{a.body}</CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">{a.map}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ===================== THE SIGNED REPORT (LEDGER) ================= */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">03 / The report</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              What you hand the security and privacy reviewers.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              Not a promise. One canonical object, signed with Ed25519, mapped
              to the controls the review group already cites.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {HANDOFF.map((h) => (
              <Card key={h.title} ledger>
                <span className="font-sans text-[18px] font-semibold text-on-ink">
                  {h.title}
                </span>
                <p className="mt-2 text-[14px] leading-relaxed text-on-ink-2">
                  {h.body}
                </p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ CROSSWALK =========================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-10 max-w-[66ch]">
            <p className="eyebrow mb-3">04 / The crosswalk</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Every finding lands in a control your buyer already enforces.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Six agent-security controls map directly to the HIPAA Security
              Rule and ISO 42001, so a finding never needs translating before
              the privacy officer reads it.
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-paper-2">
                  <th className="px-4 py-3 font-sans text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                    Control
                  </th>
                  <th className="px-4 py-3 font-sans text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                    What it checks
                  </th>
                  <th className="px-4 py-3 font-sans text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                    Maps to
                  </th>
                </tr>
              </thead>
              <tbody>
                {CROSSWALK.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-line align-top last:border-0"
                  >
                    <td className="px-4 py-3 text-[14px] text-ink">
                      <b className="font-semibold">{r.id}</b> {r.name}
                    </td>
                    <td className="px-4 py-3 text-[14px] text-ink-2">
                      {r.checks}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12.5px] text-accent-text">
                      {r.maps}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-5 max-w-[80ch] text-[14px] leading-relaxed text-ink-3">
            Scope is contractual. Permission posture, redaction and audit-trail
            integrity are assessed. Injection is tested and reported, not
            warranted.
          </p>
        </div>
      </section>

      {/* ============================ CTA FINAL =========================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[22ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Clear the healthcare security review in days.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            A scoped audit, a signed evidence report, a Business Associate
            Agreement, and evidence the health system verifies for themselves,
            instead of a questionnaire they take on faith.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/signup">Start free</Link>
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
