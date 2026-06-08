import type { MetadataRoute } from "next";

const SITE_URL = "https://kolm.ai";

// Allow all crawlers across the marketing surface. The API namespace (/v1/*) is
// proxied to the backend and carries no indexable content, so it is disallowed,
// mirroring the static site's public/robots.txt.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: "/v1/",
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
