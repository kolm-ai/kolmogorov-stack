import type { MetadataRoute } from "next";

const SITE_URL = "https://kolm.ai";

type ChangeFreq = NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;

// Every indexable route that exists under web/app, with a hand-tuned priority
// and change cadence. Utility/noindex surfaces (the not-found handler, the
// in-app dashboard, signup and the report viewer) have no page route here and
// are intentionally absent. Keep this list in sync when a page directory is
// added or removed under web/app.
const routes: Array<{ path: string; priority: number; changeFrequency: ChangeFreq }> = [
  // Core funnel
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  { path: "/how-it-works", priority: 0.9, changeFrequency: "monthly" },
  { path: "/platform", priority: 0.9, changeFrequency: "monthly" },
  { path: "/pricing", priority: 0.9, changeFrequency: "monthly" },
  { path: "/verify", priority: 0.9, changeFrequency: "monthly" },
  { path: "/checks", priority: 0.8, changeFrequency: "monthly" },
  { path: "/report", priority: 0.8, changeFrequency: "monthly" },
  { path: "/sample", priority: 0.6, changeFrequency: "monthly" },

  // Trust and evidence
  { path: "/trust", priority: 0.8, changeFrequency: "monthly" },
  { path: "/security", priority: 0.8, changeFrequency: "monthly" },
  { path: "/security/threat-model", priority: 0.6, changeFrequency: "monthly" },
  { path: "/transparency-log", priority: 0.7, changeFrequency: "weekly" },
  { path: "/status", priority: 0.5, changeFrequency: "daily" },

  // Audience and solutions
  { path: "/enterprise", priority: 0.8, changeFrequency: "monthly" },
  { path: "/customers", priority: 0.7, changeFrequency: "monthly" },
  { path: "/solutions/ai-vendors", priority: 0.8, changeFrequency: "monthly" },
  { path: "/solutions/enterprise-buyers", priority: 0.8, changeFrequency: "monthly" },
  { path: "/solutions/finance", priority: 0.7, changeFrequency: "monthly" },
  { path: "/solutions/healthcare", priority: 0.7, changeFrequency: "monthly" },
  { path: "/solutions/critical-infrastructure", priority: 0.7, changeFrequency: "monthly" },

  // Knowledge and company
  { path: "/research", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs", priority: 0.7, changeFrequency: "monthly" },
  { path: "/changelog", priority: 0.6, changeFrequency: "weekly" },
  { path: "/contact", priority: 0.7, changeFrequency: "monthly" },
  { path: "/careers", priority: 0.5, changeFrequency: "monthly" },

  // Legal and policy
  { path: "/privacy", priority: 0.4, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.4, changeFrequency: "yearly" },
  { path: "/dpa", priority: 0.4, changeFrequency: "yearly" },
  { path: "/baa", priority: 0.4, changeFrequency: "yearly" },
  { path: "/sla", priority: 0.3, changeFrequency: "yearly" },
  { path: "/acceptable-use", priority: 0.3, changeFrequency: "yearly" },
  { path: "/subprocessors", priority: 0.3, changeFrequency: "monthly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return routes.map(({ path, priority, changeFrequency }) => ({
    url: `${SITE_URL}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
