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
  title: "Research",
  description:
    "How kolm assesses agent security. The ASR control framework, the adversarial prompt-injection battery (tested and reported, not warranted), and the Ed25519 signing and Merkle transparency-log design. Published openly, mapped to the standards your buyer already cites.",
};

const HERO_TRUST = [
  "Method published openly",
  "Mapped, not invented",
  "ASR published CC0",
];

const APPROACH = [
  {
    kicker: "Inspect, not trust",
    title: "The verifier is open",
    body: "The verification library, the canonicalization, and the command-line tool are open and reproducible. A reviewer can check the result and the thing that produced it, in their own environment.",
  },
  {
    kicker: "Mapped, not invented",
    title: "Standards reviewers already cite",
    body: "We do not ask a buyer to learn a new credential. Every check translates to OWASP, MITRE ATLAS, NIST AI RMF and the EU AI Act. ASR is deliberately not a rival certification.",
  },
  {
    kicker: "Scope over spin",
    title: "Stated plainly",
    body: "What is tested is named. What is reported, not warranted, is named too. The scope statement is part of the signed report, so a reviewer reads the limits next to the findings.",
  },
];

const ASR_REGISTER: { k: string; v: React.ReactNode }[] = [
  { k: "ASR-1", v: "least-privilege scopes" },
  { k: "ASR-2", v: "tamper-evident audit trail" },
  { k: "ASR-3", v: "data egress and redaction" },
  {
    k: "ASR-4",
    v: (
      <>
        injection resistance{" "}
        <span className="ml-2 inline-block rounded-sm border border-line bg-paper-2 px-[7px] py-px text-[10.5px] text-ink-3">
          reported, not warranted
        </span>
      </>
    ),
  },
  { k: "ASR-5", v: "supply-chain provenance" },
  {
    k: "ASR-6",
    v: (
      <>
        <b className="font-medium text-ink">verifiable evidence</b>{" "}
        <span className="ml-2 inline-block rounded-sm border border-line bg-paper-2 px-[7px] py-px text-[10.5px] text-ink-3">
          signed
        </span>
      </>
    ),
  },
];

const ASR_TABLE: { ctrl: string; name: string; req: string; maps: string }[] = [
  {
    ctrl: "ASR-1",
    name: "Least privilege",
    req: "Scopes held match scopes used; no shared keys across isolation boundaries.",
    maps: "OWASP ASI · NIST MANAGE-1 · SOC 2 CC6",
  },
  {
    ctrl: "ASR-2",
    name: "Audit trail",
    req: "Append-only, tamper-evident activity log with a stated retention policy.",
    maps: "EU AI Act Art.12 · SOC 2 CC7",
  },
  {
    ctrl: "ASR-3",
    name: "Data egress",
    req: "Egress destinations enumerated; sensitive fields redacted before they leave.",
    maps: "OWASP LLM02 · NIST MEASURE-2 · SOC 2 CC6",
  },
  {
    ctrl: "ASR-4",
    name: "Injection",
    req: "Direct and indirect injection and jailbreaks tested and reported with reproductions.",
    maps: "OWASP LLM01 · ATLAS AML.T0051",
  },
  {
    ctrl: "ASR-5",
    name: "Provenance",
    req: "Model and dependency provenance; tool and vendor surface enumerated.",
    maps: "OWASP LLM03 · NIST MAP-4",
  },
  {
    ctrl: "ASR-6",
    name: "Evidence",
    req: "Findings signed, logged, and offline-verifiable.",
    maps: "in-toto / SLSA · ISO 42001",
  },
];

