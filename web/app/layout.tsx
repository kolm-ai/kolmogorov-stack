import type { Metadata, Viewport } from "next";

import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

const SITE_URL = "https://kolm.ai";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Signed security evidence for AI agents · kolm.ai",
    template: "%s · kolm.ai",
  },
  description:
    "Your AI agent is ready for enterprise. Hand a buyer's security team a signed, offline-verifiable evidence report - mapped to SOC 2, ISO 42001, NIST AI RMF, the EU AI Act, OWASP and MITRE ATLAS. The SOC 2 for AI agents.",
  applicationName: "kolm.ai",
  keywords: [
    "AI agent security",
    "Ed25519 signed report",
    "SOC 2 for AI agents",
    "ISO 42001",
    "NIST AI RMF",
    "EU AI Act",
    "agent audit",
  ],
  authors: [{ name: "kolm.ai", url: SITE_URL }],
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "kolm.ai",
    title: "Signed security evidence for AI agents · kolm.ai",
    description:
      "The SOC 2 for AI agents - signed, verifiable, deal-closing evidence.",
    images: [{ url: "/brand-hero.png" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Signed security evidence for AI agents · kolm.ai",
    description:
      "The SOC 2 for AI agents - signed, verifiable, deal-closing evidence.",
    images: ["/brand-hero.png"],
  },
  icons: { icon: "/favicon.svg" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#f6f7f4",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-paper-2 focus:px-4 focus:py-2 focus:text-ink focus:shadow-lg"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
