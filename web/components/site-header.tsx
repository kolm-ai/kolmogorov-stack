"use client";

import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { BrandMark, MenuIcon } from "@/components/icons";

/**
 * Sticky primary nav, ported from the static .nav. The curated set below keeps
 * the bar legible at every width; the full route map (Product / Solutions /
 * Trust / Company / Legal) lives in the footer sitemap. The primary CTA is
 * "Start free" -> /signup.
 */
const NAV_LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/checks", label: "What we test" },
  { href: "/pricing", label: "Pricing" },
  { href: "/trust", label: "Trust" },
  { href: "/docs", label: "Docs" },
];

export function SiteHeader() {
  const [open, setOpen] = React.useState(false);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b border-line",
        "bg-[color-mix(in_srgb,var(--paper)_80%,transparent)] backdrop-blur-[14px] backdrop-saturate-[140%]"
      )}
    >
      <div className="mx-auto flex h-[66px] max-w-wrap items-center gap-5 px-6">
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
            "ml-3 gap-5 max-lg:absolute max-lg:left-0 max-lg:right-0 max-lg:top-[66px] max-lg:z-[49] max-lg:flex-col max-lg:gap-0 max-lg:border-b max-lg:border-line max-lg:bg-paper-2 max-lg:px-6 max-lg:py-2 max-lg:shadow-[0_14px_34px_-18px_rgba(14,19,16,0.18)]",
            open ? "max-lg:flex" : "max-lg:hidden",
            "flex"
          )}
        >
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="inline-flex min-h-[44px] items-center whitespace-nowrap font-sans text-[14.5px] font-medium tracking-[-0.006em] text-ink-2 transition-colors hover:text-ink max-lg:min-h-[50px] max-lg:border-b max-lg:border-line max-lg:text-[16px] max-lg:last:border-b-0"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="max-lg:hidden">
            <Link href="/contact">Book a demo</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/signup">Start free</Link>
          </Button>
        </div>

        <button
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="navLinks"
          onClick={() => setOpen((v) => !v)}
          className="ml-1 hidden h-[42px] w-[42px] items-center justify-center rounded-md border border-line-2 text-ink hover:border-ink max-lg:inline-flex"
        >
          <MenuIcon className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}
