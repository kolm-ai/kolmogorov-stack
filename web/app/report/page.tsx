import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardKicker,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { VerifyWidget } from "@/components/verify-widget";
import { CheckIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "The report",
  description:
    "A kolm evidence report is one canonical object: scope, content hashes, an Ed25519 signature over the exact bytes, and a transparency-log inclusion proof. Read it field by field, then verify a real sample live in your browser.",
};

const HERO_TRUST = [
  "One signed object",
  "Ed25519 over the exact bytes",
  "Verified offline, against your key",
];

const REGISTER: { k: string; v: React.ReactNode }[] = [
  { k: "schema", v: "kolm-audit-report-1" },
  { k: "report_id", v: "asrr_sample" },
  {
    k: "subject",
    v: (
      <>
        Helpwise support &amp; billing agents{" "}
        <span className="ml-2 inline-block rounded-sm border border-[var(--line-ink)] bg-[var(--ink-deep-2)] px-[7px] py-px text-[10.5px] text-on-ink-3">
          what was assessed
        </span>
      </>
    ),
  },
  {
    k: "readiness_pct",
    v: (
      <>
        <b className="font-medium text-on-ink">0</b>{" "}
        <span className="ml-2 inline-block rounded-sm border border-[var(--line-ink)] bg-[var(--ink-deep-2)] px-[7px] py-px text-[10.5px] text-on-ink-3">
          assessed controls only
        </span>
      </>
    ),
  },
  {
    k: "findings",
    v: (
      <>
        6 · <b className="font-medium text-on-ink">5 high</b> · 1 low
      </>
    ),
  },
  {
    k: "public_key",
    v: <b className="font-medium text-on-ink">ed25519 · embedded PEM</b>,
  },
  {
    k: "key_fingerprint",
    v: <b className="font-medium text-on-ink">410302c93becdcc3...</b>,
  },
  {
    k: "signature",
    v: (
      <>
        <b className="font-medium text-on-ink">ed25519:0XCoqRkbLg...sEjBDw</b>{" "}
        <span className="ml-2 inline-block rounded-sm border border-[var(--line-ink)] bg-[var(--ink-deep-2)] px-[7px] py-px text-[10.5px] text-on-ink-3">
          covers the canonical bytes
        </span>
      </>
    ),
  },
  {
    k: "inclusion",
    v: (
      <>
        <b className="font-medium text-on-ink">tlog · per-report Merkle proof</b>{" "}
        <span className="ml-2 inline-block rounded-sm border border-[var(--line-ink)] bg-[var(--ink-deep-2)] px-[7px] py-px text-[10.5px] text-on-ink-3">
          append-only
        </span>
      </>
    ),
  },
  {
    k: "verify_url",
    v: <b className="font-medium text-on-ink">kolm.ai/verify</b>,
  },
];

const ANATOMY = [
  {
    kicker: "01 · payload",
    title: "Canonical payload",
    body: "Key-sorted, whitespace-free JSON in a fixed field order. The signature covers these exact bytes, so a downgraded finding or an inflated score is self-evident the moment a reviewer re-checks.",
  },
  {
    kicker: "02 · signature",
    title: "Ed25519 signature, embedded key",
    body: "The signature and the public key it was made with travel together. Your buyer needs nothing from us: the verifier runs offline against the key inside the report.",
  },
  {
    kicker: "03 · inclusion",
    title: "Append-only inclusion proof",
    body: "A Merkle inclusion proof from an RFC 6962 style log confirms the report was recorded when it claims and was never quietly replaced. Not a chain, an append-only transparency log.",
  },
];

const CROSSWALK: { ctrl: string; name: string; checks: string; maps: string }[] =
  [
    {
      ctrl: "ASR-1",
      name: "Least privilege",
      checks: "Scopes the agent holds versus the scopes it uses",
      maps: "SOC 2 CC6 · OWASP ASI · NIST MANAGE-1",
    },
    {
      ctrl: "ASR-2",
      name: "Audit trail",
      checks: "Append-only, hash-chained, retained activity log",
      maps: "EU AI Act Art.12 · SOC 2 CC7",
    },
    {
      ctrl: "ASR-3",
      name: "Data egress",
      checks: "Destinations, approved sub-processors, redaction",
      maps: "OWASP LLM02 · EU AI Act Art.10",
    },
    {
      ctrl: "ASR-4",
      name: "Injection",
      checks: "Instruction hijack, indirect injection, guardrail bypass",
      maps: "OWASP LLM01 · MITRE ATLAS",
    },
    {
      ctrl: "ASR-5",
      name: "Provenance",
      checks: "Model and dependency provenance",
      maps: "ISO 42001 · NIST MAP-1",
    },
    {
      ctrl: "ASR-6",
      name: "Evidence",
      checks: "Signed, logged, offline-verifiable report",
      maps: "SOC 2 CC7 · ISO 42001",
    },
  ];

