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
import { VerifyWidget } from "@/components/verify-widget";
import { CheckIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "Trust center",
  description:
    "Everything on this page is checkable. Reports are Ed25519-signed and verifiable offline against our public key, findings map to SOC 2, ISO 42001, NIST AI RMF, EU AI Act, OWASP and MITRE ATLAS, redacted logs are kept only for the engagement, and every report is entered in an append-only Merkle transparency log.",
};

const TRUSTLINE = [
  "Signed, verifiable offline",
  "Mapped to your buyer's frameworks",
  "Nothing claimed we cannot show",
];

const WHY = [
  {
    kicker: "Independent verification",
    title: "Check any report yourself",
    body: "Every report is Ed25519-signed and checkable offline against kolm's public key. No account, no trust in our servers. The verifier is open source, so a reviewer reads it rather than takes our word.",
    map: { label: "Verify a report", href: "/verify" },
  },
  {
    kicker: "Framework mapping",
    title: "Findings tie to standards you cite",
    body: "Each finding maps to a control your review group already uses. kolm maps to these frameworks. It does not itself hold their certifications, and this page never pretends otherwise.",
    map: { label: "See the mapping", href: "#frameworks" },
  },
  {
    kicker: "What we do not hold",
    title: "Stated, not buried",
    body: "kolm does not currently hold a SOC 2 report or a published third-party pentest of its own. We will not claim either until it is real and verifiable.",
    map: { label: "candid by default", href: null },
  },
];

const POSTURE: { area: string; status: string; mapped: boolean; detail: string }[] =
  [
    {
      area: "Framework mapping",
      status: "Built in",
      mapped: true,
      detail:
        "Findings map to SOC 2 TSC, ISO 42001, NIST AI RMF, EU AI Act Art.12 and Art.14, OWASP and MITRE ATLAS. kolm maps to these standards, it does not hold their certifications.",
    },
    {
      area: "kolm's own SOC 2 / pentest",
      status: "Not held",
      mapped: false,
      detail:
        "kolm does not currently hold a SOC 2 report or a published third-party pentest of its own. We will not claim either until it is real and verifiable.",
    },
    {
      area: "Data retention",
      status: "Engagement-only",
      mapped: true,
      detail: "Redacted logs are used for the engagement and not kept beyond it.",
    },
    {
      area: "Attestation",
      status: "Ed25519 + tlog",
      mapped: true,
      detail:
        "Every report is signed and entered in an append-only Merkle transparency log.",
    },
    {
      area: "Verification",
      status: "Offline",
      mapped: true,
      detail:
        "Open WebCrypto verifier, with no kolm account or server in the trust path.",
    },
    {
      area: "Tooling license",
      status: "Apache-2.0",
      mapped: true,
      detail:
        "The verifier, the canonicalization, and the CLI are open and reproducible.",
    },
  ];

const FRAMEWORKS = ["SOC 2", "ISO 42001", "NIST AI RMF", "EU AI Act", "OWASP", "MITRE ATLAS"];

const FRAMEWORK_ROWS: { fw: React.ReactNode; governs: string; maps: string }[] = [
  {
    fw: (
      <>
        <b className="text-ink">SOC 2</b> TSC
      </>
    ),
    governs: "Security, availability and confidentiality controls",
    maps: "Least-privilege scopes · audit-trail integrity · evidence",
  },
  {
    fw: <b className="text-ink">ISO 42001</b>,
    governs: "AI management system",
    maps: "Model and dependency provenance · evidence",
  },
  {
    fw: <b className="text-ink">NIST AI RMF</b>,
    governs: "AI risk, mapped, measured and managed",
    maps: "Permission posture · injection resistance",
  },
  {
    fw: (
      <>
        <b className="text-ink">EU AI Act</b> Art.12 / Art.14
      </>
    ),
    governs: "Activity logging and human oversight",
    maps: "Append-only audit trail · oversight hooks",
  },
  {
    fw: (
      <>
        <b className="text-ink">OWASP</b> LLM &amp; Agentic Top 10
      </>
    ),
    governs: "LLM and agent attack classes",
    maps: "Prompt-injection battery · data egress",
  },
  {
    fw: <b className="text-ink">MITRE ATLAS</b>,
    governs: "Adversarial ML tactics and techniques",
    maps: "Injection · model provenance",
  },
];

