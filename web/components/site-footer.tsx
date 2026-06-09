import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { BrandMark } from "@/components/icons";

/**
 * Full footer sitemap. Together with the header nav this links every route the
 * site will have, grouped Product / Solutions / Trust / Company / Legal.
 */
const COLUMNS: { heading: string; links: { href: string; label: string }[] }[] =
  [
    {
      heading: "Product",
      links: [
        { href: "/how-it-works", label: "How it works" },
        { href: "/checks", label: "What we test" },
        { href: "/verify", label: "Verify" },
        { href: "/sample", label: "Sample report" },
        { href: "/compare", label: "Compare" },
        { href: "/roi", label: "ROI calculator" },
        { href: "/pricing", label: "Pricing" },
        { href: "/docs", label: "Docs" },
      ],
    },
    {
      heading: "Solutions",
      links: [
        { href: "/solutions/ai-vendors", label: "AI vendors" },
        { href: "/solutions/enterprise-buyers", label: "Enterprise buyers" },
        { href: "/solutions/finance", label: "Finance" },
        { href: "/solutions/healthcare", label: "Healthcare" },
        {
          href: "/solutions/critical-infrastructure",
          label: "Critical infrastructure",
        },
        { href: "/enterprise", label: "For enterprise" },
        { href: "/customers", label: "Customers" },
      ],
    },
    {
      heading: "Trust",
      links: [
        { href: "/trust", label: "Trust center" },
        { href: "/security", label: "Security" },
        { href: "/security/threat-model", label: "Threat model" },
        { href: "/transparency-log", label: "Transparency log" },
        { href: "/status", label: "Status" },
      ],
    },
    {
      heading: "Company",
      links: [
        { href: "/research", label: "Research" },
        { href: "/glossary", label: "Glossary" },
        { href: "/changelog", label: "Changelog" },
        { href: "/careers", label: "Careers" },
        { href: "/contact", label: "Contact" },
        { href: "/signup", label: "Start free" },
      ],
    },
    {
      heading: "Legal",
      links: [
        { href: "/privacy", label: "Privacy" },
        { href: "/terms", label: "Terms" },
        { href: "/dpa", label: "DPA" },
        { href: "/baa", label: "BAA" },
        { href: "/sla", label: "SLA" },
        { href: "/acceptable-use", label: "Acceptable use" },
        { href: "/subprocessors", label: "Subprocessors" },
      ],
    },
  ];

const MICROPRINT =
  "KOLM · AGENT SECURITY EVIDENCE · ED25519 · VERIFIED OFFLINE · SIGNED · SCOPED · OFFLINE-VERIFIABLE · ".repeat(
    3
  );

export function SiteFooter() {
  return (
    <footer className="border-t border-line py-[64px]">
      <div className="mx-auto max-w-wrap px-6">
        <div className="flex flex-col gap-12 lg:flex-row lg:justify-between lg:gap-16">
          <div className="lg:max-w-[28ch]">
            <Link
              href="/"
              aria-label="kolm.ai home"
              className="mb-3 inline-flex items-center gap-[9px] font-display text-[19px] font-extrabold tracking-[-0.03em] text-ink"
            >
              <BrandMark className="h-[22px] w-[22px]" />
              <span>
                kolm<b className="font-extrabold">.ai</b>
              </span>
            </Link>
            <p className="text-[13.5px] leading-relaxed text-ink-3">
              Signed security evidence for AI agents entering the enterprise.
            </p>
          </div>

          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 lg:grid-cols-5"
          >
            {COLUMNS.map((col) => (
              <div key={col.heading} className="flex flex-col gap-2.5">
                <h4 className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink-3">
                  {col.heading}
                </h4>
                {col.links.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="text-[13.5px] text-ink-2 transition-colors hover:text-ink"
                  >
                    {l.label}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        </div>

        <div
          className="mt-12 select-none overflow-hidden whitespace-nowrap font-mono text-[8px] uppercase leading-none tracking-[0.30em] text-ink-faint"
          aria-hidden="true"
        >
          {MICROPRINT}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Badge variant="verified">Ed25519-signed</Badge>
          <Badge>Offline-verifiable</Badge>
          <Badge>
            <a href="/kolm-audit-verify.js">Inspectable verifier</a>
          </Badge>
          <span className="ml-auto text-[13px] text-ink-3">
            © 2026 kolm.ai ·{" "}
            <a className="hover:text-ink" href="mailto:dev@kolm.ai">
              dev@kolm.ai
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
