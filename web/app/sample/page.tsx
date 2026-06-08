import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { VerifyWidget } from "@/components/verify-widget";
import { ReportViewer } from "@/components/report-viewer";

export const metadata: Metadata = {
  title: "Sample report",
  description:
    "A real signed Agent Security-Review report. Verify the Ed25519 signature offline in your own browser, read the findings and the framework crosswalk, or download the JSON.",
};

/**
 * Sample report viewer.
 *
 * The left column mounts the REAL browser verifier (VerifyWidget) against the
 * shipped signed report; the right column reads the same artifact and lays out
 * the findings. The interactive verifier this embeds is the same module the
 * static site ships at /kolm-audit-verify.js - it runs entirely client-side,
 * with no kolm server in the trust path. The "Tamper a field" control proves
 * the falsifiable claim: alter one signed value and the seal reads VOID.
 */
export default function SamplePage() {
  return (
    <>
      <section className="hero-dots relative border-b border-line">
        <div className="mx-auto max-w-wrap px-6 py-[clamp(48px,6vw,80px)]">
          <p className="eyebrow mb-4">Sample report</p>
          <h1 className="max-w-[20ch] font-display text-[clamp(34px,5vw,52px)] font-extrabold leading-[1.02] tracking-[-0.035em] text-ink">
            A signed report your buyer verifies offline.
          </h1>
          <p className="mt-5 max-w-[56ch] font-sans text-[clamp(17px,1.5vw,19px)] leading-[1.55] text-ink-2">
            This is a real Agent Security-Review report, signed with Ed25519. The
            verifier below runs in your browser, against the embedded public key.
            No account, no upload, no kolm server in the trust path. Try to break
            it.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <a href="/sample-audit-report.json" download>
                Download the JSON
              </a>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/verify">Open the full verifier</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/contact">Get one for your agent</Link>
            </Button>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Badge variant="verified">Ed25519-signed</Badge>
            <Badge>Offline-verifiable</Badge>
            <Badge>
              <a href="/kolm-audit-verify.js">Inspectable verifier</a>
            </Badge>
          </div>
        </div>
      </section>

      <section>
        <div className="mx-auto grid max-w-wrap gap-10 px-6 py-[72px] lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          {/* the live proof */}
          <div className="lg:sticky lg:top-[90px] lg:self-start">
            <p className="eyebrow mb-3">Verify it</p>
            <VerifyWidget />
            <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
              At cutover, the same{" "}
              <a
                className="border-b border-line-2 text-ink hover:border-ink"
                href="/kolm-audit-verify.js"
              >
                kolm-audit-verify.js
              </a>{" "}
              module mounts here byte-for-byte, so verification behaves
              identically to the live static site.
            </p>
          </div>

          {/* the readable report */}
          <div>
            <p className="eyebrow mb-3">Read it</p>
            <ReportViewer />
          </div>
        </div>
      </section>
    </>
  );
}
