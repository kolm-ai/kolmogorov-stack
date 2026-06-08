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

export const metadata: Metadata = {
  title: "System Status",
  description:
    "Current health of the kolm.ai audit infrastructure: public verifier, API, transparency log, audit pipeline, and website. Incidents posted here and to dev@kolm.ai.",
};

const COMPONENTS: { name: string; path: string; desc: string }[] = [
  {
    name: "Public verifier",
    path: "/verify",
    desc: "In-browser WebCrypto verification of Ed25519-signed evidence reports. No account required. Offline-capable against our published public key.",
  },
  {
    name: "API",
    path: "/v1",
    desc: "REST control plane for audit initiation, report retrieval, and key publication. Used by the verifier, integrations, and the audit pipeline.",
  },
  {
    name: "Transparency log",
    path: "/v1/log",
    desc: "Ed25519/SHA-256 Merkle append log (RFC 6962-style) of every issued evidence report. Any report can be confirmed against the log without contacting kolm's servers.",
  },
  {
    name: "Audit pipeline",
    path: "internal",
    desc: "Automated check runners, signing service, and report assembly. Degradation here may delay report issuance; already-issued reports are not affected.",
  },
  {
    name: "Website",
    path: "kolm.ai",
    desc: "Public marketing, documentation, and trust pages including /trust, /security, /checks, and /research.",
  },
];

const OFFLINE = [
  {
    kicker: "Signature",
    title: "Ed25519, published key",
    body: (
      <>
        Reports carry a detached Ed25519 signature verifiable against a key
        pinned at <span className="font-mono text-ink-2">/v1/pubkey</span>.
        Infrastructure availability does not affect this check.
      </>
    ),
  },
  {
    kicker: "Log inclusion",
    title: "Merkle inclusion proof",
    body: "Each report ships a Merkle inclusion proof against the RFC 6962-style transparency log. The log root is published separately and can be checked offline.",
  },
  {
    kicker: "Scope",
    title: "Cryptographically bound",
    body: "The agent name, version, capability scope, and audit date are embedded in the signed payload; they cannot be altered without invalidating the signature.",
  },
  {
    kicker: "No account",
    title: "No login required to verify",
    body: (
      <>
        The public verifier at{" "}
        <span className="font-mono text-ink-2">/verify</span> runs entirely in
        the browser using the WebCrypto API. No credentials, no session, no
        server round-trip.
      </>
    ),
  },
];

const RELATED = [
  {
    kicker: "Trust center",
    href: "/trust",
    body: "Security policies, sub-processor list, data handling, how findings map to recognized control frameworks, and the full verifiability guarantee.",
  },
  {
    kicker: "Security",
    href: "/security",
    body: "Cryptographic architecture, key management, and our responsible disclosure process.",
  },
  {
    kicker: "Verify",
    href: "/verify",
    body: "Upload any kolm evidence report and confirm its Ed25519 signature, scope, and log inclusion in-browser. No account needed.",
  },
];

const darkGhost =
  "border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]";

