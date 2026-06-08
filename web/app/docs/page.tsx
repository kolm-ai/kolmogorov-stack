import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardKicker,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { CheckIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "How to put your agent into kolm (import the logs you already have or run a sidecar proxy), how a buyer verifies a signed report offline in the browser, the CLI, or a library, and the report schema each signature covers. No account, no server in the trust path.",
};

const HERO_TRUST = [
  "Verified offline, no account",
  "One canonicalization, everywhere",
  "Apache-2.0 verifier",
];

const STEPS = [
  {
    n: "Step 01",
    title: "Onramp your agent",
    body: "Import the logs you already produce, or run a sidecar proxy for a live capture. No rewrite.",
    href: "#onramp",
    cta: "Go to onramp",
  },
  {
    n: "Step 02",
    title: "Verify the report",
    body: "Your buyer checks the Ed25519 signature offline in the browser, the CLI, or a library.",
    href: "#verify",
    cta: "Go to verify",
  },
  {
    n: "Step 03",
    title: "Read the schema",
    body: "See the exact bytes a signature commits to, so any edit is self-evident.",
    href: "#report-schema",
    cta: "Go to the schema",
  },
];

const ONRAMP = [
  {
    kicker: "Import logs",
    title: "LiteLLM · Helicone · Portkey",
    body: "Bring the observability exports you already produce. kolm normalizes tool calls, scopes, and traffic. No code change, and it is the fastest path to a first read.",
    map: "fastest path to a first read",
  },
  {
    kicker: "Sidecar proxy",
    title: "MCP or proxy capture",
    body: "Route the agent through a sidecar for a live, append-only capture of exactly what it does, with tamper-evident hashing. Use it when you want the record built as the agent runs.",
    map: "live, append-only capture",
  },
];

const VERIFY_WAYS = [
  {
    kicker: "Browser",
    title: "Nothing to install",
    body: "Open the verifier and drop the report. The Ed25519 check runs in the page with WebCrypto, in front of the reviewer.",
    map: (
      <Link
        href="/verify"
        className="border-b border-[var(--line-ink-2)] text-on-ink hover:border-on-ink"
      >
        Open the verifier
      </Link>
    ),
  },
  {
    kicker: "CLI",
    title: "In your pipeline",
    body: "Verify in CI or a terminal with one command. It exits non-zero on a bad signature, so a forged or edited report gates the build.",
    map: "apache-2.0",
  },
  {
    kicker: "Library",
    title: "In your app",
    body: "Import the verifier and check reports inside your own tooling. It is the same function the browser widget calls.",
    map: "node 20+ · WebCrypto",
  },
];

const SCHEMA_RULES: { rule: string; def: string }[] = [
  {
    rule: "Field order",
    def: "A fixed, documented order of the signed fields, not source order, not alphabetical-by-accident.",
  },
  {
    rule: "Present-only",
    def: "Absent fields are omitted, not nulled. The byte string contains exactly the fields that exist.",
  },
  {
    rule: "No whitespace",
    def: "Compact JSON (no spaces, no newlines) so two semantically equal reports are byte-equal.",
  },
  {
    rule: "Self-exclusion",
    def: "The signature field is excluded from the bytes it signs.",
  },
  {
    rule: "Algorithm",
    def: "Ed25519 (RFC 8037) over the canonical bytes, with SHA-256 content hashes.",
  },
  {
    rule: "Key fingerprint",
    def: "SHA-256 of the SPKI DER public key, truncated to 128 bits. Documented, deterministic, pinnable.",
  },
];

const SCHEMA_REGISTER: { k: string; v: React.ReactNode }[] = [
  { k: "schema", v: "kolm-audit-report-1" },
  { k: "report_id", v: "asrr_sample" },
  {
    k: "subject",
    v: (
      <>
        what was assessed{" "}
        <span className="ml-2 inline-block rounded-sm border border-line bg-paper-2 px-[7px] py-px text-[10.5px] text-ink-3">
          scoped
        </span>
      </>
    ),
  },
  {
    k: "readiness_pct",
    v: <b className="font-medium text-ink">assessed controls only</b>,
  },
  { k: "findings", v: "count by severity" },
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
        <b className="font-medium text-ink">ed25519:0XCoqRkb...</b>{" "}
        <span className="ml-2 inline-block rounded-sm border border-line bg-paper-2 px-[7px] py-px text-[10.5px] text-ink-3">
          covers the canonical bytes
        </span>
      </>
    ),
  },
];

