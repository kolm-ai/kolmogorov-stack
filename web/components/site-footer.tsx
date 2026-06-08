import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { BrandMark } from "@/components/icons";

const COLUMNS: { heading: string; links: { href: string; label: string }[] }[] =
  [
    {
      heading: "Product",
      links: [
        { href: "/how-it-works", label: "How it works" },
        { href: "/platform", label: "Platform" },
        { href: "/checks", label: "Checks" },
        { href: "/sample", label: "Sample report" },
        { href: "/docs", label: "Docs" },
        { href: "/pricing", label: "Pricing" },
      ],
    },
    {
      heading: "Trust",
      links: [
        { href: "/verify", label: "Verify" },
        { href: "/security", label: "Security" },
        { href: "/trust", label: "Trust center" },
        { href: "/status", label: "Status" },
        { href: "/transparency-log", label: "Transparency log" },
      ],
    },
    {
      heading: "Legal",
      links: [
        { href: "/privacy", label: "Privacy" },
        { href: "/terms", label: "Terms" },
        { href: "/dpa", label: "DPA" },
        { href: "/baa", label: "BAA" },
        { href: "/subprocessors", label: "Subprocessors" },
      ],
    },
    {
      heading: "Company",
      links: [
        { href: "/research", label: "Research" },
        { href: "/changelog", label: "Changelog" },
        { href: "/careers", label: "Careers" },
        { href: "/contact", label: "Contact" },
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
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-3 lg:grid-cols-5">
          <div className="col-span-2 sm:col-span-3 lg:col-span-1">
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
            <p className="max-w-[34ch] text-[13px] text-ink-3">
              Signed security evidence for AI agents entering the enterprise.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.heading} className="flex flex-col gap-2">
              <h4 className="font-sans text-[13px] font-semibold text-ink">
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
        </div>

        <div
          className="mt-8 select-none overflow-hidden whitespace-nowrap font-mono text-[8px] uppercase leading-none tracking-[0.30em] text-ink-faint"
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
