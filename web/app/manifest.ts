import type { MetadataRoute } from "next";

// PWA manifest for the marketing site. The brand mark ships as an SVG favicon
// (scalable, so `sizes: "any"` covers every install target), and the colors
// track the light "warm paper" theme used in app/layout.tsx.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "kolm.ai - signed security evidence for AI agents",
    short_name: "kolm.ai",
    description:
      "SOC 2 does not cover your AI agent. kolm audits the agent from its logs and signs the security evidence your buyer verifies offline against your public key, with no account and no kolm server in the trust path. A review that took weeks takes days.",
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
