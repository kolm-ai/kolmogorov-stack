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
import {
  CheckIcon,
  ShieldIcon,
  LogIcon,
  KeyIcon,
  ArrowIcon,
} from "@/components/icons";

export const metadata: Metadata = {
  title: "Security",
  description:
    "To run a scan you upload redacted logs. Here is how kolm holds that data: redaction before processing, scoped per-tenant access, minimal retention, Ed25519 key management, a Merkle transparency log, and disclosure at dev@kolm.ai.",
};

const TRUSTLINE = [
  "Redacted before it reaches us",
  "Processed in scope, then discarded",
  "Ed25519-signed, verifiable offline",
];

const HOLD = [
  {
    kicker: "What you send",
    title: "Redacted logs, not raw traffic",
    body: "A scan runs on logs you redact before upload. Secrets, customer identifiers, and payloads you strip stay on your side. We work from exactly what you choose to send.",
    map: "ASR-3 · data egress",
  },
  {
    kicker: "What we touch",
    title: "Only what the engagement scopes",
    body: (
      <>
        Processing is bounded by the scope in your engagement. Access is scoped
        per tenant with per-row fences, so one tenant&rsquo;s data is never in
        another&rsquo;s query path.
      </>
    ),
    map: "ASR-1 · least privilege",
  },
  {
    kicker: "What we keep",
    title: "The signed artifact, not your raw data",
    body: "The output is one signed evidence report and its log entry. Raw uploaded logs are not retained past the run that produced it. The report is the record; the inputs are not.",
    map: "ASR-6 · evidence",
  },
];

const FLOW = [
  {
    icon: LogIcon,
    n: "01 · Redact",
    t: "You strip it first",
    d: "Logs are redacted on your side before upload. Field-level redaction removes secrets and customer identifiers before anything reaches our processing.",
  },
  {
    icon: ShieldIcon,
    n: "02 · Process",
    t: "We work in scope",
    d: "Processing runs against the redacted input inside the assessed scope. Data is encrypted in transit (TLS 1.3) and at rest (AES-256), isolated per tenant.",
  },
  {
    icon: CheckIcon,
    n: "03 · Retain",
    t: "We keep the report",
    d: "What persists is the signed report and its log entry. Raw uploads are not retained beyond the run. Minimal retention by default, not by request.",
  },
];

const HANDLING_CARDS = [
  {
    kicker: "Encryption",
    title: "AES-256 at rest, TLS 1.3 in transit",
    body: "Data in the hosted control plane is encrypted at rest with AES-256 (AWS KMS, per-tenant data keys). Client traffic uses TLS 1.3 with HSTS.",
  },
  {
    kicker: "Isolation",
    title: "Per-tenant, per-namespace, per-row",
    body: "Data is isolated at the tenant and namespace level, with per-row tenant fences inside every query handler. Defense in depth, not a single boundary.",
  },
  {
    kicker: "Access",
    title: "SSO-gated, MFA-enforced, reviewed quarterly",
    body: "Engineering access to the control plane is SSO-gated and MFA-enforced, reviewed quarterly. Production access is written to an immutable audit store.",
  },
];

const SIGNING_FACTS = [
  "Reports are canonicalized to JCS, hashed with SHA-256, then signed with Ed25519",
  "The private key stays in the signing service; only the public key fingerprint travels in the report",
  "Editing any field after signing invalidates the signature, in front of the reviewer",
  "Rotation runs via kolm keys rotate on a defined cadence",
  "Prior reports stay verifiable because each carries the fingerprint it was signed with",
];

const SIGNING_REGISTER: { k: string; v: React.ReactNode }[] = [
  { k: "key_id", v: <b className="text-on-ink">kolm-prod-2026</b> },
  { k: "algorithm", v: "ed25519" },
  { k: "public_key", v: <b className="text-on-ink">ed25519 · embedded PEM</b> },
  { k: "fingerprint", v: <b className="text-on-ink">fa562154...c0a4</b> },
  {
    k: "private_key",
    v: (
      <>
        stays in the signer{" "}
        <span className="text-on-ink-3">not in any report</span>
      </>
    ),
  },
  {
    k: "rotation",
    v: (
      <>
        defined cadence{" "}
        <span className="text-on-ink-3">kolm keys rotate</span>
      </>
    ),
  },
  { k: "prior_reports", v: <b className="text-on-ink">remain verifiable</b> },
];

const LOG_REGISTER: { k: string; v: React.ReactNode }[] = [
  { k: "structure", v: "rfc6962-merkle" },
  { k: "hash", v: "sha-256" },
  {
    k: "append_only",
    v: (
      <>
        <b className="text-on-ink">true</b>{" "}
        <span className="text-on-ink-3">no edits, no deletes</span>
      </>
    ),
  },
  {
    k: "tree_size",
    v: (
      <>
        1428 <span className="text-on-ink-3">illustrative</span>
      </>
    ),
  },
  { k: "root", v: <b className="text-on-ink">sha256:7b91...c0a4</b> },
  { k: "inclusion", v: "per-report proof" },
  { k: "live_root", v: "kolm.ai/transparency-log" },
];

