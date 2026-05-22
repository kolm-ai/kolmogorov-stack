# archive/

Snapshots of the live kolm.ai production site, taken before each major
front-end redeploy so the new build can be compared against what shipped.

## Layout

```
archive/
  prod-snapshot-2026-05-22/      <- 452-URL crawl of live kolm.ai, 9.8 MB
    sitemap.xml                  <- copy of /sitemap.xml at snapshot time
    manifest.json                <- {snapshot_at, source, url, status, size} per page
    index.html, product.html, wrapper.html, ... (mirrors site path structure)
    docs/, account/, ...
```

## How it was taken

```sh
node scripts/archive-prod.cjs
```

Pulls every URL in `https://kolm.ai/sitemap.xml`, writes the body to a
mirrored path under `archive/prod-snapshot-<date>/`, builds a manifest.

## When to consult

- Before deploying a redesign, diff the new local copy against the snapshot to
  spot content/features that were on prod but didn't make it into the rebuild.
- Particularly useful for the `product.html` and per-capability pages
  (`gateway`, `capture`, `distill`, `compile`, `runtimes`, `k-score`,
  `benchmarks`, `integrations`, `api`, `sdks`) where prod accumulated
  hard-won narrative depth.

## What lives where on prod (2026-05-22 snapshot)

Most relevant pages by byte size:
- `api.html` 49 KB - 354-op HTTP reference
- `compile.html` 47 KB - interactive in-browser compile widget + 6-task gallery
- `k-score.html` 44 KB - calculator + 4 worked examples + receipt anatomy
- `integrations.html` 35 KB - per-provider drop-in instructions
- `benchmarks.html` 34 KB - SOTA quantize matrix + 4 size rows
- `capture.html` 31 KB - 3-mode capture flow + redaction screenshots
- `sdks.html` 24 KB - Node/Python/MCP/VSCode/C/Rust quickstarts
- `product.html` 22 KB - 4-pillar hero + 8-card production-workflow grid + 6-cell strip
- `runtimes.html` 18 KB - 7-target deploy matrix
