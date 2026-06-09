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
import { CheckIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "What we test",
  description:
    "kolm tests your AI agent across eight controls, from least privilege to multi-agent delegation. Each finding maps to SOC 2, ISO 42001, NIST AI RMF, the EU AI Act, OWASP LLM Top 10, and MITRE ATLAS, traces to the crosswalk, and ships in a signed report your buyer verifies offline.",
};

const FRAMEWORKS = [
  "SOC 2",
  "ISO 42001",
  "NIST AI RMF",
  "EU AI Act",
  "OWASP LLM Top 10",
  "MITRE ATLAS",
];

const FLAGS = [
  {
    kicker: "Over-permissioned",
    title: "More access than the job needs",
    body: "An agent that holds far more scopes than it uses, often on one shared key, is the first thing a reviewer circles. We surface the gap with the calls that prove it.",
    map: "ASR-1 / least privilege",
  },
  {
    kicker: "Editable trail",
    title: "A log nobody can trust",
    body: "If the activity record can be changed after the fact, it is not evidence. A reviewer wants it append-only and hash-chained.",
    map: "ASR-2 / audit trail",
  },
  {
    kicker: "Unredacted egress",
    title: "Data that leaves in the clear",
    body: "Where the agent sends data, and whether sensitive fields are masked before they leave, is what a reviewer checks before signing off.",
    map: "ASR-3 / data egress",
  },
];

const PILLARS = [
  {
    kicker: "Pillar 01 / Permissions",
    title: "Least privilege",
    body: "Scopes the agent holds versus the scopes it actually uses. Shared keys, standing grants, and high-impact actions reachable without a confirmation are surfaced with the calls that prove them.",
    map: "ASR-1 maps to SOC 2 CC6",
  },
  {
    kicker: "Pillar 02 / Audit trail",
    title: "A record that cannot be edited",
    body: "Whether agent activity is logged append-only, hash-chained, and retained, so the record a reviewer reads is the record that happened, not one rewritten after the fact.",
    map: "ASR-2 maps to EU AI Act Art.12",
  },
  {
    kicker: "Pillar 03 / Data egress",
    title: "Where data goes, and what is masked",
    body: "Every destination the agent can reach, the approved sub-processors behind them, and proof that sensitive fields are redacted before they leave the boundary.",
    map: "ASR-3 maps to OWASP LLM02",
  },
  {
    kicker: "Pillar 04 / Injection",
    title: "Can it be talked out of its rules",
    body: "Direct and indirect prompt injection, guardrail bypass, and system-prompt extraction, run as a battery with reproductions a reviewer can replay. Tested and reported, not warranted.",
    map: "ASR-4 maps to OWASP LLM01",
  },
];

const CROSSWALK: { ctrl: string; name: string; checks: string; maps: string }[] =
  [
    {
      ctrl: "ASR-1",
      name: "Least privilege",
      checks: "Scopes the agent holds versus the scopes it uses",
      maps: "SOC 2 CC6, OWASP ASI, NIST MANAGE-1",
    },
    {
      ctrl: "ASR-2",
      name: "Audit trail",
      checks: "Append-only, hash-chained, retained activity log",
      maps: "EU AI Act Art.12, SOC 2 CC7",
    },
    {
      ctrl: "ASR-3",
      name: "Data egress",
      checks: "Destinations, approved sub-processors, redaction",
      maps: "OWASP LLM02, EU AI Act Art.10",
    },
    {
      ctrl: "ASR-4",
      name: "Injection",
      checks: "Instruction hijack, indirect injection, guardrail bypass",
      maps: "OWASP LLM01, MITRE ATLAS",
    },
    {
      ctrl: "ASR-5",
      name: "Provenance",
      checks: "Model and dependency provenance, MCP and vendor surface",
      maps: "ISO 42001, NIST MAP-4, OWASP LLM05",
    },
    {
      ctrl: "ASR-6",
      name: "Evidence",
      checks: "Signed, logged, offline-verifiable report",
      maps: "SOC 2 CC7, ISO 42001",
    },
    {
      ctrl: "ASR-7",
      name: "Memory and retrieval integrity",
      checks: "Retrieval sources trusted, memory writes attributed",
      maps: "OWASP LLM08, NIST MEASURE-2",
    },
    {
      ctrl: "ASR-8",
      name: "Multi-agent delegation",
      checks: "Each handoff attributable and scope-attenuated",
      maps: "OWASP ASI, NIST GOVERN-3",
    },
  ];

const ASSESSED = [
  "Permission posture against what the agent actually uses",
  "Redaction of sensitive fields before egress",
  "Audit-trail integrity, append-only and hash-chained",
];

