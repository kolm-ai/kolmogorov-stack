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
  title: "Threat model",
  description:
    "The threat model for kolm's signed evidence. What the buyer must trust and what they do not, the scope boundary, the attacker capabilities (tamper, rogue key, replay) the two verification tiers answer, and the limits stated plainly for security reviewers.",
};

const TRUSTLINE = [
  "Signed with Ed25519",
  "Verified offline by you",
  "Scope and limits stated plainly",
];

const TRUST_BASE = [
  "The Ed25519 primitive (RFC 8037) being sound.",
  "Your own verification environment: your browser and its WebCrypto.",
  "A kolm public key, pinned out of band at /keys/kolm-2026-04.pub.",
];

const NOT_TRUSTED = [
  "kolm's servers or uptime. Verification runs offline, with no kolm server in the path.",
  "The network path between vendor and buyer. Tampering in transit breaks the seal.",
  "The vendor's account of their own results. The signed bytes are the result.",
  "Any login. There is no account to create and none to verify.",
];

const PROTECTS: { label: string; body: string }[] = [
  {
    label: "Integrity.",
    body: "The contents are exactly what kolm signed, byte for byte.",
  },
  {
    label: "Provenance.",
    body: "The report was issued by the holder of kolm's signing key, not forged.",
  },
  {
    label: "Auditability.",
    body: "A report's existence and time can be checked against an append-only Merkle transparency log (Ed25519 and SHA-256, RFC 6962 style), so issuance and ordering are independently verifiable.",
  },
  {
    label: "Confidentiality of your inputs.",
    body: "The agent logs and configuration given for an engagement are handled as customer data, not published.",
  },
];

const IN_SCOPE = [
  "Least-privilege permission posture: scopes held versus scopes used.",
  "Audit-trail integrity and retention: append-only, reviewable activity.",
  "Data egress and redaction: destinations, sub-processors, what is masked.",
  "Prompt-injection resistance, tested and reported with reproductions.",
  "Model and dependency provenance.",
  "The signed evidence object itself: logged and offline-verifiable.",
];

const OUT_SCOPE = [
  "Any warranty that the agent is invincible or cannot be made to misbehave.",
  "Systems outside the agreed scope. A report never implies coverage it does not state.",
  "Runtime defense or live monitoring of the agent in production.",
  "A guarantee that no injection path exists, only the results of the tests run.",
];

const ATTACKERS = [
  {
    kicker: "Tamper",
    title: "Edit the report, break the seal",
    body: "A vendor upgrades a finding, changes a date or widens the tested scope, or a tamperer alters the report in transit. The Ed25519 signature covers the canonical bytes, so any single-byte change fails verification in front of the reviewer.",
    map: "Tier 1 · signature integrity",
  },
  {
    kicker: "Rogue key",
    title: "Sign with a fresh key, fail the keyring",
    body: (
      <>
        A forger fabricates a kolm-styled report for an agent we never assessed
        and signs it with their own key. Tier 1 clears for that key, but Tier 2
        checks the issuer against the buyer&rsquo;s keyring, where the key is not
        a kolm issuer.
      </>
    ),
    map: "Tier 2 · issuer provenance",
  },
  {
    kicker: "Replay",
    title: "Present a stale report as current",
    body: (
      <>
        An old or superseded report is shown as today&rsquo;s, or a finding is
        back-dated. The append-only Merkle log fixes existence and ordering,
        re-attestation supersedes a stale report with a signed delta, and each
        report names its point in time.
      </>
    ),
    map: "Append-only Merkle log",
  },
];

const LIMITS = [
  {
    kicker: "Integrity, not security",
    title: "A signature proves origin, not invincibility",
    body: "It confirms the report is genuine and unaltered, and that a kolm key signed it. It does not assert that the audited agent cannot be attacked.",
  },
  {
    kicker: "Tested, not warranted",
    title: "Injection results reflect the tests we ran",
    body: "Prompt-injection and jailbreak resistance are tested and reported, not warranted. A passing result reflects the adversarial tests run within scope, not a proof that no attack exists.",
  },
  {
    kicker: "Point in time",
    title: "Findings describe a moment and a fixed scope",
    body: "A later code change can alter the posture. A permission granted in January can still fire in August. Re-attestation captures the change as a signed delta.",
  },
  {
    kicker: "Stated scope only",
    title: "No coverage a report does not state",
    body: "We do not assess systems outside the agreed scope, and a report never implies coverage beyond what its scope statement names.",
  },
];

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="mt-3 grid list-disc gap-1.5 pl-5 text-[14px] leading-relaxed text-ink-2 marker:text-ink-faint">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

