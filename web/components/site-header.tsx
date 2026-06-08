"use client";

import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { BrandMark, MenuIcon } from "@/components/icons";

const NAV_LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/checks", label: "What we test" },
  { href: "/pricing", label: "Pricing" },
  { href: "/trust", label: "Trust" },
  { href: "/docs", label: "Docs" },
];

/**
 * Sticky primary nav, ported from the static .nav. Links to /how-it-works,
 * /checks, /trust, /docs still resolve to the live static pages during the
 * migration (they are not yet ported to the App Router); /pricing and /sample
 * are served by this app. See web/README.md for the port order.
 */
export function SiteHeader() {
  const [open, setOpen] = React.useState(false);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b border-line",
        "bg-[color-mix(in_srgb,var(--paper)_80%,transparent)] backdrop-blur-[14px] backdrop-saturate-[140%]"
      )}
    >
      <div className="mx-auto flex h-[66px] max-w-wrap items-center gap-6 px-6">
        <Link
          href="/"
          aria-label="kolm.ai home"
          className="inline-flex items-center gap-[9px] font-display text-[19px] font-extrabold tracking-[-0.03em] text-ink"
        >
          <BrandMark className="h-[22px] w-[22px]" />
          <span>
            kolm<b className="font-extrabold">.ai</b>
          </span>
        </Link>

        <nav
          id="navLinks"
          aria-label="Primary"
          className={cn(
            "ml-3 gap-6 max-[860px]:absolute max-[860px]:left-0 max-[860px]:right-0 max-[860px]:top-[66px] max-[860px]:z-[49] max-[860px]:flex-col max-[860px]:gap-0 max-[860px]:border-b max-[860px]:border-line max-[860px]:bg-paper-2 max-[860px]:px-6 max-[860px]:py-2 max-[860px]:shadow-[0_14px_34px_-18px_rgba(14,19,16,0.18)]",
            open ? "max-[860px]:flex" : "max-[860px]:hidden",
            "flex"
          )}
        >
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="inline-flex min-h-[44px] items-center font-sans text-[14.5px] font-medium tracking-[-0.006em] text-ink-2 transition-colors hover:text-ink max-[860px]:min-h-[50px] max-[860px]:border-b max-[860px]:border-line max-[860px]:text-[16px] max-[860px]:last:border-b-0"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="max-[860px]:hidden"
          >
            <Link href="/sample">See sample report</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/contact">Start an audit</Link>
          </Button>
        </div>

        <button
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="navLinks"
          onClick={() => setOpen((v) => !v)}
          className="ml-2 hidden h-[42px] w-[42px] items-center justify-center rounded-md border border-line-2 text-ink hover:border-ink max-[860px]:inline-flex"
        >
          <MenuIcon className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}
