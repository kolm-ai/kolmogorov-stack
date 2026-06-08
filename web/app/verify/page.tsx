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
  title: "Verify a report offline",
  description:
    "Load a kolm evidence report and verify its Ed25519 signature entirely in your own browser. No account, no upload, no kolm server in the trust path. You verify against the public key, not against our word.",
};

const CHECKS = [
  {
    kicker: "Why offline",
    title: "Nothing for us to fake",
    body: (
      <>
        Asymmetric signatures need only the public key, and it travels inside the
        report. kolm is never in the verification path, so there is no back end
        to quietly return a green check.
      </>
    ),
  },
  {
    kicker: "Tier 1 · signature",
    title: "Untampered since signing",
    body: (
      <>
        The report is signed by the holder of the embedded key and has not
        changed by a single byte since. Edit one field and the signature fails.
        Try{" "}
        <span className="font-mono text-on-ink">Tamper a field</span> in the
        verifier above.
      </>
    ),
  },
  {
    kicker: "Tier 2 · issuer",
    title: "And actually ours",
    body: (
      <>
        The embedded key is matched against kolm&rsquo;s published keyring.
        Re-sign an edited report with an attacker&rsquo;s own key and Tier 1
        still passes, but the issuer check exposes it as a key kolm never
        published.
      </>
    ),
  },
];

export default function VerifyPage() {
  return (
    <>
      {/* ============================== HERO + LIVE VERIFIER ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.96fr)]">
            <div>
              <p className="eyebrow mb-4">Verify</p>
              <h1 className="max-w-[18ch] font-display text-[clamp(38px,6vw,60px)] font-extrabold leading-[1.0] tracking-[-0.035em] text-ink">
                Verify a report, in your own browser.
              </h1>
              <p className="mt-6 max-w-[54ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
                The verifier beside this runs in <em>this</em> browser, with no
                account, no upload, and no kolm server in the path. Two things
                are checked: the Ed25519 signature proves the bytes are
                untampered, and the signing key is matched against kolm&rsquo;s
                published issuer keyring, so a report re-signed with someone
                else&rsquo;s key cannot pass as ours. Tamper a field and the seal
                reads VOID.
              </p>

              <div className="mt-7 flex flex-col gap-2.5 text-[13.5px] text-ink-3">
                <span className="inline-flex items-center gap-2">
                  <CheckIcon className="h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                  in-browser WebCrypto · Ed25519 (RFC 8037)
                </span>
                <span className="inline-flex items-center gap-2">
                  <CheckIcon className="h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                  SHA-256 key fingerprint, recomputed locally
                </span>
                <span className="inline-flex items-center gap-2">
                  <CheckIcon className="h-3.5 w-3.5 flex-none text-[var(--accent)]" />
                  Open verifier:{" "}
                  <a
                    className="border-b border-accent-edge text-ink hover:border-ink"
                    href="/kolm-audit-verify.js"
                  >
                    kolm-audit-verify.js
                  </a>
                </span>
              </div>
            </div>

            {/* the real browser verifier */}
            <aside aria-label="Live offline verification of a signed evidence report">
              <VerifyWidget />
            </aside>
          </div>
        </div>
      </section>

      {/* ============================== THE TWO CHECKS (ledger) ============================== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3 text-on-ink-3">01 / The two checks</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
              They don&rsquo;t trust us. They check the math.
            </h2>
            <p className="mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
              A valid signature alone is not enough. A forger can sign their own
              edited report with their own key. Both tiers have to hold.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {CHECKS.map((c) => (
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

      {/* ============================== FINAL CTA ============================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(64px,8vw,96px)] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Hand your buyer a report they can check.
          </h2>
          <p className="mx-auto mt-4 max-w-[56ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            A signed evidence report your buyer verifies right here, against your
            key, with no account and no server in the trust path.
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
              <Link href="/sample">See the report</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