const darkGhost =
  "border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]";

export default function ThreatModelPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">Threat model</p>
          <h1 className="font-display text-[clamp(40px,6.4vw,68px)] font-extrabold leading-[1.0] tracking-[-0.035em] text-ink">
            Threat model
          </h1>
          <p className="mt-6 max-w-[70ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
            Someone has handed you a signed evidence report and asked you to rely
            on it before you clear a vendor&rsquo;s agent. Before you do, you
            should know exactly what the signature defends against, and where it
            stops. This is that boundary, drawn precisely: who can attack the
            report, what the cryptography proves, and (stated plainly) what it
            does not.
          </p>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-ink-3">
            {TRUSTLINE.map((t) => (
              <span key={t} className="inline-flex items-center gap-2">
                <CheckIcon className="h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                {t}
              </span>
            ))}
          </div>
          <p className="mt-5 font-mono text-[12px] text-ink-3">
            Last reviewed 8 June 2026
          </p>
        </div>
      </section>

      {/* ============================== 01 / TRUST MODEL ============================== */}
      <section className="border-b border-line" id="trust-model">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-10 max-w-[72ch]">
            <p className="eyebrow mb-3">01 / Trust model</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Trust the math, not the vendor and not us.
            </h2>
            <p className="mt-4 text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-ink-2">
              The point of a signed report is to move the burden of proof off
              your desk. So the trust base is kept small and inspectable. Every
              report is signed with Ed25519 (RFC 8037) over a canonical
              serialization of its fields. The public key travels inside the
              report, and you verify the signature in your own browser using
              WebCrypto at{" "}
              <Link
                href="/verify"
                className="border-b border-line-2 text-ink hover:border-ink"
              >
                /verify
              </Link>
              , offline, with no account and no call to us. Any change to a
              single byte of a signed field invalidates the signature. To pin our
              identity out of band, the current public key is published at{" "}
              <a
                href="/keys/kolm-2026-04.pub"
                className="border-b border-line-2 text-ink hover:border-ink"
              >
                /keys/kolm-2026-04.pub
              </a>
              .
            </p>
            <p className="mt-4 font-mono text-[12px] leading-relaxed text-ink-3">
              Ed25519 (RFC 8037) · canonical field serialization · in-browser
              WebCrypto · append-only Merkle log
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardKicker>The trust base</CardKicker>
              <CardTitle className="mt-2">What you rely on</CardTitle>
              <BulletList items={TRUST_BASE} />
              <p className="mt-4 font-mono text-[12px] text-ink-3">
                Three things, all inspectable. Nothing else is load-bearing.
              </p>
            </Card>
            <Card>
              <CardKicker>Outside the trust base</CardKicker>
              <CardTitle className="mt-2">
                What you do not have to trust
              </CardTitle>
              <BulletList items={NOT_TRUSTED} />
            </Card>
          </div>

          <h3 className="mt-12 font-sans text-[20px] font-semibold tracking-[-0.012em] text-ink">
            What the signature and the log protect
          </h3>
          <ul className="mt-4 grid gap-2.5 border-l-2 border-line pl-5">
            {PROTECTS.map((p) => (
              <li key={p.label} className="text-[15px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-ink">{p.label}</strong>{" "}
                {p.body}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ============================== 02 / IN SCOPE AND OUT OF SCOPE ============================== */}
      <section className="border-b border-line" id="scope">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-10 max-w-[68ch]">
            <p className="eyebrow mb-3">02 / In scope and out of scope</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Scope is the boundary of every claim.
            </h2>
            <p className="mt-4 text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-ink-2">
              A report is precise about what it covers, and silent about what it
              does not. The scope statement is part of the signed object, so a
              reviewer reads the boundary in the same bytes as the findings.
            </p>
            <p className="mt-5 max-w-[74ch] border-l-2 border-accent-edge pl-4 font-mono text-[13px] leading-[1.7] text-ink-2">
              Scope is contractual. Permission posture, redaction and audit-trail
              integrity are assessed. Injection is tested and reported, not
              warranted.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardKicker>In scope · assessed</CardKicker>
              <CardTitle className="mt-2">What a report covers</CardTitle>
              <BulletList items={IN_SCOPE} />
            </Card>
            <Card>
              <CardKicker>Out of scope · not claimed</CardKicker>
              <CardTitle className="mt-2">What a report does not cover</CardTitle>
              <BulletList items={OUT_SCOPE} />
            </Card>
          </div>
        </div>
      </section>

      {/* ============================== 03 / ATTACKER CAPABILITIES (ledger) ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink" id="attackers">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-12 max-w-[68ch]">
            <p className="eyebrow mb-3 text-on-ink-3">03 / Attacker capabilities</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              Three ways to attack a report. Two tiers that answer them.
            </h2>
            <p className="mt-4 text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-on-ink-2">
              We model a vendor who would alter their own report, a forger who
              would fabricate one, and a tamperer on the wire between vendor and
              buyer. The skeptical buyer is modeled too, as a first-class
              participant rather than an adversary: they should be able to
              confirm everything themselves.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {ATTACKERS.map((c) => (
              <Card key={c.kicker} ledger className="flex flex-col">
                <CardKicker className="text-on-ink-3">{c.kicker}</CardKicker>
                <CardTitle className="mt-2 text-on-ink">{c.title}</CardTitle>
                <CardDescription className="mt-2 flex-1 text-on-ink-2">
                  {c.body}
                </CardDescription>
                <p className="mt-4 font-mono text-[12px] text-on-ink-3">
                  {c.map}
                </p>
              </Card>
            ))}
          </div>
          <p className="mt-10 max-w-[78ch] border-l-2 border-[var(--accent-on-ink-edge)] pl-4 font-mono text-[13px] leading-[1.7] text-on-ink-2">
            Every check above runs in the buyer&rsquo;s own browser, against the
            key inside the report, with no kolm server in the path. There is
            nothing for us to fake after the fact.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild variant="ghost" className={darkGhost}>
              <Link href="/verify">Verify a report</Link>
            </Button>
            <Button asChild variant="ghost" className={darkGhost}>
              <Link href="/transparency-log">See the transparency log</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ============================== 04 / ASSUMPTIONS AND LIMITATIONS ============================== */}
      <section className="border-b border-line" id="limits">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-10 max-w-[68ch]">
            <p className="eyebrow mb-3">04 / Assumptions and limitations</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Where the guarantee ends.
            </h2>
            <p className="mt-4 text-[clamp(17px,1.5vw,19px)] leading-[1.6] text-ink-2">
              A signature is a narrow instrument, and it is more useful when its
              edges are clear. These are the limits we design to, and the
              assumptions the whole model rests on.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {LIMITS.map((c) => (
              <Card key={c.kicker}>
                <CardKicker>{c.kicker}</CardKicker>
                <CardTitle className="mt-2">{c.title}</CardTitle>
                <CardDescription className="mt-2">{c.body}</CardDescription>
              </Card>
            ))}
          </div>

          <div className="mt-10 grid items-start gap-8 md:grid-cols-2">
            <Card>
              <CardKicker>Assumptions the model rests on</CardKicker>
              <CardTitle className="mt-2">What has to hold</CardTitle>
              <CardDescription className="mt-3">
                The model holds if the Ed25519 primitive is sound, our signing
                key remains under our control in its key-management service, and
                the buyer&rsquo;s verification environment is itself untampered.
                We rotate signing keys on a published schedule and record
                rotations, so a report always names the key that signed it. If a
                key is ever suspected compromised, we revoke it, publish the
                revocation, and re-attest affected reports under a fresh key.
              </CardDescription>
            </Card>
            <div>
              <h3 className="font-sans text-[20px] font-semibold tracking-[-0.012em] text-ink">
                Reporting an issue
              </h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                Found a gap in the verification path or in this model? Tell us at{" "}
                <a
                  className="text-accent-text hover:underline"
                  href="mailto:dev@kolm.ai"
                >
                  dev@kolm.ai
                </a>{" "}
                before disclosing publicly, per our{" "}
                <Link
                  className="text-accent-text hover:underline"
                  href="/acceptable-use"
                >
                  Acceptable Use Policy
                </Link>
                . The signing core and the verifier are open source, so the
                verification path can be reviewed line by line.
              </p>
              <p className="mt-5 font-mono text-[12.5px] leading-relaxed text-ink-3">
                See also:{" "}
                <Link className="text-accent-text hover:underline" href="/security">
                  Security
                </Link>{" "}
                ·{" "}
                <Link className="text-accent-text hover:underline" href="/verify">
                  Verify a report
                </Link>{" "}
                ·{" "}
                <Link
                  className="text-accent-text hover:underline"
                  href="/transparency-log"
                >
                  Transparency log
                </Link>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ============================== FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[26ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Rely on the signature, exactly as far as this page says.
          </h2>
          <p className="mx-auto mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            Verify a report yourself in your own browser, or read the controls
            behind each finding.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/verify">Verify a report</Link>
            </Button>
            <Button asChild variant="ghost" className={darkGhost}>
              <Link href="/checks">What we test</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