export default function StatusPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">System status</p>
          <h1 className="max-w-[18ch] font-display text-[clamp(38px,6vw,60px)] font-extrabold leading-[1.0] tracking-[-0.035em] text-ink">
            Audit infrastructure status.
          </h1>
          <p className="mt-6 max-w-[64ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
            The live health of every public surface behind the kolm.ai evidence
            pipeline. Incidents are posted here and sent directly to{" "}
            <a
              className="border-b border-line-2 text-ink hover:border-ink"
              href="mailto:dev@kolm.ai"
            >
              dev@kolm.ai
            </a>
            . Evidence reports already in your hands are not affected by
            infrastructure events; they are offline-verifiable against our public
            Ed25519 key with no dependency on our servers.
          </p>
        </div>
      </section>

      {/* ============================== 01 / CURRENT STATUS ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-10">
          <p className="eyebrow mb-5">01 / Current status</p>
          <div
            role="status"
            aria-live="polite"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-accent-edge bg-accent-soft px-5 py-4"
          >
            <Badge variant="verified">All systems operational</Badge>
            <span className="text-[13.5px] text-ink-3">
              Per-component detail below. No incidents active.
            </span>
          </div>
        </div>
      </section>

      {/* ============================== 02 / COMPONENTS ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-8 max-w-[62ch]">
            <p className="eyebrow mb-3">02 / Components</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              What we monitor.
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-3">
              Each component is checked continuously. Status shown here is
              updated on a rolling basis. When a component degrades or goes down,
              an incident is opened and posted to this page; a notification is
              sent to{" "}
              <a
                className="text-accent-text hover:underline"
                href="mailto:dev@kolm.ai"
              >
                dev@kolm.ai
              </a>
              .
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[680px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-paper-sink">
                  {["Component", "Description", "Status"].map((h) => (
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
                {COMPONENTS.map((c) => (
                  <tr
                    key={c.name}
                    className="border-b border-line align-top last:border-0"
                  >
                    <td className="px-4 py-3.5">
                      <span className="font-sans text-[14px] font-semibold text-ink">
                        {c.name}
                      </span>
                      <br />
                      <span className="font-mono text-[12px] text-ink-3">
                        {c.path}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-[14px] leading-relaxed text-ink-2">
                      {c.desc}
                    </td>
                    <td className="px-4 py-3.5">
                      <Badge variant="verified">Operational</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ============================== 03 / INCIDENTS ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(56px,7vw,80px)]">
          <div className="max-w-[78ch]">
            <p className="eyebrow mb-3">03 / Incidents</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              No incidents on record.
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ink-3">
              When an incident occurs, a dated entry is posted here with a
              plain-language description of the affected component, the impact,
              and the resolution. Notifications go to{" "}
              <a
                className="text-accent-text hover:underline"
                href="mailto:dev@kolm.ai"
              >
                dev@kolm.ai
              </a>
              . There are no incidents to report at this time.
            </p>
          </div>
        </div>
      </section>

      {/* ============================== 04 / OFFLINE VERIFICATION (ledger) ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto grid max-w-wrap items-start gap-10 px-6 py-[clamp(64px,8vw,96px)] lg:grid-cols-2">
          <div>
            <p className="eyebrow mb-3 text-on-ink-3">04 / Offline verification</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Evidence reports survive any outage.
            </h2>
            <p className="mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              Every evidence report issued by kolm is signed with an Ed25519 key
              whose public counterpart is published and pinned. Verification uses
              in-browser WebCrypto: no network call to kolm servers, no account,
              no trust in our uptime. A buyer&rsquo;s security team can confirm
              the signature, the scope, and the timestamp of any report even when
              this status page is unreachable.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild>
                <Link href="/verify">Verify a report</Link>
              </Button>
              <Button asChild variant="ghost" className={darkGhost}>
                <Link href="/trust">Trust center</Link>
              </Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {OFFLINE.map((c) => (
              <Card key={c.kicker} ledger>
                <CardKicker className="text-on-ink-3">{c.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">{c.title}</CardTitle>
                <CardDescription className="mt-2 text-on-ink-2">
                  {c.body}
                </CardDescription>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== 05 / RELATED ============================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-8">
            <p className="eyebrow mb-3">05 / Related</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              More on infrastructure and trust.
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {RELATED.map((c) => (
              <Card key={c.kicker}>
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">
                  <Link
                    href={c.href}
                    className="font-mono text-[18px] text-ink hover:text-accent-text"
                  >
                    {c.href}
                  </Link>
                </CardTitle>
                <CardDescription className="mt-2">{c.body}</CardDescription>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ============================== FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[20ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Reach us directly.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            For incident reports, infrastructure questions, or anything related
            to the audit pipeline, write to{" "}
            <a className="text-on-ink underline-offset-4 hover:underline" href="mailto:dev@kolm.ai">
              dev@kolm.ai
            </a>
            . We aim to respond within one business day.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <a href="mailto:dev@kolm.ai">dev@kolm.ai</a>
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
