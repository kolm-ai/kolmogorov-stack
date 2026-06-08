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
import { CheckIcon, ShieldIcon, LogIcon, ArrowIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "Platform",
  description:
    "The kolm platform turns your agent into one signed object a security review can check. Import your logs or run a sidecar proxy, analyze permissions, audit trail, data egress and injection, map every finding to the frameworks your buyer cites, sign with Ed25519, and log to an append-only Merkle transparency log. Verified offline, no server in the trust path.",
};

/* page-local flow icons (shared set covers the log + arrow + check) */
function DownloadIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M12 3v11m0 0l-4-4m4 4l4-4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
function ShieldCheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 11.5l2.4 2.4L15.5 9.3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function BigCheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4 12.5l4.5 4.5L20 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const HERO_TRUST = [
  "Import logs or sidecar proxy",
  "Ed25519-signed",
  "Verified offline by your buyer",
];

const FRAMEWORKS = [
  "SOC 2",
  "ISO 42001",
  "NIST AI RMF",
  "EU AI Act",
  "OWASP",
  "MITRE ATLAS",
];

const PROBLEM = [
  {
    kicker: "The clock",
    title: "One week becomes eight",
    body: "A self-attested answer no longer clears an agent that can act on its own. The review reopens from the start, and a six-figure deal waits on it.",
  },
  {
    kicker: "The burden",
    title: "Proof lands on your buyer",
    body: "Say-so moves the work onto the reviewer's desk. They want evidence they can check themselves, not a promise that an audit happened somewhere.",
  },
  {
    kicker: "The half-life",
    title: "It goes stale on deploy",
    body: "Even a clean point-in-time answer expires on your next release. A permission granted in January can still fire in August.",
  },
];

const CAPABILITIES = [
  {
    kicker: "Permission analyzer",
    title: "Least privilege",
    body: "Extracts and normalizes every scope the agent holds, compares it to what it actually exercises, and flags over-permissioning and shared keys.",
    map: "ASR-1 · SOC 2 CC6 · OWASP ASI",
  },
  {
    kicker: "Audit-trail analyzer",
    title: "Audit trail",
    body: "Scores completeness, tamper-evidence and retention of the agent's activity log against what a reviewer expects to be able to read back.",
    map: "ASR-2 · EU AI Act Art.12 · SOC 2 CC7",
  },
  {
    kicker: "Egress auditor",
    title: "Data egress",
    body: "Maps where the agent's data can travel, names the destinations and sub-processors, and confirms sensitive fields are redacted before they leave.",
    map: "ASR-3 · OWASP LLM02 · EU AI Act Art.10",
  },
  {
    kicker: "Injection tester",
    title: "Injection",
    body: "A red-team pass for prompt injection, indirect injection and guardrail bypass, reported with reproductions a reviewer can re-run.",
    map: "ASR-4 · OWASP LLM01 · MITRE ATLAS",
  },
  {
    kicker: "Provenance check",
    title: "Provenance",
    body: "Records model and dependency provenance so a reviewer can trace exactly what was running when the agent acted.",
    map: "ASR-5 · ISO 42001 · NIST MAP-1",
  },
  {
    kicker: "Report builder",
    title: "Evidence",
    body: "Canonicalizes the findings and seals them with Ed25519 into one report object plus a human-readable PDF. Signed, logged, offline-verifiable.",
    map: "ASR-6 · SOC 2 CC7 · ISO 42001",
  },
];

const ARCH = [
  {
    icon: DownloadIcon,
    n: "01 · Onramp",
    t: "Import or sidecar",
    d: "Bring LiteLLM, Helicone or Portkey logs, or run a sidecar / MCP proxy for live capture. No rebuild of your agent and no new SDK to ship.",
  },
  {
    icon: ShieldCheckIcon,
    n: "02 · Sign",
    t: "Canonical Ed25519 seal",
    d: "The findings are canonicalized to key-sorted JSON and signed with Ed25519. The signature covers the exact bytes, so a downgraded finding or an inflated score breaks it.",
  },
  {
    icon: LogIcon,
    n: "03 · Log",
    t: "Merkle transparency log",
    d: "Each issuance enters an append-only Merkle log (RFC 6962 style, Ed25519 and SHA-256, not a blockchain). A per-report inclusion proof shows it was logged and never replaced.",
  },
  {
    icon: BigCheckIcon,
    n: "04 · Verify",
    t: "Offline, in the browser",
    d: "Your buyer verifies the signature on WebCrypto in their own browser, against your public key. No account, no upload, no kolm server in the trust path.",
  },
];