const DISCLOSURE_TERMS = [
  "We acknowledge within 24 hours and triage within 72 hours",
  "Coordinated disclosure window of 90 days from a verified report",
  "We aim to remediate well before the window closes, and we say so proactively if a fix needs longer",
  "We do not pursue legal action against researchers acting in good faith under this policy",
];

const DISCLOSURE_CARDS = [
  {
    kicker: "Dependency hygiene",
    title: "Critical CVEs in 7 days",
    body: "Critical CVEs in dependencies are patched within 7 days, high severity within 30. A CycloneDX SBOM ships with every CLI release, signed and verifiable against the release tag.",
  },
  {
    kicker: "Supply chain",
    title: "Signed, reproducible releases",
    body: "CLI releases are signed and built from a reproducible script in the public repository, so a downstream consumer can audit the dependency tree and confirm the bytes.",
  },
  {
    kicker: "Incident response",
    title: "On-call, with a written follow-up",
    body: "An on-call rotation covers the hosted gateway and signing pipeline. Post-incident reviews are shared with affected enterprise customers within 14 days of closure.",
  },
];

function Register({ rows }: { rows: { k: string; v: React.ReactNode }[] }) {
  return (
    <Card ledger className="font-mono text-[12.5px] leading-relaxed">
      {rows.map((r) => (
        <div
          key={r.k}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-[var(--line-ink)] py-2 last:border-0"
        >
          <span className="w-[104px] flex-none text-on-ink-3">{r.k}</span>
          <span className="text-on-ink-2">{r.v}</span>
        </div>
      ))}
    </Card>
  );
}