const ADVERSARIAL = [
  {
    kicker: "LLM01 · direct",
    title: "Instruction hijack",
    body: "The agent is told to ignore its instructions and act for the attacker. We probe the system prompt and the tool layer for the boundary that should hold and the one that does not.",
    map: "OWASP LLM01",
  },
  {
    kicker: "LLM01 · indirect",
    title: "Poisoned context",
    body: "A payload hides in retrieved content, a tool result, or a document the agent reads. The agent never sees a malicious user, only data that carries an instruction.",
    map: "OWASP LLM01 · MITRE ATLAS",
  },
  {
    kicker: "ATLAS · bypass",
    title: "Guardrail and jailbreak",
    body: "Known jailbreak patterns and obfuscations are run against the system prompt and the filters in front of it, to see what slips through and what the agent then does with it.",
    map: "ATLAS AML.T0051",
  },
];

const BATTERY_STEPS = [
  {
    n: "1",
    title: "Reproduce",
    body: "Every finding ships with the exact input and the agent's response, so a reviewer can run it again rather than take our word.",
  },
  {
    n: "2",
    title: "Score",
    body: "Each case is rated by what the agent actually did, not by whether a refusal string appeared.",
  },
  {
    n: "3",
    title: "Map",
    body: "Results are tied to OWASP LLM01 and MITRE ATLAS, the references a reviewer is already reading against.",
  },
  {
    n: "4",
    title: "Report",
    body: "The battery and its limits go into the signed report, where the scope statement sits next to the findings.",
  },
];

const SIGNING_REGISTER: { k: string; v: React.ReactNode }[] = [
  { k: "signature_alg", v: <b className="font-medium text-ink">ed25519</b> },
  { k: "digest", v: <b className="font-medium text-ink">sha-256</b> },
  { k: "canonical", v: "key-sorted, whitespace-free JSON" },
  {
    k: "public_key",
    v: <b className="font-medium text-ink">ed25519 · embedded PEM</b>,
  },
  {
    k: "key_fingerprint",
    v: <b className="font-medium text-ink">410302c93becdcc3...</b>,
  },
  {
    k: "signature",
    v: (
      <>
        <b className="font-medium text-ink">ed25519:0XCoqRkbLg...sEjBDw</b>{" "}
        <span className="ml-2 inline-block rounded-sm border border-line bg-paper-2 px-[7px] py-px text-[10.5px] text-ink-3">
          covers the canonical bytes
        </span>
      </>
    ),
  },
  {
    k: "log",
    v: (
      <>
        append-only Merkle{" "}
        <span className="ml-2 inline-block rounded-sm border border-line bg-paper-2 px-[7px] py-px text-[10.5px] text-ink-3">
          RFC 6962 style
        </span>
      </>
    ),
  },
  {
    k: "verify",
    v: <b className="font-medium text-ink">offline · WebCrypto · no server</b>,
  },
];

const SIGNING_CARDS = [
  {
    title: "Canonical bytes",
    body: "Findings are serialized to key-sorted, whitespace-free JSON, then hashed with SHA-256. The signature covers those exact bytes, so a downgraded finding or an inflated score is self-evident.",
  },
  {
    title: "Ed25519, embedded key",
    body: "The signature and the public key it was made with travel together inside the report. The buyer needs nothing from us: the verifier runs offline against the key in the file.",
  },
  {
    title: "Append-only Merkle log",
    body: "Each issuance is recorded in an append-only Merkle log (RFC 6962 style, Ed25519 over SHA-256), so a report cannot be quietly backdated or swapped. It is a transparency log, not a chain.",
  },
];

