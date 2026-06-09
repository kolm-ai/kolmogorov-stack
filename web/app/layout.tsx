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
    "Your platform passed its security review; an autonomous agent is a new question. kolm audits the agent from its own logs across eight controls and signs the security evidence a buyer's review team verifies offline against your public key.",
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
    default: "Signed security evidence for AI agents · kolm.ai",
    template: "%s · kolm.ai",
  },
  description:
    "Your platform passed its security review. Your autonomous agent is a new question: what it can access, what it did, whether it can be prompt-injected, or what data it sent out. kolm audits the agent from its own logs and signs the security evidence your buyer verifies offline against your key. A review that took weeks takes days.",
  applicationName: "kolm.ai",
  keywords: [
    "AI agent security",
    "agent security review",
    "offline-verifiable report",
    "Ed25519 signed report",
    "ISO 42001",
    "NIST AI RMF",
    "OWASP LLM Top 10",
    "MITRE ATLAS",
    "agent audit",
  ],
  authors: [{ name: "kolm.ai", url: SITE_URL }],
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "kolm.ai",
    title: "Security evidence for your AI agent · kolm.ai",
    description:
      "kolm audits your AI agent from its logs and signs the security evidence a buyer's review needs. They verify it offline against your public key, with no account and no kolm server in the trust path. Mapped to SOC 2, ISO 42001, NIST AI RMF, OWASP, and MITRE.",
    images: [{ url: "/brand-hero.png" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Security evidence for your AI agent · kolm.ai",
    description:
      "kolm audits your AI agent from its logs and signs the security evidence a buyer's review needs. They verify it offline against your public key, with no account and no kolm server in the trust path. Mapped to SOC 2, ISO 42001, NIST AI RMF, OWASP, and MITRE.",
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
