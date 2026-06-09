import type { Metadata, Viewport } from "next";

import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

const SITE_URL = "https://kolm.ai";

// Sitewide structured data: a single @graph with the publishing Organization
// and the WebSite that references it. Emitted once from the root layout so it
// is present on every route, powering knowledge-panel and sitelink eligibility.
const organizationLd = {
  "@type": "Organization",
  "@id": `${SITE_URL}/#organization`,
  name: "kolm.ai",
  url: `${SITE_URL}/`,
  logo: `${SITE_URL}/favicon.svg`,
  image: `${SITE_URL}/brand-hero.png`,
  description:
    "Signed, offline-verifiable security evidence for AI agents. kolm audits the agent from its own logs and signs the report your buyer verifies offline against your public key.",
  email: "dev@kolm.ai",
  sameAs: ["https://github.com/kolm-ai/kolm"],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "sales",
    email: "dev@kolm.ai",
    availableLanguage: "en",
  },
};

const websiteLd = {
  "@type": "WebSite",
  "@id": `${SITE_URL}/#website`,
  url: `${SITE_URL}/`,
  name: "kolm.ai",
  description:
    "On-demand security audits for the AI you ship. kolm audits the AI from its own logs across eight controls, in minutes, and signs the result a buyer's review team verifies offline against your public key. Reproducible, no lead time.",
  publisher: { "@id": `${SITE_URL}/#organization` },
  inLanguage: "en-US",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [organizationLd, websiteLd],
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "On-demand security audits for AI · kolm.ai",
    template: "%s · kolm.ai",
  },
  description:
    "Every enterprise deal needs a security audit of the AI you ship. kolm runs it on demand, from your own logs, in minutes, and signs the result so your buyer verifies it themselves. On demand, reproducible, no lead time. A review that took weeks takes days.",
  applicationName: "kolm.ai",
  keywords: [
    "AI security audit",
    "on-demand security audit",
    "AI security review",
    "offline-verifiable report",
    "Ed25519 signed report",
    "ISO 42001",
    "NIST AI RMF",
    "OWASP LLM Top 10",
    "MITRE ATLAS",
  ],
  authors: [{ name: "kolm.ai", url: SITE_URL }],
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "kolm.ai",
    title: "On-demand security audits for AI · kolm.ai",
    description:
      "Every enterprise deal needs a security audit of the AI you ship. kolm runs it on demand, from your logs, in minutes, and signs the result so your buyer verifies it themselves. On demand, reproducible, no lead time.",
    images: [{ url: "/brand-hero.png" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "On-demand security audits for AI · kolm.ai",
    description:
      "Every enterprise deal needs a security audit of the AI you ship. kolm runs it on demand, from your logs, in minutes, and signs the result so your buyer verifies it themselves. On demand, reproducible, no lead time.",
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
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