export default function ChecksPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <div className="max-w-[70ch]">
            <h1 className="font-display text-[clamp(34px,5.2vw,56px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink">
              What a reviewer flags, tested and named to a control.
            </h1>
            <p className="mt-5 max-w-[62ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A security reviewer works a checklist: what your agent can touch, what
              it records, where data goes, and whether it can be talked out of its
              instructions. kolm tests each one. It maps every finding to a control
              and to the standard your buyer cites, then signs the report. The report
              states what was tested and what was not.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-2.5">
              {FRAMEWORKS.map((f) => (
                <span key={f} className="ctrlid">
                  {f}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ===================== WHAT A REVIEWER FLAGS ===================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / What a reviewer flags</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              The findings a reviewer circles first.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Once your agent can touch customer data and act on its own, a security
              review can run four to eight weeks. The reviewer stops reading your
              answers and asks for evidence. These are the findings they circle
              first.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {FLAGS.map((f) => (
              <Card key={f.kicker}>
                <CardKicker>{f.kicker}</CardKicker>
                <CardTitle className="mt-2">{f.title}</CardTitle>
                <CardDescription className="mt-2">{f.body}</CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">{f.map}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ========================= THE FOUR PILLARS ====================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">02 / The four pillars</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Four pillars. Every check has a control behind it.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              We test what a reviewer tests: what the agent can touch, what it
              records, where data goes, and whether it can be turned against its
              instructions. Each pillar carries a control id you can trace to the
              crosswalk below.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {PILLARS.map((p) => (
              <Card key={p.kicker}>
                <CardKicker>{p.kicker}</CardKicker>
                <CardTitle className="mt-2">{p.title}</CardTitle>
                <CardDescription className="mt-2">{p.body}</CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">{p.map}</p>
              </Card>
            ))}
          </div>
          <p className="mt-10 max-w-[64ch] text-[13px] leading-[1.6] text-ink-3">
            Four more controls round out the catalog.{" "}
            <b className="font-semibold text-ink-2">ASR-5 provenance</b>,{" "}
            <b className="font-semibold text-ink-2">ASR-6 evidence</b>,{" "}
            <b className="font-semibold text-ink-2">
              ASR-7 memory and retrieval integrity
            </b>
            , and{" "}
            <b className="font-semibold text-ink-2">
              ASR-8 multi-agent delegation
            </b>{" "}
            extend the four pillars into the supply chain, the report itself,
            retrieval, and agent-to-agent handoffs. All eight appear in the
            crosswalk.
          </p>
        </div>
      </section>

      {/* ====================== THE CROSSWALK (LEDGER) =================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">03 / The crosswalk</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Eight controls, mapped to the standard your buyer cites.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              ASR-1 through ASR-8. Each row is one control, what it checks, and the
              framework a review group already uses. Every finding in the signed
              report points back to a row here, so a reviewer traces each result to
              a standard, not to our word.
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-[var(--line-ink)]">
            <table className="w-full min-w-[640px] border-collapse text-[14px]">
              <thead>
                <tr>
                  {["Control", "What it checks", "Maps to"].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="border-b border-[var(--line-ink)] bg-[var(--ink-deep-sink)] p-[15px] text-left font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-on-ink-3"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CROSSWALK.map((r, i) => (
                  <tr key={r.ctrl}>
                    <td
                      className={`p-[15px] align-top text-on-ink-2 ${i < CROSSWALK.length - 1 ? "border-b border-[var(--line-ink)]" : ""}`}
                    >
                      <b className="font-mono font-semibold text-on-ink">
                        {r.ctrl}
                      </b>{" "}
                      {r.name}
                    </td>
                    <td
                      className={`p-[15px] align-top text-on-ink-2 ${i < CROSSWALK.length - 1 ? "border-b border-[var(--line-ink)]" : ""}`}
                    >
                      {r.checks}
                    </td>
                    <td
                      className={`whitespace-nowrap p-[15px] align-top font-mono text-[12.5px] text-[var(--accent-on-ink)] ${i < CROSSWALK.length - 1 ? "border-b border-[var(--line-ink)]" : ""}`}
                    >
                      {r.maps}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-10 max-w-[64ch] text-[13px] leading-[1.6] text-on-ink-3">
            The mapping travels inside the signed object. Open the report, follow
            any finding to its control, and follow that control to the framework
            clause the reviewer reads from.
          </p>
        </div>
      </section>

      {/* ===================== WHAT WE DO NOT WARRANT ==================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">04 / What we do not warrant</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              What we assess, and what we will not claim.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              An accurate report names its edges. We are precise about what is
              assessed, what is only tested and reported, and where the line sits.
              The scope statement is part of the signed object, so a reviewer reads
              it with the findings.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardKicker>Assessed</CardKicker>
              <CardTitle className="mt-2">Stated as a posture</CardTitle>
              <ul className="mt-4 grid gap-[11px]">
                {ASSESSED.map((a) => (
                  <li
                    key={a}
                    className="flex items-start gap-2.5 text-[15px] leading-[1.5] text-ink-2"
                  >
                    <CheckIcon className="mt-1 h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardKicker>Tested and reported</CardKicker>
              <CardTitle className="mt-2">Shown, not promised</CardTitle>
              <CardDescription className="mt-2">
                Injection is run as a battery with reproductions a reviewer can
                replay. We report what held and what did not. We do not warrant
                that the agent is secure, and you should distrust anyone who does.
              </CardDescription>
              <p className="mt-4 font-mono text-[12px] text-ink-3">
                ASR-4 / OWASP LLM01 / MITRE ATLAS
              </p>
            </Card>
          </div>
          <Card className="mt-6">
            <CardKicker>Scope, verbatim in the report</CardKicker>
            <p className="mt-3 font-mono text-[14px] leading-[1.7] text-ink-2">
              Scope is contractual. Permission posture, redaction and audit-trail
              integrity are assessed. Injection is tested and reported, not
              warranted.
            </p>
          </Card>
        </div>
      </section>

      {/* ============================ CTA FINAL ========================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[22ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Run these checks against your agent.
          </h2>
          <p className="mx-auto mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            Eight controls, each finding mapped to a framework your buyer cites,
            ending in a signed report they verify offline.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/signup">Run the free scan</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/report">See a sample report</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
