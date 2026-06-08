import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CheckIcon, ShieldIcon, KeyIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "Customers",
  description:
    "A representative, anonymized case study: how a Series-A AI vendor cleared a stalled $300k enterprise security review in six days with a signed evidence report the buyer verified offline against the vendor's own key.",
};

const METRICS = [
  {
    n: "$300k",
    l: "annual contract, signed in principle, parked in the buyer's security review",
  },
  {
    n: "6 days",
    l: "from kicking off the audit to the signed report in the buyer's hands",
  },
  {
    n: "4 to 8 wks",
    l: "the from-scratch agent review the signed evidence replaced",
  },
  {
    n: "0 servers",
    l: "in the buyer's trust path: the report was verified offline, in their browser",
  },
];

const DIFFERENCE = [
  {
    icon: CheckIcon,
    title: "Signed, not asserted",
    body: "The findings were canonicalized and signed with Ed25519. The buyer did not have to trust the vendor's summary; a downgraded finding or an inflated score would have broken the seal in front of them.",
  },
  {
    icon: ShieldIcon,
    title: "Verified offline",
    body: "The buyer's security team checked the signature in their own browser, against the vendor's public key carried inside the report. No account, no upload, no kolm server in the trust path.",
  },
  {
    icon: KeyIcon,
    title: "Mapped to their frameworks",
    body: "Every finding landed in a control the buyer already enforced, SOC 2 and the NIST AI RMF, so the reviewer read results in their own vocabulary instead of translating the vendor's.",
  },
];