const PROOF = [
  {
    kicker: "Tier 1 · signature",
    title: "Edit one field, the seal breaks",
    body: "The Ed25519 signature covers the canonical bytes. Change a finding or inflate the score and the match fails, in front of the reviewer.",
  },
  {
    kicker: "Tier 2 · issuer",
    title: "A rogue key signs, but doesn't match",
    body: "The signing key is pinned to the keyring your buyer expects. Forge a fresh key and tier 1 clears, but tier 2 exposes it.",
  },
  {
    kicker: "Offline · no server",
    title: "kolm is never in the path",
    body: "Verification runs on WebCrypto in the buyer's browser. No account, no upload, nothing for us to fake. Scope is part of the signed object.",
  },
];

export default function PlatformPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <div className="max-w-[70ch]">
            <h1 className="font-display text-[clamp(34px,5.2vw,56px)] font-extrabold leading-[1.03] tracking-[-0.035em] text-ink">
              The deal stalled the moment a CISO met your agent.
            </h1>
            <p className="mt-5 max-w-[62ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              kolm is the pipeline that gets it moving again. Import your existing
              logs or drop in a sidecar proxy, and every capability feeds one
              output: a signed, offline-verifiable report your buyer checks against
              your own key, with no account and no kolm server in the trust path.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <Link href="/contact">Start an audit</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/how-it-works">See how it works</Link>
              </Button>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
              {HERO_TRUST.map((t) => (
                <span key={t} className="inline-flex items-center gap-2">
                  <CheckIcon className="h-3.5 w-3.5 text-[var(--accent)]" />
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ============================ PROOF STRIP ======================== */}
      <section className="border-b border-line" aria-label="Proof">
        <div className="mx-auto max-w-wrap px-6 py-12">
          <h2 className="sr-only">What the report maps to</h2>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Badge variant="verified">Ed25519-signed</Badge>
            <span className="inline-flex items-center gap-2.5 text-[13.5px] text-ink-2">
              <ShieldIcon className="h-4 w-4 flex-none text-ink-3" />
              Verified offline. Zero servers in the trust path
            </span>
            <span className="inline-flex items-center gap-2.5 text-[13.5px] text-ink-2">
              <LogIcon className="h-4 w-4 flex-none text-ink-3" />
              <Link
                href="/transparency-log"
                className="border-b border-line-2 text-ink hover:border-ink"
              >
                Append-only Merkle transparency log
              </Link>
            </span>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            {FRAMEWORKS.map((f) => (
              <span key={f} className="ctrlid">
                {f}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ============================= THE PROBLEM ======================= */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / The problem</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A questionnaire used to clear it. An autonomous agent does not.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              The one-week security review runs four to eight the moment a reviewer
              has to vet an agent that acts on its own. The shape of the system
              below exists to answer that review in evidence, not in promises.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {PROBLEM.map((p) => (
              <Card key={p.kicker}>
                <CardKicker>{p.kicker}</CardKicker>
                <CardTitle className="mt-2">{p.title}</CardTitle>
                <CardDescription className="mt-2">{p.body}</CardDescription>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ CAPABILITIES ====================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">02 / Capabilities</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Six controls. One per question a reviewer asks.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Each capability is a product surface that produces one signed
              finding, mapped to a standard your buyer already cites. Nothing here
              is a wrapper around a checklist. These are the modules that mint
              kolm&rsquo;s per-call receipts.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {CAPABILITIES.map((c) => (
              <Card key={c.kicker}>
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2">{c.body}</CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">{c.map}</p>
              </Card>
            ))}
          </div>
          <p className="mt-10 max-w-[64ch] text-[13px] leading-[1.6] text-ink-3">
            Scope is contractual. Permission posture, redaction and audit-trail
            integrity are assessed. Injection is tested and reported, not
            warranted.
          </p>
        </div>
      </section>

      {/* ====================== ARCHITECTURE (LEDGER) =================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">03 / Architecture</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Onramp, sign, log, verify.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              Two ways in, one way out. Import your existing logs or run a sidecar
              proxy, and the same attestation core seals every finding into a
              report anyone you hand it to can check offline.
            </p>
          </div>

          <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
            {ARCH.map((node, i) => (
              <div key={node.n} className="contents">
                <div className="flex flex-col gap-3 rounded-lg border border-[var(--line-ink)] bg-[var(--ink-deep-2)] p-5">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[var(--line-ink-2)] text-[var(--accent-on-ink)]">
                    <node.icon className="h-[21px] w-[21px]" />
                  </span>
                  <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-on-ink-3">
                    {node.n}
                  </span>
                  <span className="font-sans text-[17px] font-semibold tracking-[-0.01em] text-on-ink">
                    {node.t}
                  </span>
                  <p className="text-[13.5px] leading-[1.5] text-on-ink-2">
                    {node.d}
                  </p>
                </div>
                {i < ARCH.length - 1 && (
                  <div
                    aria-hidden="true"
                    className="hidden items-center justify-center px-2 text-on-ink-3 md:flex"
                  >
                    <ArrowIcon className="h-3.5 w-[26px]" />
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="mt-10 max-w-[56ch] text-[13px] leading-[1.6] text-on-ink-3">
            The verifier, the CLI and the library all use the identical
            canonicalization, and the verifier is open source. The trust path has
            no black box.
          </p>
        </div>
      </section>

      {/* =========================== ALWAYS CURRENT ===================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">04 / Always current</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              A report is a photograph. Your agent is a film.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A point-in-time report goes stale on the next deploy. Continuous
              re-attests weekly or on every release and exposes one live Trust link
              you hand any buyer. No human in the loop.
            </p>
          </div>
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div className="grid gap-[11px] rounded-lg border border-line bg-paper-sink p-5 font-mono text-[13.5px] leading-[1.5] text-ink-3">
              {[
                {
                  k: "trust_url",
                  v: (
                    <>
                      <b className="font-medium text-ink">
                        kolm.ai/trust/acme-support
                      </b>{" "}
                      <span className="ml-2 inline-block rounded-sm border border-line bg-paper-2 px-[7px] py-px text-[10.5px] text-ink-3">
                        hand this to the buyer
                      </span>
                    </>
                  ),
                },
                {
                  k: "status",
                  v: (
                    <b className="font-semibold text-[var(--accent-text)]">
                      current
                    </b>
                  ),
                },
                {
                  k: "cadence",
                  v: (
                    <>
                      on every deploy{" "}
                      <span className="ml-2 inline-block rounded-sm border border-line bg-paper-2 px-[7px] py-px text-[10.5px] text-ink-3">
                        re-signed automatically
                      </span>
                    </>
                  ),
                },
                { k: "last_attested", v: "2026-06-08T09:14Z" },
                {
                  k: "public_key",
                  v: <b className="font-medium text-ink">ed25519 · embedded PEM</b>,
                },
                {
                  k: "signature",
                  v: (
                    <>
                      <b className="font-medium text-ink">
                        ed25519:9fA2c1d4...b07e
                      </b>{" "}
                      <span className="ml-2 inline-block rounded-sm border border-line bg-paper-2 px-[7px] py-px text-[10.5px] text-ink-3">
                        covers the canonical bytes
                      </span>
                    </>
                  ),
                },
                {
                  k: "log_proof",
                  v: (
                    <b className="font-medium text-ink">
                      merkle · inclusion verified
                    </b>
                  ),
                },
              ].map((row, i, arr) => (
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
            <div>
              <h3 className="font-sans text-[20px] font-semibold leading-[1.3] tracking-[-0.012em] text-ink">
                The evidence is never older than your last release
              </h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                Re-attestation runs on a schedule or on every deploy, re-signs
                without a person in the loop, and updates the live Trust link in
                place. The signature, the scope and the freshness date are all part
                of the signed object, so a buyer who re-opens the link sees current
                evidence, not a stale PDF.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Button asChild variant="ghost" size="sm">
                  <Link href="/trust">See a live Trust link</Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/pricing">Continuous pricing</Link>
                </Button>
              </div>
              <p className="mt-5 max-w-[56ch] text-[13px] leading-[1.6] text-ink-3">
                The EU AI Act Art.12 logging obligation has an enforcement date of
                Aug 2 2026. Continuous keeps the audit-trail evidence current for
                it.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ========================== PROOF (LEDGER) ====================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">05 / Proof</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              They don&rsquo;t trust us. They check the math.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              Security theater can&rsquo;t be falsified. This can. Two checks run in
              the buyer&rsquo;s own browser, against the key inside the report, with
              no kolm server in the path.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {PROOF.map((p) => (
              <Card key={p.kicker} ledger>
                <CardKicker className="text-on-ink-3">{p.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">{p.title}</CardTitle>
                <CardDescription className="mt-2 text-on-ink-2">
                  {p.body}
                </CardDescription>
              </Card>
            ))}
          </div>
          <div className="mt-10 flex flex-wrap gap-3">
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
                Download the sample
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* ============================ CTA FINAL ========================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[22ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Put your agent through the pipeline.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            One onramp, one signed object, and a review that moves at the speed of
            math.
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
              <Link href="/verify">Verify a report</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
