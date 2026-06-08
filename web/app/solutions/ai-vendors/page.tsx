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
  title: "For AI vendors: clear the security review",
  description:
    "Your six-figure enterprise deal stalled the moment a CISO had to vet an autonomous agent. kolm hands you a signed evidence report your buyer verifies offline, against your own key, with no account and no server in the trust path. The four to eight week review compresses back to days.",
};

const FRAMEWORKS = [
  "SOC 2",
  "ISO 42001",
  "NIST AI RMF",
  "EU AI Act",
  "OWASP",
  "MITRE ATLAS",
];

const METRICS = [
  {
    n: "4 to 8 wks",
    l: "how long a from-scratch agent review runs once a CISO is in the loop",
  },
  {
    n: "1 deal",
    l: "six figures, signed by the buyer in principle, parked in review",
  },
  {
    n: "Days",
    l: "the same review when you walk in with signed, verifiable evidence",
  },
];

const FORM_FAILS = [
  {
    kicker: "Over-permissioned",
    title: "More access than the job needs",
    body: "Most agents hold ten times the privileges they use, often on one shared key. It is the first thing a reviewer flags, and a form cannot un-flag it.",
    map: "ASR-1 · least privilege",
  },
  {
    kicker: "No tamper-evidence",
    title: "A trail nobody can trust",
    body: "If the record of what your agent did can be edited after the fact, it is not evidence. Reviewers want it append-only and hash-chained, not asserted.",
    map: "ASR-2 · audit trail",
  },
  {
    kicker: "Say-so doesn’t scale",
    title: "Self-attestation shifts the burden",
    body: "Every answer you write by hand becomes work the buyer's team has to take on faith or re-verify. They want proof they can run themselves.",
    map: "ASR-6 · evidence",
  },
];

const REPORT_CARDS = [
  {
    title: "Canonical payload",
    body: "Key-sorted, whitespace-free JSON. The signature covers these exact bytes, so a downgraded finding or an inflated score is self-evident the instant the buyer checks it.",
  },
  {
    title: "Your key travels in the report",
    body: "The signature and the public key it was made with ship together. Your buyer needs nothing from us: the verifier runs offline against the key inside the report, no account, no upload.",
  },
  {
    title: "Framework crosswalk",
    body: "Every finding maps to the control your buyer names. The reviewer reads results in the vocabulary they already enforce, not yours.",
  },
];

const CLOCKS = [
  {
    kicker: "The machine clock",
    title: "No human waits here",
    body: "Permission reads, audit-trail and egress checks, the prompt-injection battery, control-mapping and signing are compute. They run in minutes to hours, with nobody in the loop, and re-run on every deploy.",
  },
  {
    kicker: "The human clock",
    title: "A name behind the result",
    body: "For the deal where a CISO wants a person to stand behind the finding, a named co-signer reviews and signs alongside the math. That is days, bounded by an SLA, against the four to eight weeks a from-scratch review takes.",
  },
];

const REPORT_FEATURES = [
  "Permissions, audit trail, egress and injection, all four pillars",
  "Mapped to SOC 2, ISO 42001, NIST AI RMF, OWASP, MITRE ATLAS",
  "Ed25519-signed report your buyer verifies offline, no account",
  "Remediation checklist for every finding",
];

