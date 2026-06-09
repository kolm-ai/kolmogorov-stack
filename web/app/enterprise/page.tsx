import type { Metadata } from "next";
import type { ReactNode } from "react";
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
  title: "Enterprise",
  description:
    "A six-figure deal can wait weeks in security review. Give the buyer's review group a signed, offline-verifiable report they check themselves. Add a named co-signer with the Reviewed Attestation, keep a fleet current with continuous re-attestation, under an MSA and a defined scope.",
};

const FRAMEWORKS = [
  "SOC 2",
  "ISO 42001",
  "NIST AI RMF",
  "EU AI Act",
  "OWASP",
  "MITRE ATLAS",
];

const DEAL = [
  {
    kicker: "The clock",
    title: "One week becomes eight",
    body: "The moment an autonomous agent touches customer data, a routine review runs four to eight weeks. Every week the contract sits unsigned is a week the buyer can change their mind.",
    map: "EU AI Act Art.12 · Aug 2 2026",
  },
  {
    kicker: "The reviewer",
    title: "A questionnaire stops clearing it",
    body: "A self-attested questionnaire shifts the burden onto the buyer. A senior reviewer wants evidence they can verify, mapped to a control they already cite.",
    map: "ASR-6 · evidence",
  },
  {
    kicker: "The stakes",
    title: "Six figures, on hold",
    body: "The agent is built. The pricing is agreed. What is left is one sign-off, and the cost of getting it wrong is the whole deal slipping a quarter.",
    map: "ASR-1 · least privilege",
  },
];

const RECEIVES = [
  {
    title: "The signed report",
    body: "Key-sorted, whitespace-free JSON, sealed with Ed25519. The signature covers these exact bytes, so a downgraded finding or an inflated score is self-evident in front of the reviewer.",
  },
  {
    title: "The framework crosswalk",
    body: "Every finding maps to the control the review group already uses, so a result traces straight to SOC 2, ISO 42001, NIST AI RMF, OWASP, or MITRE ATLAS.",
  },
  {
    title: "Offline verification",
    body: "They verify the signature on WebCrypto, in their own browser, against the key inside the report. No account, no upload, no kolm server in the path.",
  },
];

const CLOCKS = [
  {
    kicker: "The machine clock",
    title: "No human waits here",
    body: "The permission read, the audit-trail and egress checks, the prompt-injection battery, the control-mapping and the signing are compute. They run in minutes to hours, re-run on every deploy, and need nobody in the loop.",
  },
  {
    kicker: "The human clock",
    title: "A name behind the result",
    body: "An enterprise reviewer wants a person to stand behind the finding, not just a machine that approved a machine. The named co-signer reviews and signs alongside the automated audit. That is days, bounded by an SLA, against the four to eight weeks a from-scratch review takes.",
  },
];