export default function ReportPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <div className="max-w-[66ch]">
            <p className="eyebrow mb-4">01 / The artifact is the proof</p>
            <h1 className="font-display text-[clamp(32px,5vw,52px)] font-extrabold leading-[1.04] tracking-[-0.035em] text-ink">
              One object your buyer can check, not a PDF they have to trust.
            </h1>
            <p className="mt-5 max-w-[62ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              When a deal stalls in security review, the buyer&rsquo;s group will
              not take your word, or a slide. A kolm report is a single canonical
              object: a scope, content hashes, an Ed25519 signature over the exact
              bytes, and an append-only inclusion proof. Every cryptographic fact
              is set in mono, because a fact should read like a fact. Here is the
              object, line by line, then a real one you can verify in this browser.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <Link href="#live">Verify the sample</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/how-it-works">How it works</Link>
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

      {/* ====================== THE REGISTER (LEDGER) =================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">02 / The register</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              One object, fully self-describing.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              The report carries its own scope, its own content hashes, its own
              signature, and the public key needed to check it. Nothing about
              verifying it depends on kolm being online, or even existing.
            </p>
          </div>
          <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
            <div className="grid gap-[11px] rounded-lg border border-[var(--line-ink)] bg-[var(--ink-deep-sink)] p-5 font-mono text-[13.5px] leading-[1.5] text-on-ink-2">
              {REGISTER.map((row, i, arr) => (
                <div
                  key={row.k}
                  className={`grid grid-cols-[max-content_1fr] gap-[14px] pb-[10px] ${i < arr.length - 1 ? "border-b border-[var(--line-ink)]" : "pb-0"}`}
                >
                  <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-on-ink-3">
                    {row.k}
                  </span>
                  <span className="break-all text-on-ink-2">{row.v}</span>
                </div>
              ))}
            </div>
            <div className="grid gap-3.5">
              {ANATOMY.map((a) => (
                <Card key={a.kicker} ledger>
                  <CardKicker className="text-on-ink-3">{a.kicker}</CardKicker>
                  <CardTitle className="mt-2 text-on-ink">{a.title}</CardTitle>
                  <CardDescription className="mt-2 text-on-ink-2">
                    {a.body}
                  </CardDescription>
                </Card>
              ))}
            </div>
          </div>
          <p className="mt-10 max-w-[64ch] text-[13px] leading-[1.6] text-on-ink-3">
            Every line above is part of the signed bytes. Edit one character and
            the signature, and the seal, stop matching.
          </p>
        </div>
      </section>

      {/* ============================ THE CROSSWALK ===================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">03 / The crosswalk</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Every finding maps to a control they already cite.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A reviewer should not have to learn our vocabulary. Each control on
              the report points to the framework clause their questionnaire already
              references, so they trace a result to a standard in one step.
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] border-collapse text-[14px]">
              <thead>
                <tr>
                  {["Control", "What it checks", "Maps to"].map((h) => (
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
                {CROSSWALK.map((r, i) => {
                  const b =
                    i < CROSSWALK.length - 1 ? "border-b border-line" : "";
                  return (
                    <tr key={r.ctrl}>
                      <td className={`p-[15px] align-top text-ink-2 ${b}`}>
                        <b className="font-mono font-semibold text-ink">
                          {r.ctrl}
                        </b>{" "}
                        {r.name}
                      </td>
                      <td className={`p-[15px] align-top text-ink-2 ${b}`}>
                        {r.checks}
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
          <p className="mt-8 max-w-[64ch] text-[13px] leading-[1.6] text-ink-3">
            Scope is contractual. Permission posture, redaction and audit-trail
            integrity are assessed. Injection is tested and reported, not
            warranted.
          </p>
        </div>
      </section>

      {/* ========================= VERIFY THIS SAMPLE =================== */}
      <section id="live" className="border-b border-line scroll-mt-[90px]">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[64ch]">
            <p className="eyebrow mb-3">04 / Verify this sample</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Do not take the diagram&rsquo;s word for it.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Below is a real, signed artifact produced by the same signing core,
              verified entirely in this browser. Tamper a field and the signature
              breaks, every time. No account, no upload, no kolm server in the
              path.
            </p>
          </div>
          <div className="grid gap-10 lg:grid-cols-2 lg:items-start">
            <div className="lg:sticky lg:top-[90px]">
              <VerifyWidget />
            </div>
            <Card className="lg:h-full">
              <CardKicker>What you are seeing</CardKicker>
              <CardTitle className="mt-2">
                The same crypto core that signs a full audit
              </CardTitle>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                This sample is a real signed report minted by kolm&rsquo;s
                attestation core: the identical canonicalization, signing, and
                verification path every audit report uses. Verify it here, or open
                the dedicated verifier to paste your own.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Button asChild size="sm">
                  <Link href="/verify">Open the verifier</Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <a href="/sample-audit-report.json" download>
                    Download the sample
                  </a>
                </Button>
              </div>
            </Card>
          </div>
        </div>
      </section>

      {/* ============================ CTA FINAL ========================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Get a report like this for your agent.
          </h2>
          <p className="mx-auto mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            A scoped audit that ends in one signed object your buyer verifies in
            their own browser. The four to eight week review compresses to days.
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