export default function DocsPage() {
  return (
    <>
      {/* ============================== START HERE ======================= */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <div className="max-w-[70ch]">
            <p className="eyebrow mb-4">01 / Start here</p>
            <h1 className="font-display text-[clamp(32px,5vw,52px)] font-extrabold leading-[1.04] tracking-[-0.035em] text-ink">
              Hand your reviewer a report they can check themselves.
            </h1>
            <p className="mt-5 max-w-[62ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              These docs cover the three things you do with kolm: get your
              agent&rsquo;s activity in, hand your buyer a signed report, and let
              them verify it offline against your key, with no account and no kolm
              server in the trust path. Read in order, or jump to the part your
              review is stuck on.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <Link href="/verify">Open the verifier</Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/report">Anatomy of a report</Link>
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

          <div className="mt-12 grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <Card key={s.n}>
                <CardKicker>{s.n}</CardKicker>
                <CardTitle className="mt-2">{s.title}</CardTitle>
                <CardDescription className="mt-2">{s.body}</CardDescription>
                <Link
                  href={s.href}
                  className="mt-3 inline-block font-mono text-[11px] font-medium tracking-[0.02em] text-ink-3"
                >
                  <span className="border-b border-line-2">{s.cta}</span>
                </Link>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== ONRAMP ========================== */}
      <section id="onramp" className="border-b border-line scroll-mt-[90px]">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">02 / Onramp</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Get your agent&rsquo;s activity in.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Two onramps, one outcome. Import the logs you already have, or run a
              sidecar proxy for a live capture. Either way there is no change to the
              agent, and you upload redacted logs: the scope is what you send, and
              the report states it.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {ONRAMP.map((o) => (
              <Card key={o.kicker}>
                <CardKicker>{o.kicker}</CardKicker>
                <CardTitle className="mt-2">{o.title}</CardTitle>
                <CardDescription className="mt-2">{o.body}</CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">{o.map}</p>
              </Card>
            ))}
          </div>
          <p className="mt-10 max-w-[64ch] text-[13px] leading-[1.6] text-ink-3">
            Once the activity is in, the audit and signing run as compute. See{" "}
            <Link
              href="/how-it-works"
              className="border-b border-line-2 text-ink hover:border-ink"
            >
              how it works
            </Link>{" "}
            for the full lifecycle.
          </p>
        </div>
      </section>

      {/* ========================= VERIFY (LEDGER) ====================== */}
      <section id="verify" className="relative border-b border-line bg-ink-deep text-on-ink scroll-mt-[90px]">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">03 / Verify a report</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Your buyer verifies it offline.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              The same Ed25519 check runs three ways, with the identical
              canonicalization. No account, no upload, no kolm server in the trust
              path. The report carries the public key it was signed with, so the
              check needs nothing from us.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {VERIFY_WAYS.map((w) => (
              <Card key={w.kicker} ledger>
                <CardKicker className="text-on-ink-3">{w.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">{w.title}</CardTitle>
                <CardDescription className="mt-2 text-on-ink-2">
                  {w.body}
                </CardDescription>
                <p className="mt-4 font-mono text-[12px] text-on-ink-3">
                  {w.map}
                </p>
              </Card>
            ))}
          </div>

          <div className="mt-12 grid gap-10 lg:grid-cols-2 lg:items-start">
            <div>
              <h3 className="font-sans text-[20px] font-semibold leading-[1.3] tracking-[-0.012em] text-on-ink">
                Verify in a few lines.
              </h3>
              <p className="mt-3 max-w-[50ch] text-[16px] leading-[1.55] text-on-ink-2">
                The verifier returns a structured result (it never throws) and
                tells you exactly which checks passed. Pass the issuer&rsquo;s key
                to also assert the report came from the key you expected: a rogue
                key clears the signature check but fails the issuer check.
              </p>
              <p className="mt-4 font-mono text-[11px] leading-relaxed text-on-ink-3">
                verifyReceipt(report, &#123; pinnedPublicKeyPem &#125;) returns
                &#123; ok, reason?, key_fingerprint, checks[] &#125;
              </p>
            </div>
            <div className="overflow-x-auto rounded-lg border border-[var(--line-ink)] bg-[var(--ink-deep-sink)] p-5 font-mono text-[13px] leading-[1.75] text-on-ink-2">
              <div>
                <span className="text-on-ink-3">import</span>
                &nbsp;&nbsp;
                <span className="font-medium text-on-ink">
                  &#123; verifyReceipt &#125;
                </span>{" "}
                from &apos;/kolm-verify.js&apos;
              </div>
              <div>&nbsp;</div>
              <div>
                <span className="text-on-ink-3">const</span>
                &nbsp;&nbsp;report ={" "}
                <span className="font-medium text-on-ink">await</span>{" "}
                fetch(url).then(r =&gt; r.json())
              </div>
              <div>
                <span className="text-on-ink-3">const</span>
                &nbsp;&nbsp;res ={" "}
                <span className="font-medium text-on-ink">await</span>{" "}
                verifyReceipt(report, &#123; pinnedPublicKeyPem &#125;)
              </div>
              <div>&nbsp;</div>
              <div>
                <span className="text-on-ink-3">if</span>
                &nbsp;&nbsp;(res.ok){" "}
                <span className="ml-2 inline-block rounded-sm border border-[var(--line-ink)] bg-[var(--ink-deep-2)] px-[7px] py-px text-[10.5px] text-on-ink-3">
                  signature valid, key matches
                </span>
              </div>
              <div>
                <span className="text-on-ink-3">else</span>
                &nbsp;&nbsp;res.reason{" "}
                <span className="ml-2 inline-block rounded-sm border border-[var(--line-ink)] bg-[var(--ink-deep-2)] px-[7px] py-px text-[10.5px] text-on-ink-3">
                  why it failed
                </span>
              </div>
            </div>
          </div>

          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/verify">Open the verifier</Link>
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

      {/* ========================= THE REPORT SCHEMA ==================== */}
      <section
        id="report-schema"
        className="border-b border-line scroll-mt-[90px]"
      >
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">04 / The report schema</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              What the signature covers.
            </h2>
            <p className="mt-4 text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              A report is one canonical object. These rules define the exact bytes
              the signature commits to, so two semantically equal reports are
              byte-equal and any edit is self-evident. The browser, the CLI, and
              the library all apply them the same way.
            </p>
          </div>

          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] border-collapse text-[14px]">
              <thead>
                <tr>
                  {["Rule", "Definition"].map((h) => (
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
                {SCHEMA_RULES.map((r, i) => {
                  const b =
                    i < SCHEMA_RULES.length - 1 ? "border-b border-line" : "";
                  return (
                    <tr key={r.rule}>
                      <td
                        className={`w-[200px] p-[15px] align-top text-ink-2 ${b}`}
                      >
                        <b className="font-mono font-semibold text-ink">
                          {r.rule}
                        </b>
                      </td>
                      <td className={`p-[15px] align-top text-ink-2 ${b}`}>
                        {r.def}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-12 grid gap-10 lg:grid-cols-2 lg:items-start">
            <div className="grid gap-[11px] rounded-lg border border-line bg-paper-sink p-5 font-mono text-[13.5px] leading-[1.5] text-ink-3">
              {SCHEMA_REGISTER.map((row, i, arr) => (
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
                One object, every fact in mono.
              </h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                Top-level fields name what was assessed, the findings, and the
                signing key, all in a single canonical artifact. The cryptographic
                values (the key fingerprint, the signature) are facts, so they are
                set in mono. Field-by-field, the page at{" "}
                <Link
                  href="/report"
                  className="border-b border-line-2 text-ink hover:border-ink"
                >
                  Anatomy of a report
                </Link>{" "}
                walks the whole schema.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Button asChild variant="ghost" size="sm">
                  <Link href="/report">Anatomy of a report</Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <a href="/sample-audit-report.json" download>
                    See a sample report
                  </a>
                </Button>
              </div>
            </div>
          </div>

          <p className="mt-10 max-w-[64ch] text-[13px] leading-[1.6] text-ink-3">
            Scope is contractual. Permission posture, redaction and audit-trail
            integrity are assessed. Injection is tested and reported, not
            warranted.
          </p>
        </div>
      </section>

      {/* ============================ CTA FINAL ========================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Verify the sample, then bring your own.
          </h2>
          <p className="mx-auto mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            Open the verifier on a signed sample, then onramp your agent and hand
            your buyer a report they can check in their own browser.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/verify">Open the verifier</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/report">Anatomy of a report</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