export default function ResearchPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <div className="max-w-[70ch]">
            <h1 className="font-display text-[clamp(34px,5.2vw,56px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink">
              A review you cannot inspect is just a logo.
            </h1>
            <p className="mt-5 max-w-[62ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              When an autonomous agent reaches a security review, the buyer&rsquo;s
              question is not &ldquo;do you have a badge.&rdquo; It is &ldquo;show
              me the method.&rdquo; So we publish ours. The Agent Security Readiness
              framework, the adversarial injection battery, and the signing design
              are written down openly, and they map into the standards your buyer
              already cites. A shared yardstick, not a private credential we ask you
              to trust.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
              {HERO_TRUST.map((t) => (
                <span key={t} className="inline-flex items-center gap-2">
                  <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                  {t}
                </span>
              ))}
            </div>
          </div>
          <hr className="mt-10 border-0 border-t border-line" />
          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            <Badge variant="verified">ASR · open checklist</Badge>
            <Badge>Maps into SOC 2 · NIST AI RMF · EU AI Act</Badge>
            <Badge>CC0 (public domain)</Badge>
          </div>
        </div>
      </section>

      {/* ============================ THE APPROACH ====================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / The approach</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Start from the reviewer&rsquo;s desk.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A six-figure deal does not fail in security review. It stalls. The
              moment a CISO has to vet an autonomous agent, a one-week review runs
              four to eight, and a questionnaire no longer clears it. A reviewer
              wants a method they can examine, not a claim they have to take on
              faith. Everything below is built backward from that desk.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {APPROACH.map((a) => (
              <Card key={a.kicker}>
                <CardKicker>{a.kicker}</CardKicker>
                <CardTitle className="mt-2">{a.title}</CardTitle>
                <CardDescription className="mt-2">{a.body}</CardDescription>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ===================== THE ASR CONTROL FRAMEWORK ================ */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">02 / The ASR control framework</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Six controls, written down once.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Agent Security Readiness is a seed-stage readiness checklist for
              agentic products: the concrete controls a buyer&rsquo;s review looks
              for, set down openly. It does not compete with the frameworks a
              reviewer enforces. It maps into them, so passing it means something to
              the people who sign off.
            </p>
          </div>

          <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
            <div className="grid gap-[11px] rounded-lg border border-line bg-paper-sink p-5 font-mono text-[13.5px] leading-[1.5] text-ink-3">
              {ASR_REGISTER.map((row, i, arr) => (
                <div
                  key={row.k}
                  className={`grid grid-cols-[max-content_1fr] gap-[14px] pb-[10px] ${i < arr.length - 1 ? "border-b border-line" : "pb-0"}`}
                >
                  <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">
                    {row.k}
                  </span>
                  <span className="break-all text-ink-2">{row.v}</span>
                </div>
              ))}
            </div>
            <div className="grid gap-3.5">
              <Card>
                <CardTitle>One yardstick, six readings</CardTitle>
                <CardDescription className="mt-2">
                  Each control is a question a reviewer already has: does the agent
                  hold more access than it uses, can the trail be edited after the
                  fact, where does data go, can the agent be hijacked, what is in
                  the supply chain, and can any of it be verified.
                </CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">
                  ASR &rarr; SOC 2 TSC · ISO 42001 · NIST AI RMF · EU AI Act
                  Art.12/14 · OWASP LLM &amp; Agentic Top 10
                </p>
              </Card>
              <Card>
                <CardTitle>Not a rival credential</CardTitle>
                <CardDescription className="mt-2">
                  ASR is published CC0. Use it, fork it, map your own program to it.
                  We would rather raise the floor for agent security than own a gate
                  in front of it.
                </CardDescription>
              </Card>
            </div>
          </div>

          <div className="mt-12 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] border-collapse text-[14px]">
              <thead>
                <tr>
                  {["ASR control", "What it requires", "Maps into"].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="border-b border-line bg-paper-sink p-[15px] text-left font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink-3"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ASR_TABLE.map((r, i) => {
                  const b =
                    i < ASR_TABLE.length - 1 ? "border-b border-line" : "";
                  return (
                    <tr key={r.ctrl}>
                      <td className={`p-[15px] align-top text-ink-2 ${b}`}>
                        <b className="font-mono font-semibold text-ink">
                          {r.ctrl}
                        </b>{" "}
                        {r.name}
                      </td>
                      <td className={`p-[15px] align-top text-ink-2 ${b}`}>
                        {r.req}
                      </td>
                      <td
                        className={`whitespace-nowrap p-[15px] align-top font-mono text-[12.5px] text-accent-text ${b}`}
                      >
                        {r.maps}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ==================== ADVERSARIAL TESTING (LEDGER) ============== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">03 / Adversarial testing</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              We attack the agent on purpose.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              For an autonomous agent, the first thing a reviewer asks is whether
              it can be hijacked into acting for someone else. So injection is not a
              checkbox. It is a battery, run against the agent&rsquo;s own tools and
              context, with every result reproduced before it is written down.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {ADVERSARIAL.map((a) => (
              <Card key={a.kicker} ledger>
                <CardKicker className="text-on-ink-3">{a.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">{a.title}</CardTitle>
                <CardDescription className="mt-2 text-on-ink-2">
                  {a.body}
                </CardDescription>
                <p className="mt-4 font-mono text-[12px] text-on-ink-3">
                  {a.map}
                </p>
              </Card>
            ))}
          </div>

          <ol className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {BATTERY_STEPS.map((s) => (
              <li
                key={s.n}
                className="rounded-lg border border-[var(--line-ink)] bg-[var(--ink-deep-2)] p-6"
              >
                <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-on-ink-3">
                  {s.n}
                </span>
                <h3 className="mt-2 font-sans text-[18px] font-semibold tracking-[-0.012em] text-on-ink">
                  {s.title}
                </h3>
                <p className="mt-2 text-[15px] leading-[1.6] text-on-ink-2">
                  {s.body}
                </p>
              </li>
            ))}
          </ol>

          <p className="mt-10 max-w-[64ch] text-[13px] leading-[1.6] text-on-ink-3">
            Scope is contractual. Permission posture, redaction and audit-trail
            integrity are assessed. Injection is tested and reported, not
            warranted.
          </p>
        </div>
      </section>

      {/* ============= THE SIGNING AND TRANSPARENCY DESIGN ============= */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">04 / The signing and transparency design</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Findings a buyer can verify without us.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A report is only evidence if the person reading it can check it
              themselves. So a finding is canonicalized to exact bytes, signed with
              Ed25519, and recorded in an append-only log. The buyer verifies the
              signature in their own browser, against the key inside the report,
              with no kolm server in the trust path.
            </p>
          </div>
          <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
            <div className="grid gap-[11px] rounded-lg border border-line bg-paper-sink p-5 font-mono text-[13.5px] leading-[1.5] text-ink-3">
              {SIGNING_REGISTER.map((row, i, arr) => (
                <div
                  key={row.k}
                  className={`grid grid-cols-[max-content_1fr] gap-[14px] pb-[10px] ${i < arr.length - 1 ? "border-b border-line" : "pb-0"}`}
                >
                  <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">
                    {row.k}
                  </span>
                  <span className="break-all text-ink-2">{row.v}</span>
                </div>
              ))}
            </div>
            <div className="grid gap-3.5">
              {SIGNING_CARDS.map((c) => (
                <Card key={c.title}>
                  <CardTitle>{c.title}</CardTitle>
                  <CardDescription className="mt-2">{c.body}</CardDescription>
                </Card>
              ))}
            </div>
          </div>
          <p className="mt-10 max-w-[68ch] text-[13px] leading-[1.6] text-ink-3">
            Two checks, both offline.{" "}
            <b className="font-semibold text-ink-2">Tier 1</b> confirms the
            signature covers the bytes.{" "}
            <b className="font-semibold text-ink-2">Tier 2</b> confirms the signing
            key is the one the buyer&rsquo;s keyring expects. A rogue key clears
            Tier 1 and fails Tier 2.
          </p>
        </div>
      </section>

      {/* ============================ CTA FINAL ========================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Read the method. Verify the evidence.
          </h2>
          <p className="mx-auto mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            The framework, the battery, and the signing design are open. The next
            step is to run one against your own report.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/docs">Read the docs</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/verify">Verify a report</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
