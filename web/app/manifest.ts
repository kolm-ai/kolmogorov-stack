import type { MetadataRoute } from "next";

// PWA manifest for the marketing site. The brand mark ships as an SVG favicon
// (scalable, so `sizes: "any"` covers every install target), and the colors
// track the light "warm paper" theme used in app/layout.tsx.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "kolm.ai - signed security evidence for AI agents",
    short_name: "kolm.ai",
    description:
      "Hand a buyer's security team a signed, offline-verifiable evidence report for your AI agent. A review that took weeks takes days.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f6f7f4",
    theme_color: "#f6f7f4",
    lang: "en",
    categories: ["business", "security", "productivity"],
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