export default function CustomersPage() {
  return (
    <>
      {/* ============================== HERO ============================== */}
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,7vw,88px)]">
          <p className="eyebrow mb-4">Case study</p>
          <h1 className="max-w-[24ch] font-display text-[clamp(34px,5.2vw,56px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-ink">
            How a Series-A AI vendor cleared a stalled $300k security review in 6
            days.
          </h1>
          <p className="mt-6 max-w-[58ch] font-sans text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-ink-2">
            The agent worked. The contract was signed in principle. Then the
            buyer&rsquo;s security team had to vet an autonomous agent, and a
            one-week review stretched toward two months. Here is how a signed
            evidence report, verified offline, turned the review back into a
            download.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Badge variant="verified">Ed25519-signed</Badge>
            <Badge>Verified offline</Badge>
            <Badge>Representative, anonymized</Badge>
          </div>

          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/signup">Start free</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/contact">Talk to us</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/sample">See a sample report</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ============================ THE NUMBERS ========================= */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[64px]">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {METRICS.map((m) => (
              <div
                key={m.l}
                className="rounded-lg border border-line bg-card p-5"
              >
                <dt className="font-display text-[clamp(28px,3.2vw,38px)] font-extrabold leading-none tracking-[-0.03em] text-ink">
                  {m.n}
                </dt>
                <dd className="mt-3 text-[14px] leading-relaxed text-ink-2">
                  {m.l}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ========================= 01 THE SITUATION ======================= */}
      <section className="border-b border-line">
        <div className="mx-auto grid max-w-wrap gap-10 px-6 py-[88px] lg:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)]">
          <div>
            <p className="eyebrow mb-3">01 / The situation</p>
            <h2 className="font-display text-[clamp(26px,3.4vw,38px)] font-bold leading-[1.1] tracking-[-0.028em] text-ink">
              A deal signed in principle, parked in review.
            </h2>
          </div>
          <div className="max-w-[60ch] space-y-5 text-[clamp(16px,1.5vw,18px)] leading-[1.6] text-ink-2">
            <p>
              A Series-A vendor sold an autonomous support-and-billing agent into
              a Fortune-500 buyer. The economic buyer was sold. A $300k annual
              contract was agreed in principle and handed to the buyer&rsquo;s
              security team for review.
            </p>
            <p>
              Then it stalled. The agent held credentials and acted on its own,
              so the reviewer would not clear it on a vendor questionnaire. The
              spreadsheet came back with a second round of follow-ups, then a
              third. The champion went quiet. Nothing was wrong with the
              product; there was just no way to prove the agent was safe except
              the vendor&rsquo;s say-so, and a security team does not sign off on
              say-so.
            </p>
          </div>
        </div>
      </section>

      {/* ===================== 02 THE SIGNED REPORT (LEDGER) ============== */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto grid max-w-wrap gap-10 px-6 py-[88px] lg:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)]">
          <div>
            <p className="eyebrow mb-3 text-on-ink-3">02 / The signed report</p>
            <h2 className="font-display text-[clamp(26px,3.4vw,38px)] font-bold leading-[1.1] tracking-[-0.028em] text-on-ink">
              An audit, then an artifact that carried its own proof.
            </h2>
          </div>
          <div className="max-w-[60ch] space-y-5 text-[clamp(16px,1.5vw,18px)] leading-[1.6] text-on-ink-2">
            <p>
              The vendor ran a kolm audit across the agent&rsquo;s permissions,
              audit trail and data egress, with the prompt-injection battery on
              top. The first pass surfaced six findings, five of them high: scopes
              the agent held but never used, and a couple of egress destinations
              that needed redaction. Each finding shipped with a remediation step.
            </p>
            <p>
              The team fixed the high findings and re-ran the audit. The result
              was one canonical object, signed with Ed25519, with the
              vendor&rsquo;s public key inside it and every finding mapped to the
              controls the buyer cited. The issuance was written to an
              append-only transparency log. Instead of a spreadsheet, the vendor
              now had evidence.
            </p>
          </div>
        </div>
      </section>

      {/* ===================== 03 THE BUYER VERIFIED IT =================== */}
      <section className="border-b border-line">
        <div className="mx-auto grid max-w-wrap gap-10 px-6 py-[88px] lg:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)]">
          <div>
            <p className="eyebrow mb-3">03 / The buyer verified it offline</p>
            <h2 className="font-display text-[clamp(26px,3.4vw,38px)] font-bold leading-[1.1] tracking-[-0.028em] text-ink">
              They did not take the vendor&rsquo;s word. They checked it.
            </h2>
          </div>
          <div className="max-w-[60ch] space-y-5 text-[clamp(16px,1.5vw,18px)] leading-[1.6] text-ink-2">
            <p>
              The vendor handed over the report. The buyer&rsquo;s security team
              opened it and verified the signature in their own browser, against
              the public key carried inside the document. No account, no upload,
              no kolm server in the path. The signature held, and the issuer
              check confirmed the key belonged to the vendor they were vetting.
            </p>
            <p>
              From there the review was reading, not chasing. Each finding traced
              to a SOC 2 or NIST AI RMF control the team already enforced,
              including the remediations the vendor had closed. The scope
              statement was carried inside the signed object, so the reviewer
              read exactly what had been tested.
            </p>
          </div>
        </div>
      </section>

      {/* ============================ PULL QUOTE ========================= */}
      <section className="relative border-b border-line bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px]">
          <figure className="mx-auto max-w-[40ch] text-center">
            <ShieldIcon className="mx-auto h-7 w-7 text-[var(--accent-on-ink)]" />
            <blockquote className="mt-6 font-display text-[clamp(24px,3.4vw,38px)] font-bold leading-[1.18] tracking-[-0.022em] text-on-ink">
              &ldquo;I did not have to trust the vendor. I opened the report,
              checked the signature myself, and read every finding in the
              controls we already enforce. That is the first time a vendor handed
              me evidence instead of a spreadsheet.&rdquo;
            </blockquote>
            <figcaption className="mt-6 font-mono text-[13px] tracking-[0.02em] text-on-ink-3">
              Head of Security, Fortune-500 buyer (anonymized)
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ========================= 04 THE DEAL CLOSED ==================== */}
      <section className="border-b border-line">
        <div className="mx-auto grid max-w-wrap gap-10 px-6 py-[88px] lg:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)]">
          <div>
            <p className="eyebrow mb-3">04 / The deal closed</p>
            <h2 className="font-display text-[clamp(26px,3.4vw,38px)] font-bold leading-[1.1] tracking-[-0.028em] text-ink">
              Six days, start to signature.
            </h2>
          </div>
          <div className="max-w-[60ch] space-y-5 text-[clamp(16px,1.5vw,18px)] leading-[1.6] text-ink-2">
            <p>
              From the audit kickoff to the signed report in the buyer&rsquo;s
              hands was six days, against the four to eight weeks a from-scratch
              agent review had been heading toward. With the evidence verified,
              the security team cleared the agent and the $300k contract was
              signed.
            </p>
            <p>
              The vendor kept the evidence current with continuous
              re-attestation, so the report the buyer relies on is never older
              than the last release, and a permission granted in one sprint
              cannot quietly outlive the finding that cleared it.
            </p>
          </div>
        </div>
      </section>

      {/* ==================== WHAT MADE THE DIFFERENCE =================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[88px]">
          <div className="mb-12 max-w-[66ch]">
            <p className="eyebrow mb-3">What made the difference</p>
            <h2 className="font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-ink">
              Show me, do not tell me.
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {DIFFERENCE.map((d) => (
              <Card key={d.title} className="p-5">
                <d.icon className="h-5 w-5 text-[var(--accent)]" />
                <p className="mt-3 font-sans text-[16px] font-semibold text-ink">
                  {d.title}
                </p>
                <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                  {d.body}
                </p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ======================= ANONYMIZATION NOTE ===================== */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[56px]">
          <Card className="bg-paper-2">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink-3">
              About this case study
            </p>
            <p className="mt-3 max-w-[80ch] text-[14px] leading-relaxed text-ink-2">
              This case study is representative and anonymized. The company, the
              role quoted, the deal size and the timeline reflect a composite of
              real engagements, and identifying details have been changed. No
              customer names are disclosed, and the quotation is attributed to an
              anonymized role rather than a named individual. The mechanics it
              describes, a signed report verified offline against the
              issuer&rsquo;s public key, are exactly how the product works; you
              can{" "}
              <Link
                className="border-b border-line-2 text-ink hover:border-ink"
                href="/sample"
              >
                verify a real sample report
              </Link>{" "}
              yourself.
            </p>
          </Card>
        </div>
      </section>

      {/* ============================ CTA FINAL =========================== */}
      <section className="relative bg-ink-deep text-on-ink">
        <div className="mx-auto max-w-wrap px-6 py-[96px] text-center">
          <h2 className="mx-auto max-w-[24ch] font-display text-[clamp(28px,3.8vw,42px)] font-bold leading-[1.08] tracking-[-0.028em] text-on-ink">
            Turn your stalled review into a download.
          </h2>
          <p className="mx-auto mt-4 max-w-[52ch] text-[clamp(17.5px,1.55vw,20px)] leading-[1.55] text-on-ink-2">
            Start with a free scan, hand your buyer a signed evidence report, and
            let them verify it offline, against your own key.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/signup">Start free</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="border-[var(--line-ink-2)] text-on-ink hover:border-on-ink hover:bg-[rgba(236,239,234,0.06)]"
            >
              <Link href="/contact">Talk to us</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