const MORE_WAYS = [
  {
    lead: "Scan, Free.",
    rest: "Self-serve. A signed, watermarked snapshot in minutes, no human, no call.",
  },
  {
    lead: "Continuous, from $299/mo.",
    rest: "Weekly or on-every-deploy re-attestation, plus a live Trust link any buyer can re-check.",
  },
  {
    lead: "Reviewed Attestation, $25,000 flat.",
    rest: "A named co-signer reviews and signs beside the math. The deal-closer.",
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

export default function AiVendorsPage() {
  return (
    <>
      {/* ============================== 1. HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(56px,7vw,96px)]">
          <div className="max-w-[60ch]">
            <h1 className="font-display text-[clamp(34px,5.4vw,56px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink">
              Your deal didn&rsquo;t die.
              <br />
              It stalled in security review.
            </h1>
            <p className="mt-5 max-w-[60ch] font-sans text-[clamp(17px,1.5vw,20px)] leading-[1.55] text-ink-2">
              Your agent works. The contract is real. Then a CISO had to vet an
              autonomous agent, and a one-week review ran four, six, eight weeks.
              kolm hands you a signed evidence report your buyer verifies
              offline, against your own key. The review compresses back to days.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <Link href="/contact">Start an audit</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/sample">See a sample report</Link>
              </Button>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Ed25519-signed
              </span>
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Verified offline against your key
              </span>
              <span className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                Mapped to SOC 2, ISO 42001, your buyer&rsquo;s questionnaire
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ============================== 2. PROOF STRIP ============================== */}
      <section className="border-b border-line" aria-label="Proof">
        <div className="mx-auto max-w-wrap px-6 py-12">
          <h2 className="sr-only">Proof at a glance</h2>
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

      {/* ============================== 3. THE STALL ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / The stall</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A CISO will not take your word for it.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              The day your agent touches customer data, the week-long review runs
              four to eight. The contract sits in legal. The champion goes quiet.
              Nothing is wrong with your product. There is just no way to prove
              the agent is safe except your say-so, and a security team does not
              sign off on say-so.
            </p>
          </div>
          <div className="grid gap-8 sm:grid-cols-3">
            {METRICS.map((m) => (
              <div key={m.n} className="border-l border-line-2 pl-4">
                <span className="block font-display text-[clamp(34px,4.4vw,50px)] font-extrabold leading-none tracking-[-0.035em] text-ink [font-variant-numeric:tabular-nums]">
                  {m.n}
                </span>
                <span className="mt-3 block text-[14px] leading-[1.55] text-ink-2">
                  {m.l}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 4. WHY THE FORM FAILS ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">02 / Why the form fails</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              A questionnaire no longer clears it.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              A filled-in form was enough when software was deterministic. An
              agent decides at runtime, so the reviewer wants something they can
              check, not read. Three things are now table stakes, and a
              questionnaire proves none of them.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {FORM_FAILS.map((f) => (
              <Card key={f.kicker} ledger>
                <CardKicker className="text-on-ink-3">{f.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">{f.title}</CardTitle>
                <CardDescription className="mt-2 text-on-ink-2">
                  {f.body}
                </CardDescription>
                <p className="mt-4 font-mono text-[12px] text-on-ink-3">
                  {f.map}
                </p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 5. THE SIGNED REPORT ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">03 / The report</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              What you hand the buyer.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Not a promise. One canonical object, signed with Ed25519, mapped to
              the controls the review group already cites. They open it, verify
              the signature offline against your public key, and trace every
              finding to a standard they enforce.
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
                      Support &amp; billing agents{" "}
                      <Ann>what was assessed</Ann>
                    </>
                  ),
                },
                {
                  k: "readiness_pct",
                  v: (
                    <>
                      <b className="font-medium text-ink">0</b>{" "}
                      <Ann>assessed controls only</Ann>
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
              {REPORT_CARDS.map((c) => (
                <Card key={c.title}>
                  <CardTitle>{c.title}</CardTitle>
                  <CardDescription className="mt-2">{c.body}</CardDescription>
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

      {/* ============================== 6. TWO CLOCKS ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">04 / Two clocks</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Minutes for the scan. Days for a signature with a name on it.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              A stalled review runs on two clocks, and we are candid about which
              one needs a person. State it the way you would to the buyer:
              minutes for the automated scan, days for a named-reviewed
              attestation.
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
            The crypto proves the bytes were not altered. The name proves a
            person reviewed them. Most deals clear on the automated report alone.
          </p>
        </div>
      </section>

      {/* ============================== 7. PRICING POINTER ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">05 / Pricing</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Start free. Sign when the deal needs it.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Every fee is flat and listed in full. No quote, no per-seat meter,
              no contingency. The report you hand the buyer is $750.
            </p>
          </div>
          <div className="grid items-center gap-7 lg:grid-cols-2">
            <Card className="flex flex-col">
              <CardKicker>Signed Readiness Report</CardKicker>
              <p className="mt-3 font-display text-[clamp(32px,3.8vw,46px)] font-extrabold leading-none tracking-[-0.035em] text-ink">
                $750
              </p>
              <p className="mt-1 text-[13px] leading-snug text-ink-3">
                one-time · the full automated audit, signed and
                offline-verifiable
              </p>
              <ul className="my-5 grid gap-2.5">
                {REPORT_FEATURES.map((f) => (
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
                Start with a{" "}
                <Link
                  className="border-b border-line-2 text-ink hover:border-ink"
                  href="/pricing"
                >
                  free scan
                </Link>{" "}
                first, no card.
              </p>
            </Card>
            <div>
              <h3 className="font-sans text-[20px] font-semibold leading-[1.3] tracking-[-0.012em] text-ink">
                Three more ways in
              </h3>
              <ul className="my-4 grid gap-2.5">
                {MORE_WAYS.map((w) => (
                  <li
                    key={w.lead}
                    className="flex items-start gap-2 text-[15px] text-ink-2"
                  >
                    <CheckIcon className="mt-[5px] h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                    <span>
                      <b className="font-semibold text-ink">{w.lead}</b>{" "}
                      {w.rest}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mb-5 text-[15px] leading-relaxed text-ink-2">
                A point-in-time report goes stale on your next deploy: a
                permission granted in January can still fire in August.
                Continuous keeps the evidence current, and the EU AI Act Article
                12 logging obligation has an enforcement date of August 2, 2026.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button asChild variant="ghost" size="sm">
                  <Link href="/pricing">See full pricing</Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/sample">See a sample report</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================== 8. FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[22ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Clear the review. Close the deal.
          </h2>
          <p className="mx-auto mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            A scoped audit, a signed evidence report, and a review that moves at
            the speed of math instead of the speed of a questionnaire.
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