const DATA_HANDLING = [
  {
    kicker: "Redaction",
    title: "Secrets stay out at the source",
    body: "You redact before anything reaches us. The scan reads the structure of agent activity, the scopes, the destinations, the trail, not the payloads underneath. Bring redacted logs, not raw data.",
    map: "ASR-3 · data egress",
  },
  {
    kicker: "Scoped keys",
    title: "Least privilege, revocable",
    body: "Where a connector is used, it holds read-only, narrowly scoped credentials, and you can revoke them the moment the audit ends. We ask for the minimum that lets the check run.",
    map: "ASR-1 · least privilege",
  },
  {
    kicker: "Retention",
    title: "Kept for the engagement, not after",
    body: "Redacted logs are used to produce the signed report and are not retained beyond the engagement. Subprocessors are listed in full, and the data terms are written down, not implied.",
    map: null,
  },
];

const REGISTER: { k: string; v: React.ReactNode }[] = [
  { k: "scheme", v: "rfc6962-style merkle log" },
  {
    k: "leaf",
    v: <b className="text-on-ink">sha-256(canonical_report_bytes)</b>,
  },
  { k: "sign", v: <b className="text-on-ink">ed25519(issuer_sk, leaf)</b> },
  {
    k: "tree",
    v: (
      <>
        append-only{" "}
        <span className="text-on-ink-3">leaves never edited</span>
      </>
    ),
  },
  {
    k: "root",
    v: (
      <>
        <b className="text-on-ink">sha-256 merkle root</b>{" "}
        <span className="text-on-ink-3">signed checkpoint</span>
      </>
    ),
  },
  {
    k: "proof",
    v: (
      <>
        <b className="text-on-ink">inclusion proof</b>{" "}
        <span className="text-on-ink-3">per report</span>
      </>
    ),
  },
  {
    k: "monitor",
    v: (
      <>
        consistency proofs{" "}
        <span className="text-on-ink-3">public, watch for rewrites</span>
      </>
    ),
  },
  {
    k: "chain",
    v: (
      <>
        <b className="text-on-ink">none</b>{" "}
        <span className="text-on-ink-3">no tokens, no consensus network</span>
      </>
    ),
  },
];

const LEDGER_CARDS = [
  {
    title: "Append-only, by construction",
    body: "New leaves are added, old ones are never changed. Altering a past entry changes the Merkle root, which breaks the signed checkpoint and is visible to anyone watching.",
  },
  {
    title: "An inclusion proof per report",
    body: "Each report ships a proof that it sits in the tree at a fixed position. Your buyer checks the proof offline and confirms the report is the exact one we logged.",
  },
  {
    title: "A Merkle log, plainly",
    body: "Ed25519 and SHA-256 over an append-only tree. No tokens, no consensus network, no chain in the trust path. The same primitives the verifier already checks.",
  },
];

const VERIFY_STEPS = [
  {
    kicker: "01 · Get the report",
    title: "Use the sample or your own",
    body: "Download the signed sample, or open the report your founder handed your review group. Both carry the public key and the signature inside the same canonical object.",
    map: { label: "Download the sample", href: "/sample-audit-report.json" },
  },
  {
    kicker: "02 · Tier 1, signature",
    title: "Edit one field, the seal breaks",
    body: "The Ed25519 signature covers the canonical bytes. Inflate the score or downgrade a finding and the match fails, on the spot, in the verifier.",
    map: { label: "VOID on any edit", href: null },
  },
  {
    kicker: "03 · Tier 2, issuer",
    title: "A rogue key clears one, fails the other",
    body: "The signing key is pinned to the keyring your buyer expects. Forge a fresh key and Tier 1 clears, but Tier 2 exposes the mismatch.",
    map: { label: "issuer provenance", href: null },
  },
];

const darkGhost =
  "border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]";

