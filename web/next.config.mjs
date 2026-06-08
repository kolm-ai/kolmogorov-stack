/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // The live API surface (/v1/audit, /v1/verify, /health) is served by the
  // existing backend (Railway today, see MEMORY). During the migration the
  // Next app proxies those paths to the same origin the static site uses, so
  // the browser verifier and the audit endpoints keep working without a code
  // change at cutover. Override the upstream with KOLM_API_ORIGIN at build/run
  // time; default is the production origin.
  async rewrites() {
    // Proxy the API straight to the Railway backend - NOT to kolm.ai, which is
    // this very app after cutover (that would self-loop). Mirrors the static
    // site's vercel.json which rewrites /v1/* to the Railway origin directly.
    const apiOrigin = process.env.KOLM_API_ORIGIN || "https://kolmogorov-stack-production.up.railway.app";
    return [
      { source: "/v1/:path*", destination: `${apiOrigin}/v1/:path*` },
      { source: "/health", destination: `${apiOrigin}/health` },
      { source: "/ready", destination: `${apiOrigin}/ready` },
    ];
  },

  async headers() {
    return [
      {
        // The self-hosted fonts are immutable; cache them hard.
        source: "/fonts/:font*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
