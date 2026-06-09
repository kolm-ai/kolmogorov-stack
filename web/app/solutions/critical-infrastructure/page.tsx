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
  title: "For critical-infrastructure AI vendors",
  description:
    "An agent near energy, water, transportation or communications is treated as high-risk, by the operator's security team and, under the EU AI Act, by law. Hand them a signed evidence report they verify offline - tamper-evident logging and adversarial resistance proven, mapped to the NIST AI RMF Profile for Critical Infrastructure, EU AI Act high-risk obligations and MITRE ATLAS.",
};

const FRAMEWORKS = [
  "NIST AI RMF · Critical-Infrastructure Profile",
  "EU AI Act high-risk",
  "MITRE ATLAS",
  "SOC 2",
  "ISO 42001",
  "OWASP Agentic Top 10",
];

const TRUST = [
  "Ed25519-signed",
  "Tamper-evident logging assessed",
  "Adversarial resistance tested and reported",
];

const METRICS = [
  {
    n: "High-risk",
    l: "how an agent near critical systems is classified, by the operator and, under the EU AI Act, by law",
  },
  {
    n: "4 to 8 wks",
    l: "how long an operational-technology security review runs once an autonomous agent is in scope",
  },
  {
    n: "Days",
    l: "the same review when adversarial resistance and logging are proven in a signed report",
  },
];

const ASKS = [
  {
    kicker: "Least privilege",
    title: "Least privilege at the edge of operations",
    body: "An agent that can reach operational systems is judged by everything its credentials can touch. Reviewers flag every scope it holds but never uses, and any key shared across a trust boundary that should not be crossed.",
    map: "ASR-1 · least privilege",
    icon: ShieldIcon,
  },
  {
    kicker: "Record-keeping",
    title: "Tamper-evident logging the regulator expects",
    body: "EU AI Act Article 12 requires high-risk systems to keep automatic records over their lifetime. That trail has to be append-only and hash-chained, because a log that can be rewritten cannot anchor an incident review.",
    map: "ASR-2 · audit trail",
    icon: LogIcon,
  },
  {
    kicker: "Adversarial resistance",
    title: "Injection and adversarial resistance, tested",
    body: "A critical-systems reviewer wants prompt injection, indirect injection and guardrail bypass exercised against the agent, with reproductions, and scored against MITRE ATLAS. kolm tests and reports these; it does not warrant the agent immune.",
    map: "ASR-4 · injection",
    icon: KeyIcon,
  },
  {
    kicker: "Supply chain",
    title: "Provenance for every model and dependency",
    body: "A high-risk deployment needs to know what is inside the agent. The report enumerates model and dependency provenance, so the operator can place your agent in their supply-chain and risk records.",
    map: "ASR-5 · provenance",
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
    body: "The signature and the public key it was made with ship together. The operator's team needs nothing from us: the verifier runs offline against the key inside the report, no account, no upload.",
  },
  {
    title: "A high-risk red-team battery, reproduced",
    body: "Full Readiness runs the prompt-injection battery with reproductions and a MITRE ATLAS mapping, so the operator reads each adversarial result against the threat model they already use.",
  },
];

const CROSSWALK = [
  {
    id: "ASR-1",
    name: "Least privilege",
    checks: "Scopes the agent holds versus the scopes it uses",
    maps: "NIST MANAGE-1 · SOC 2 CC6 · OWASP ASI",
  },
  {
    id: "ASR-2",
    name: "Audit trail",
    checks: "Append-only, hash-chained, retained activity log",
    maps: "EU AI Act Art.12 record-keeping · SOC 2 CC7",
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
    maps: "MITRE ATLAS · OWASP LLM01 · NIST MEASURE-2",
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
    maps: "EU AI Act Art.14 oversight · SOC 2 CC7",
  },
];

export default function CriticalInfrastructurePage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">For critical-infrastructure AI vendors</p>
          <h1 className="max-w-[20ch] font-display text-[clamp(36px,5.6vw,60px)] font-extrabold leading-[1.0] tracking-[-0.035em] text-ink">
            Your agent runs near operational systems. The operator&rsquo;s
            security review stopped.
          </h1>
          <p className="mt-6 max-w-[58ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
            An agent that touches energy, water, transportation, communications
            or other critical systems is treated as high-risk, by the
            operator&rsquo;s security team and, under the EU AI Act, by law.
            Reviewers cite the NIST AI RMF Profile for Critical Infrastructure,
            the EU AI Act high-risk obligations and MITRE ATLAS, and they want
            adversarial resistance and tamper-evident logging proven, not
            asserted. kolm signs that evidence into a report they verify
            offline, against your own key. The review compresses back to days.
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
            kolm maps your agent&rsquo;s controls to the NIST AI RMF
            Critical-Infrastructure Profile, the EU AI Act high-risk obligations
            and MITRE ATLAS. It does not issue a certification or an audit
            opinion, and it tests and reports injection and adversarial
            resistance rather than warranting the agent immune.
          </p>
        </div>
      </section>

      {/* ============================ THE STALL =========================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / The stall</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A critical-infrastructure operator will not take your word for it.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              The day your agent can reach an operational system, the review is
              held to a high-risk bar. The operator wants adversarial testing
              and tamper-evident logging demonstrated, and a questionnaire
              demonstrates neither.
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
              Four questions a high-risk reviewer will not skip.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Each maps to a control the operator already enforces, and each is
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
              What you hand the operator&rsquo;s security team.
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
              Every finding lands in a control the operator already enforces.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Six agent-security controls map directly to the NIST AI RMF, the
              EU AI Act high-risk obligations and MITRE ATLAS, so a finding never
              needs translating.
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
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Clear the high-risk security review in days.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            A scoped audit, a red-team battery with reproductions, and a signed
            evidence report the operator verifies for themselves, instead of a
            questionnaire they take on faith.
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