export default function TrustPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">Trust center</p>
          <h1 className="max-w-[22ch] font-display text-[clamp(38px,6vw,60px)] font-extrabold leading-[1.0] tracking-[-0.035em] text-ink">
            Your buyer&rsquo;s reviewers will check us too. Good.
          </h1>
          <p className="mt-6 max-w-[66ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
            When a security team vets your agent, they turn the same scrutiny on
            the evidence you hand them and on the company that signed it. This
            page is built for that. Every claim here links to something a
            reviewer can verify, download, or read the source of. Nothing is
            asserted without a way to check it.
          </p>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-ink-3">
            {TRUSTLINE.map((t) => (
              <span key={t} className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                {t}
              </span>
            ))}
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-2">
            <Badge variant="verified">Ed25519-signed evidence</Badge>
            <Badge>Offline-verifiable</Badge>
            <Badge>Framework-mapped</Badge>
            <Badge>Open-source verifier</Badge>
          </div>
        </div>
      </section>

      {/* ============================== 01 / WHY YOU CAN CHECK US ============================== */}
      <section className="border-b border-line" id="why">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">01 / Why you can check us</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              We hold ourselves to the bar we audit against.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              We ask startups to prove their agents are safe with signed,
              scoped, verifiable evidence. We build the same into every report we
              issue, and into this page. What is signed is signed. What is in
              progress is labeled. What we do not hold, we do not claim.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {WHY.map((c) => (
              <Card key={c.kicker} className="flex flex-col">
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2 flex-1">
                  {c.body}
                </CardDescription>
                <p className="mt-4 font-mono text-[12px] text-ink-3">
                  {c.map.href ? (
                    <a
                      href={c.map.href}
                      className="text-accent-text hover:underline"
                    >
                      {c.map.label}
                    </a>
                  ) : (
                    c.map.label
                  )}
                </p>
              </Card>
            ))}
          </div>

          {/* posture table */}
          <div className="mt-10 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-paper-sink">
                  {["Area", "Status", "Detail"].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {POSTURE.map((r) => (
                  <tr
                    key={r.area}
                    className="border-b border-line align-top last:border-0"
                  >
                    <td className="px-4 py-3.5 text-[14px] font-semibold text-ink">
                      {r.area}
                    </td>
                    <td className="px-4 py-3.5">
                      <Badge variant={r.mapped ? "verified" : "default"}>
                        {r.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3.5 text-[14px] leading-relaxed text-ink-2">
                      {r.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ============================== 02 / FRAMEWORKS WE MAP TO ============================== */}
      <section className="border-b border-line" id="frameworks">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-10 max-w-[66ch]">
            <p className="eyebrow mb-3">02 / Frameworks we map to</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              The standards your reviewers already cite.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Every finding traces to a control your buyer&rsquo;s questionnaire
              already names, so a reviewer reads the result against a framework
              they trust instead of one we invented.
            </p>
          </div>
          <div className="mb-6 flex flex-wrap items-center gap-2">
            {FRAMEWORKS.map((f) => (
              <span key={f} className="ctrlid">
                {f}
              </span>
            ))}
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-paper-sink">
                  {["Framework", "What it governs", "kolm findings that map"].map(
                    (h) => (
                      <th
                        key={h}
                        scope="col"
                        className="px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3"
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {FRAMEWORK_ROWS.map((r, i) => (
                  <tr
                    key={i}
                    className="border-b border-line align-top last:border-0"
                  >
                    <td className="px-4 py-3.5 text-[14px] text-ink-2">{r.fw}</td>
                    <td className="px-4 py-3.5 text-[14px] leading-relaxed text-ink-2">
                      {r.governs}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-[13px] leading-relaxed text-accent-text">
                      {r.maps}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 max-w-[74ch] border-l-2 border-accent-edge pl-4 font-mono text-[13px] leading-[1.7] text-ink-2">
            kolm maps findings to these frameworks. It does not certify them. The
            EU AI Act Art.12 logging obligation carries an enforcement date of
            Aug 2 2026, stated as a date, not a claim of compliance.
          </p>
        </div>
      </section>

      {/* ============================== 03 / DATA HANDLING ============================== */}
      <section className="border-b border-line" id="data">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">03 / Data handling</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              We see less than you think, and keep it for less time.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              The audit reads redacted activity logs, not your production
              secrets. You redact before upload, the credentials we hold are
              scoped and revocable, and what you send is used for the engagement
              and not retained beyond it.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {DATA_HANDLING.map((c) => (
              <Card key={c.kicker} className="flex flex-col">
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2 flex-1">
                  {c.body}
                </CardDescription>
                {c.map ? (
                  <p className="mt-4 font-mono text-[12px] text-ink-3">{c.map}</p>
                ) : (
                  <p className="mt-4 font-mono text-[12px] text-ink-3">
                    <a
                      href="/dpa"
                      className="text-accent-text hover:underline"
                    >
                      DPA
                    </a>{" "}
                    ·{" "}
                    <a
                      href="/subprocessors"
                      className="text-accent-text hover:underline"
                    >
                      Subprocessors
                    </a>
                  </p>
                )}
              </Card>
            ))}
          </div>
          <p className="mt-8 max-w-[74ch] border-l-2 border-accent-edge pl-4 font-mono text-[13px] leading-[1.7] text-ink-2">
            Scope is contractual. Permission posture, redaction and audit-trail
            integrity are assessed. Injection is tested and reported, not
            warranted.
          </p>
        </div>
      </section>

      {/* ============================== 04 / TRANSPARENCY LOG (ledger) ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink" id="transparency">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">04 / Transparency log</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Every report is logged where anyone can watch.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              Each issuance is appended to a public, tamper-evident log, so a
              reviewer can confirm the report you handed them is the one we
              signed and that we have not quietly rewritten history. It is an
              append-only Merkle log in the RFC 6962 style, built on Ed25519 and
              SHA-256. It is not a blockchain.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card ledger className="font-mono text-[12.5px] leading-relaxed">
              {REGISTER.map((r) => (
                <div
                  key={r.k}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-[var(--line-ink)] py-2 last:border-0"
                >
                  <span className="w-[68px] flex-none text-on-ink-3">{r.k}</span>
                  <span className="text-on-ink-2">{r.v}</span>
                </div>
              ))}
            </Card>
            <div className="grid gap-3 content-start">
              {LEDGER_CARDS.map((c) => (
                <Card key={c.title} ledger>
                  <CardTitle className="text-on-ink">{c.title}</CardTitle>
                  <CardDescription className="mt-2 text-on-ink-2">
                    {c.body}
                  </CardDescription>
                </Card>
              ))}
            </div>
          </div>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild variant="ghost" className={darkGhost}>
              <Link href="/transparency-log">Open the transparency log</Link>
            </Button>
            <Button asChild variant="ghost" className={darkGhost}>
              <Link href="/verify">Verify a report</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ============================== 05 / VERIFY IT YOURSELF ============================== */}
      <section className="border-b border-line" id="verify">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">05 / Verify it yourself</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Do not take our word. Run the check.
            </h2>
            <p className="mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
              Verification runs in your own browser on WebCrypto, with no
              account, no upload, and no kolm server in the trust path. Two
              checks, both falsifiable in front of a reviewer.
            </p>
          </div>
          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
              {VERIFY_STEPS.map((c) => (
                <Card key={c.kicker} className="flex flex-col">
                  <CardKicker>{c.kicker}</CardKicker>
                  <CardTitle className="mt-2">{c.title}</CardTitle>
                  <CardDescription className="mt-2 flex-1">
                    {c.body}
                  </CardDescription>
                  <p className="mt-4 font-mono text-[12px] text-ink-3">
                    {c.map.href ? (
                      <a
                        href={c.map.href}
                        download
                        className="text-accent-text hover:underline"
                      >
                        {c.map.label}
                      </a>
                    ) : (
                      c.map.label
                    )}
                  </p>
                </Card>
              ))}
            </div>
            {/* the live verifier, mounted */}
            <div className="lg:sticky lg:top-[90px]">
              <VerifyWidget />
            </div>
          </div>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/verify">Verify a report</Link>
            </Button>
            <Button asChild variant="ghost">
              <a href="/kolm-audit-verify.js">Read the verifier source</a>
            </Button>
          </div>
        </div>
      </section>

      {/* ============================== FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Hand your reviewers a page they can check.
          </h2>
          <p className="mx-auto mt-4 max-w-[58ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            Signed evidence, framework-mapped, logged where anyone can watch, and
            verified offline in their own browser.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/verify">Verify a report</Link>
            </Button>
            <Button asChild variant="ghost" className={darkGhost}>
              <Link href="/contact">Start an audit</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