const FLEET = [
  {
    kicker: "Re-attested per deploy",
    title: "Evidence that moves with the code",
    body: "Affected checks re-run and re-sign on every release across the fleet, with prompt-injection regression on each one. The signed report the buyer holds is never older than your last deploy. No human in the loop.",
    map: "ASR-2 · audit trail · per-deploy",
  },
  {
    kicker: "A live Trust link",
    title: "One URL the buyer re-checks",
    body: "You hand the review group a single link. They re-verify the current attestation offline, any time, against the embedded key. When you ship, it updates itself, so a passed review stays passed.",
    map: "ASR-6 · evidence · live",
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

const COSIGNER_FEATURES = [
  "The full automated audit, signed and offline-verifiable",
  "A named, accredited security reviewer co-signs the report",
  "Two signatures, both verifiable offline, independent keys",
  "Remediation walkthrough with your team",
];

const TERMS = [
  {
    kicker: "Contract",
    title: "MSA & custom scope",
    body: "A master services agreement, a scope defined in the order, and liability terms your counsel can redline.",
  },
  {
    kicker: "Data",
    title: "DPA & subprocessors",
    body: (
      <>
        The data-processing terms and the current{" "}
        <Link
          className="border-b border-line-2 text-ink hover:border-ink"
          href="/subprocessors"
        >
          subprocessor list
        </Link>
        , ready for diligence.
      </>
    ),
  },
  {
    kicker: "Freshness",
    title: "Re-attestation in the order",
    body: "Affected checks re-run and re-sign across the fleet as the agent changes, under the cadence the order sets.",
  },
  {
    kicker: "Diligence",
    title: "Trust package",
    body: (
      <>
        Our security posture, the data terms, and the open verifier, gathered
        for your{" "}
        <Link
          className="border-b border-line-2 text-ink hover:border-ink"
          href="/trust"
        >
          review
        </Link>
        .
      </>
    ),
  },
];

function Ann({ children }: { children: ReactNode }) {
  return (
    <span className="ml-2 inline-block rounded-sm border border-line bg-paper-2 px-[7px] py-px text-[10.5px] text-ink-3">
      {children}
    </span>
  );
}

function Register({ rows }: { rows: { k: string; v: ReactNode }[] }) {
  return (
    <Card className="font-mono text-[13px] leading-[1.5] text-ink-3">
      <dl className="grid gap-[11px]">
        {rows.map((row) => (
          <div
            key={row.k}
            className="grid grid-cols-[max-content_1fr] gap-3.5 border-b border-line pb-2.5 last:border-b-0 last:pb-0"
          >
            <dt className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">
              {row.k}
            </dt>
            <dd className="break-all text-ink-2">{row.v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

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

const SCOPE_LINE =
  "Scope is contractual. Permission posture, redaction and audit-trail integrity are assessed. Injection is tested and reported, not warranted.";

export default function EnterprisePage() {
  return (
    <>
      {/* ============================== 1. HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(56px,7vw,96px)]">
          <div className="max-w-[68ch]">
            <h1 className="font-display text-[clamp(34px,5.4vw,56px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink">
              Signed evidence for the agents
              <br />
              in your biggest deals.
            </h1>
            <p className="mt-5 max-w-[64ch] font-sans text-[clamp(17px,1.5vw,20px)] leading-[1.55] text-ink-2">
              A one-week review runs four to eight weeks the moment a CISO has to
              vet an autonomous agent. Enterprise is the version of the work
              built for that review: a signed report the buyer&rsquo;s review
              group verifies offline, a named co-signer beside the automated
              audit, and a fleet kept current under an MSA.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <Link href="/contact">Start an audit</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/pricing">See pricing</Link>
              </Button>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Named co-signed attestation
              </span>
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Continuous for a fleet
              </span>
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                MSA and a defined scope
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ============================== PROOF STRIP ============================== */}
      <section className="border-b border-line" aria-label="What the report maps to">
        <div className="mx-auto max-w-wrap px-6 py-12">
          <h2 className="sr-only">Mapped to the standards your buyer cites</h2>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <Badge variant="verified">Ed25519-signed</Badge>
            <span className="inline-flex items-center gap-2.5 text-[13.5px] text-ink-2">
              <ShieldIcon className="h-4 w-4 flex-none text-ink-3" />
              Verified offline. No kolm server in the trust path
            </span>
            <span className="inline-flex items-center gap-2.5 text-[13.5px] text-ink-2">
              <LogIcon className="h-4 w-4 flex-none text-ink-3" />
              <Link
                className="border-b border-line-2 text-ink hover:border-ink"
                href="/transparency-log"
              >
                Merkle append-only transparency log
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

      {/* ============================== 01. THE SIX-FIGURE DEAL ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / The six-figure deal in review</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A CISO will not take your word for it.
            </h2>
            <p className="mt-4 max-w-[54ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              One contract, somewhere between a hundred thousand and half a
              million in value, is paused on a single review group. The deal
              stalls in security review. It waits on evidence the buyer can
              check for themselves.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {DEAL.map((d) => (
              <Card key={d.kicker}>
                <CardKicker>{d.kicker}</CardKicker>
                <CardTitle className="mt-2">{d.title}</CardTitle>
                <CardDescription className="mt-2">{d.body}</CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">{d.map}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 02. WHAT THE REVIEW GROUP RECEIVES ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">02 / What the review group receives</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              One object they can open and check.
            </h2>
            <p className="mt-4 max-w-[54ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Not a slide deck and not a promise. A single canonical report,
              signed with Ed25519, mapped to the frameworks the buyer cites, and
              verifiable offline in their own browser against the embedded key.
            </p>
          </div>
          <div className="grid items-start gap-7 lg:grid-cols-2">
            <Register
              rows={[
                { k: "schema", v: "kolm-audit-report-1" },
                { k: "report_id", v: "asrr_sample" },
                {
                  k: "subject",
                  v: (
                    <>
                      support &amp; billing agents{" "}
                      <Ann>what was assessed</Ann>
                    </>
                  ),
                },
                {
                  k: "findings",
                  v: (
                    <>
                      6 · <b className="font-medium text-ink">5 high</b> · 1 low
                    </>
                  ),
                },
                {
                  k: "public_key",
                  v: <b className="font-medium text-ink">ed25519 · embedded PEM</b>,
                },
                {
                  k: "key_fingerprint",
                  v: <b className="font-medium text-ink">410302c93becdcc3…</b>,
                },
                {
                  k: "signature",
                  v: (
                    <>
                      <b className="font-medium text-ink">
                        ed25519:0XCoqRkbLg…sEjBDw
                      </b>{" "}
                      <Ann>covers the canonical bytes</Ann>
                    </>
                  ),
                },
                {
                  k: "verify_url",
                  v: <b className="font-medium text-ink">kolm.ai/verify</b>,
                },
              ]}
            />
            <div className="grid gap-3.5">
              {RECEIVES.map((r) => (
                <Card key={r.title}>
                  <CardTitle>{r.title}</CardTitle>
                  <CardDescription className="mt-2">{r.body}</CardDescription>
                </Card>
              ))}
            </div>
          </div>

          <div className="mt-12">
            <Crosswalk />
          </div>
          <p className="mt-6 max-w-[72ch] text-[13px] leading-[1.6] text-ink-3">
            {SCOPE_LINE}
          </p>
        </div>
      </section>

      {/* ============================== 03. THE NAMED CO-SIGNER ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">03 / The named co-signer</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A name a competitor cannot copy.
            </h2>
            <p className="mt-4 max-w-[54ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Cryptography proves the bytes were not altered. A name proves a
              person reviewed them. For the deal where a CISO wants both, an
              accredited reviewer co-signs the report, their reputation on the
              line beside ours.
            </p>
          </div>
          <div className="grid items-center gap-7 lg:grid-cols-2">
            <Card className="flex flex-col">
              <CardKicker>Reviewed Attestation</CardKicker>
              <p className="mt-3 font-display text-[clamp(32px,3.8vw,46px)] font-extrabold leading-none tracking-[-0.035em] text-ink">
                $25,000
              </p>
              <p className="mt-1 text-[13px] leading-snug text-ink-3">
                flat · named co-signer · days, not weeks
              </p>
              <ul className="my-5 grid gap-2.5">
                {COSIGNER_FEATURES.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2 text-[15px] text-ink-2"
                  >
                    <CheckIcon className="mt-[5px] h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Button asChild className="w-full">
                <Link href="/contact">Start an audit</Link>
              </Button>
              <p className="mt-3 text-center text-[13px] leading-[1.6] text-ink-3">
                Need a deeper adversarial pass? Add{" "}
                <b className="font-semibold text-ink-2">Deep Red-Team</b> for{" "}
                <b className="font-semibold text-ink-2">+$10,000</b>.{" "}
                <Link
                  className="border-b border-line-2 text-ink hover:border-ink"
                  href="/pricing"
                >
                  See full pricing
                </Link>
                .
              </p>
            </Card>
            <Register
              rows={[
                {
                  k: "signer",
                  v: (
                    <>
                      kolm <Ann>issuer</Ann>
                    </>
                  ),
                },
                { k: "co_signer", v: "named accredited reviewer" },
                {
                  k: "sig_1",
                  v: <b className="font-medium text-ink">ed25519(kolm_sk, bytes)</b>,
                },
                {
                  k: "sig_2",
                  v: (
                    <b className="font-medium text-ink">
                      ed25519(reviewer_sk, bytes)
                    </b>
                  ),
                },
                {
                  k: "verify",
                  v: (
                    <>
                      <b className="font-medium text-ink">both, offline</b>{" "}
                      <Ann>independent keys</Ann>
                    </>
                  ),
                },
                {
                  k: "stale_in",
                  v: (
                    <>
                      re-attest on next deploy{" "}
                      <Ann>continuous keeps it live</Ann>
                    </>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </section>

      {/* ============================== 04. TWO CLOCKS ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">04 / Two clocks</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Minutes for the scan. Days for a signature with a name on it.
            </h2>
            <p className="mt-4 max-w-[54ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              An enterprise review stalls on two different clocks. We compress
              both, and we are candid about which one needs a person.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {CLOCKS.map((c) => (
              <Card key={c.kicker} ledger>
                <CardKicker className="text-on-ink-3">{c.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">{c.title}</CardTitle>
                <CardDescription className="mt-2 text-on-ink-2">
                  {c.body}
                </CardDescription>
              </Card>
            ))}
          </div>
          <p className="mt-9 max-w-[72ch] text-[13px] leading-[1.6] text-on-ink-3">
            Minutes for the automated scan, days for a named-reviewed
            attestation.
          </p>
        </div>
      </section>

      {/* ============================== 05. CONTINUOUS FOR A FLEET ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">05 / Continuous for a fleet</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A snapshot goes stale on the next deploy.
            </h2>
            <p className="mt-4 max-w-[54ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A point-in-time report describes the agent you shipped last week. A
              permission granted in January can still fire in August. Continuous
              re-attests the whole fleet and hands the buyer one link that never
              goes out of date.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {FLEET.map((f) => (
              <Card key={f.kicker}>
                <CardKicker>{f.kicker}</CardKicker>
                <CardTitle className="mt-2">{f.title}</CardTitle>
                <CardDescription className="mt-2">{f.body}</CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">{f.map}</p>
              </Card>
            ))}
          </div>
          <p className="mt-6 max-w-[72ch] text-[13px] leading-[1.6] text-ink-3">
            Continuous plans and per-agent counts are flat and listed in full.{" "}
            <Link
              className="border-b border-line-2 text-ink hover:border-ink"
              href="/pricing"
            >
              See pricing
            </Link>
            .
          </p>
        </div>
      </section>

      {/* ============================== 06. TERMS ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">06 / Terms</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Terms your counsel can work with.
            </h2>
            <p className="mt-4 max-w-[54ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Enterprise runs on paper your legal and security teams already
              recognize: a master agreement, a scope defined in writing, and the
              data terms attached.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {TERMS.map((t) => (
              <Card key={t.title}>
                <CardKicker>{t.kicker}</CardKicker>
                <CardTitle className="mt-2 text-[18px]">{t.title}</CardTitle>
                <CardDescription className="mt-2 text-[14px]">
                  {t.body}
                </CardDescription>
              </Card>
            ))}
          </div>
          <p className="mt-6 max-w-[80ch] text-[13px] leading-[1.6] text-ink-3">
            {SCOPE_LINE} Liability is capped at fee.
          </p>
        </div>
      </section>

      {/* ============================== FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Bring us the deal stuck in security review.
          </h2>
          <p className="mx-auto mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            A signed report your buyer verifies in their own browser, a name
            beside the automated audit, and a review that takes days, not weeks.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/contact">Start an audit</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