export default function SecurityPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">Security</p>
          <h1 className="max-w-[24ch] font-display text-[clamp(36px,5.6vw,58px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-ink">
            You are handing us logs. Here is what we do with them.
          </h1>
          <p className="mt-6 max-w-[68ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
            To run a scan you upload redacted logs. This page is the operational
            record of how we hold that data: what we process, what we keep, and
            what we discard. Concrete, not reassuring. The signing facts below
            are the same ones your buyer checks offline.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/verify">Verify a report</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/contact">Start an audit</Link>
            </Button>
          </div>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-ink-3">
            {TRUSTLINE.map((t) => (
              <span key={t} className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                {t}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== POSTURE STRIP ============================== */}
      <section className="border-b border-line" aria-label="Posture at a glance">
        <div className="mx-auto max-w-wrap px-6 py-10">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Badge variant="verified">Ed25519-signed</Badge>
            <span className="inline-flex items-center gap-2 text-[14px] text-ink-2">
              <ShieldIcon className="h-4 w-4 text-ink-3" />
              AES-256 at rest, TLS 1.3 in transit
            </span>
            <span className="inline-flex items-center gap-2 text-[14px] text-ink-2">
              <LogIcon className="h-4 w-4 text-ink-3" />
              <Link href="/transparency-log" className="hover:text-ink">
                Merkle transparency log (RFC 6962 style)
              </Link>
            </span>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {[
              "SSO + MFA",
              "Quarterly access review",
              "Per-tenant isolation",
              "Minimal retention",
              "SBOM per release",
            ].map((c) => (
              <span key={c} className="ctrlid">
                {c}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 01 / HOW WE HOLD YOUR DATA ============================== */}
      <section className="border-b border-line" id="data">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / How we hold your data</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              The data you send is redacted, scoped, and short-lived.
            </h2>
            <p className="mt-4 max-w-[60ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              You are evaluating a vendor with your own logs. Reasonable people
              want to know exactly what leaves their side and how long it lives
              on ours. The answer is small: redacted input in, a signed report
              out, and very little kept in between.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {HOLD.map((c) => (
              <Card key={c.kicker} className="flex flex-col">
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2 flex-1">
                  {c.body}
                </CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">{c.map}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 02 / DATA HANDLING (ledger) ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink" id="handling">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">02 / Data handling</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Redact. Process in scope. Retain only the artifact.
            </h2>
            <p className="mt-4 max-w-[60ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              One short lifecycle. Redaction happens on your side first,
              processing stays inside the assessed scope, and what persists
              afterward is the signed report, not your uploads.
            </p>
          </div>

          <div
            className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]"
            aria-label="The redact, process and retain lifecycle"
          >
            {FLOW.map((node, i) => (
              <div key={node.n} className="contents">
                <Card ledger className="flex flex-col">
                  <node.icon className="h-5 w-5 text-[var(--accent-on-ink)]" />
                  <span className="mt-3 font-mono text-[12px] font-medium text-on-ink-3">
                    {node.n}
                  </span>
                  <span className="mt-1 font-sans text-[18px] font-semibold text-on-ink">
                    {node.t}
                  </span>
                  <p className="mt-2 text-[14px] leading-relaxed text-on-ink-2">
                    {node.d}
                  </p>
                </Card>
                {i < FLOW.length - 1 && (
                  <div
                    aria-hidden="true"
                    className="hidden items-center justify-center text-on-ink-3 md:flex"
                  >
                    <ArrowIcon className="h-3.5 w-[26px]" />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {HANDLING_CARDS.map((c) => (
              <Card key={c.kicker} ledger>
                <CardKicker className="text-on-ink-3">{c.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">{c.title}</CardTitle>
                <CardDescription className="mt-2 text-on-ink-2">
                  {c.body}
                </CardDescription>
              </Card>
            ))}
          </div>

          <p className="mt-10 max-w-[74ch] border-l-2 border-[var(--accent-on-ink-edge)] pl-4 font-mono text-[13px] leading-[1.7] text-on-ink-2">
            Scope is contractual. Permission posture, redaction and audit-trail
            integrity are assessed. Injection is tested and reported, not
            warranted.
          </p>
        </div>
      </section>

      {/* ============================== 03 / SIGNING KEY MANAGEMENT ============================== */}
      <section className="border-b border-line" id="signing">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-10 max-w-[66ch]">
            <p className="eyebrow mb-3">03 / Signing key management</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              One Ed25519 key signs every report. The private half stays put.
            </h2>
            <p className="mt-4 max-w-[60ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              The signature your buyer checks is only as good as the key behind
              it. We keep that key small, single-purpose, and rotated, and we
              publish the fingerprint so verification needs nothing from us at
              check time.
            </p>
          </div>
          <div className="grid items-start gap-8 lg:grid-cols-2">
            <ul className="grid gap-3">
              {SIGNING_FACTS.map((f, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 text-[15px] leading-relaxed text-ink-2"
                >
                  <CheckIcon className="mt-[5px] h-4 w-4 flex-none text-[var(--accent)]" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Register rows={SIGNING_REGISTER} />
          </div>
        </div>
      </section>

      {/* ============================== 04 / TRANSPARENCY LOG ============================== */}
      <section className="border-b border-line" id="transparency">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-10 max-w-[66ch]">
            <p className="eyebrow mb-3">04 / Transparency log</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Every signature lands in a Merkle log you can audit.
            </h2>
            <p className="mt-4 max-w-[60ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A signature you cannot situate in a record is a signature you have
              to take on faith. Each signed report is appended to a public log,
              so a reviewer can confirm it was issued and never quietly altered.
            </p>
          </div>
          <div className="grid items-start gap-8 lg:grid-cols-2">
            <div className="text-[16px] leading-relaxed text-ink-2">
              <p>
                Each signed report is appended to a transparency log structured
                after RFC 6962. Entries are SHA-256 hashed into a Merkle tree, so
                no entry can be edited or removed without changing the root.
                Every report ships with an inclusion proof a reviewer checks
                independently.
              </p>
              <p className="mt-4">
                This is a Merkle log, not a blockchain. An Ed25519 and SHA-256
                append-only structure, with no tokens, no wallets, and no
                distributed ledger. The log is public and anyone can recompute
                the root.
              </p>
              <Button asChild variant="ghost" className="mt-6">
                <Link href="/transparency-log">View the transparency log</Link>
              </Button>
            </div>
            <Register rows={LOG_REGISTER} />
          </div>
        </div>
      </section>

      {/* ============================== 05 / RESPONSIBLE DISCLOSURE ============================== */}
      <section className="border-b border-line" id="disclosure">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-10 max-w-[66ch]">
            <p className="eyebrow mb-3">05 / Responsible disclosure</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Found something? Tell us, and you are covered.
            </h2>
            <p className="mt-4 max-w-[60ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              If you find a security issue in our hosted services, signing
              pipeline, CLI, or evidence format, report it to{" "}
              <a
                className="border-b border-line-2 text-ink hover:border-ink"
                href="mailto:dev@kolm.ai"
              >
                dev@kolm.ai
              </a>{" "}
              with a writeup, reproduction steps, and the impact you assessed.
            </p>
          </div>
          <ul className="mb-10 grid gap-2.5 border-l-2 border-line pl-5">
            {DISCLOSURE_TERMS.map((t, i) => (
              <li key={i} className="text-[15px] leading-relaxed text-ink-2">
                {t}
              </li>
            ))}
          </ul>
          <div className="grid gap-4 md:grid-cols-3">
            {DISCLOSURE_CARDS.map((c) => (
              <Card key={c.kicker}>
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2">{c.body}</CardDescription>
              </Card>
            ))}
          </div>
          <p className="mt-8 max-w-[80ch] border-l-2 border-accent-edge pl-4 font-mono text-[13px] leading-[1.7] text-ink-2">
            To be exact about kolm itself: we do not currently hold a SOC 2
            report, and there is no published third-party penetration test of our
            own infrastructure. We will not list either until it exists and can
            be verified. What we offer today is evidence you can check yourself:
            the signing facts above, the Merkle log, and the open verifier.
            Questions? Email{" "}
            <a className="text-accent-text hover:underline" href="mailto:dev@kolm.ai">
              dev@kolm.ai
            </a>
            .
          </p>
        </div>
      </section>

      {/* ============================== FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[22ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Checkable beats claimed.
          </h2>
          <p className="mx-auto mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            Pull a report, edit a byte, watch the seal break. The same Ed25519
            key signs everything we issue, and every signature lands in the log.
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
              <Link href="/transparency-log">View the transparency log</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
