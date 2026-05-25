# Kolm Product Media Proof Seed

Date: 2026-05-25

Audience: internal implementation agents only. This is not a public media brief, not external brand copy, and not a customer-facing design document.

Purpose: seed `docs/product-media-proof.json`, the control file that should prove every important image, video, demo, diagram, screenshot, product preview, and social card on Kolm is real, useful, accessible, theme-safe, and tied to a product feature.

Related documents:

- `docs/research/kolm-internal-spec-index-2026-05-25.md`
- `docs/research/kolm-master-spec-consolidated-review-2026-05-25.md`
- `docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md`
- `docs/research/kolm-p0-control-files-buildbook-2026-05-25.md`
- `docs/research/kolm-product-feature-completion-matrix-seed-2026-05-25.md`
- `docs/research/kolm-design-cascade-ledger-seed-2026-05-25.md`

## Direct Assessment

Current product media is not yet strong enough to support a state-of-the-art product claim.

The repository contains media assets, but the public HTML currently relies mostly on inline SVG, metadata images, CSS backgrounds, and text-heavy demos. Static inspection found no `<video>`, `<source>`, `<picture>`, `<iframe>`, or `<canvas>` elements in public HTML, and only four `<img>` tags across public HTML, all on `public/press.html`.

That does not mean every page is broken. It means the product media layer is not governed. The site can have visual files in `public/` while the product pages still fail to show real product proof.

## Current Evidence Snapshot

Media files under `public/`:

| type | count |
|---|---:|
| `.svg` | 188 |
| `.png` | 48 |
| `.mp4` | 1 |
| `.webm` | 1 |
| `.webp` | 1 |
| `.jpg` | 1 |

Public HTML media tags:

| tag or attribute | count |
|---|---:|
| `<img>` | 4 |
| `<video>` | 0 |
| `<source>` | 0 |
| `<picture>` | 0 |
| `<iframe>` | 0 |
| `<canvas>` | 0 |
| `<object>` | 0 |
| `<embed>` | 0 |
| `<svg>` | 1,820 |
| `alt=` | 5 |
| `loading="lazy"` | 0 |
| `width="..."` | 4,897 |
| `height="..."` | 4,255 |

Large or relevant media assets observed:

| asset | bytes | initial classification |
|---|---:|---|
| `public/assets/hero-warm-paper-bg.png` | 7,031,506 | large background; needs performance and purpose review |
| `public/brand-aurora-field.png` | 1,951,708 | brand/atmospheric asset; likely not product proof |
| `public/brand-hero-prism.png` | 1,728,368 | brand/atmospheric asset; likely not product proof |
| `public/brand-hero.png` | 1,723,633 | social/brand image; needs route ownership and current visual review |
| `public/video/kolm-hero.mp4` | 1,640,110 | video asset exists; static HTML scan found no direct `<video>` usage |
| `public/video/kolm-hero.webm` | 1,438,521 | video asset exists; static HTML scan found no direct `<video>` usage |
| `public/video/kolm-hero-poster.jpg` | 227,251 | video poster; needs direct association with a video component |
| `public/img/brand-og.webp` | 17,664 | optimized social/OG asset |
| `public/cdn/kolm-assets/tui-demo.cast` | 10,361 | terminal demo asset; needs route, renderer, fallback, and screenshot proof |

Latest local media-focused reports found:

| report | result | relevant finding |
|---|---|---|
| `reports/ui-surface-audit/2026-05-23Tmanual-use-home-product-pricing-account/report.md` | fail | `/`, `/product`, and `/pricing` reported product-media missing; product media renders verified: 0 |
| `reports/ui-surface-audit/2026-05-23Tfocused-polish-pass/report.md` | fail | `/`, `/product`, and `/pricing` reported product-media missing; product media renders verified: 0 |

Important caveat: those reports are local snapshots from 2026-05-23, not proof of the current deployed site after later frontend work. The current static scan still shows the deeper structural problem: real media elements are not first-class in product pages.

## What Counts As Product Media

Allowed product media types:

- real product screenshot
- authenticated account screenshot with safe fixture data
- CLI/TUI recording or rendered terminal cast
- real `.kolm` artifact visual or receipt view
- route/capture before-and-after code comparison
- live demo runner with loading/error/success states
- explainer video with transcript, captions, poster, fallback, and current UI
- technical diagram that maps to real product objects, routes, artifacts, or receipts
- generated bitmap image only if it faithfully represents the actual product state and is labeled as illustrative
- social/OG image only if route-specific and current

Disallowed as primary product proof:

- abstract aurora backgrounds
- decorative gradients
- atmospheric brand art
- vague architecture art that does not map to current product objects
- hidden test anchors
- text-only "demo" boxes with no interaction or artifact output
- unreferenced video files
- screenshots from stale routes or old pricing/product states
- media that works only in dark or only in light mode

## Page Family Media Requirements

| page family | required media proof |
|---|---|
| Homepage | one real first-screen proof: live `.kolm` runner, real code swap, or short product video; must cover route/capture, distill/compile, and run/govern. |
| Product overview | one integrated architecture visual tied to current product graph and one concrete workflow proof. |
| Capture pages | before/after OpenAI-compatible call, captured event view, redaction/storage state, and artifact candidate preview. |
| Distill/compile pages | teacher/student strategy, K-Score report, quantization result, artifact signature, and failure-mode view. |
| Runtime/device pages | runtime/device matrix, memory/latency/device-fit proof, install or run command, and receipt. |
| Pricing/ROI | calculator state, plan truth, savings assumption transparency, and no decorative filler. |
| Enterprise/trust | control evidence, audit export, readiness state, certification-scope labels, and compliance packet previews. |
| Docs/quickstart | runnable code, expected response, generated artifact, and troubleshooting state. |
| Account pages | actual operational panels with safe fixture data, loading/empty/error/partial states, and next action. |
| Comparison pages | current competitor matrix, source dates, and proof of what Kolm does differently. |
| Social/OG | route-specific image, accessible alt text, and current positioning. |

## Video And Demo Contract

Any video above the fold or in a hero must have:

1. `<video>` or equivalent component present in the route markup.
2. WebM and MP4 sources if self-hosted.
3. Poster image.
4. Width, height, or aspect-ratio.
5. Captions or transcript.
6. Loading state.
7. Error fallback.
8. Reduced-motion handling.
9. Dark/light and mobile/desktop screenshot proof.
10. Current UI, current pricing, current product names, and no stale claims.

Any live demo must have:

1. Working input.
2. Working output.
3. Visible loading state.
4. Visible error state.
5. Copyable result.
6. Safe default fixture.
7. No secret leakage.
8. API route or local simulation ownership.
9. Production smoke proof.
10. Screenshot proof after the latest frontend changes.

## Route-Level Initial Redlines

| route or asset | current redline |
|---|---|
| `/` | Needs real first-screen proof media. Current code has a diagram and CLI/text blocks, but static scan found no video/img/demo media element. |
| `/product` | Needs route-specific product media proving the three-surface product shape. Earlier local report failed product media. |
| `/pricing` | Needs ROI/calculator proof media or interactive proof; earlier local report failed product media. |
| `/enterprise` | Needs enterprise control/readiness/audit proof, not decorative visuals. |
| `/account/*` | Needs safe fixture screenshots and state coverage per product feature; not just table shells. |
| `public/video/kolm-hero.*` | Video files exist but need explicit route ownership, transcript, fallback, and screenshot proof. |
| `public/assets/hero-warm-paper-bg.png` | Large background needs performance budget and proof that it improves product clarity. |
| `public/img/_generations/*` | Generated raw images need archive/delete/use classification. |
| `public/og/*` | Route-specific social images need source route, freshness date, alt text, and visual review. |

## Product Media Proof Schema Seed

Each media item should include:

```json
{
  "id": "homepage-hero-demo",
  "path": "public/video/kolm-hero.webm",
  "type": "video",
  "status": "needs-route-owner",
  "product_surface": "route_capture_distill_compile_run_govern",
  "route_paths": ["/"],
  "feature_ids": ["gateway-capture", "train-distill", "runtime-inference"],
  "source_of_truth": "public/index.html",
  "is_primary_proof": true,
  "is_decorative": false,
  "has_alt_or_label": true,
  "has_caption_or_transcript": false,
  "has_fallback": false,
  "has_dimensions": true,
  "theme_coverage": ["dark", "light"],
  "viewport_coverage": ["desktop", "mobile"],
  "latest_screenshot_report": null,
  "production_smoke": null,
  "claim_scope": "local-unproven",
  "owner": "frontend",
  "required_next_action": "Wire video or replace with a live demo runner that proves the current product."
}
```

Required `type` values:

- `screenshot`
- `video`
- `poster`
- `diagram`
- `inline-svg`
- `og`
- `logo`
- `demo`
- `terminal-cast`
- `code-comparison`
- `artifact-preview`
- `receipt-preview`
- `background`
- `decorative`
- `archive`

Required `status` values:

- `canonical`
- `needs-route-owner`
- `needs-accessibility`
- `needs-transcript`
- `needs-fallback`
- `needs-screenshot-proof`
- `needs-production-proof`
- `decorative-only`
- `stale`
- `archive`
- `delete`

## Verifier Requirements

Add `scripts/build-product-media-proof.cjs` and `scripts/verify-product-media-proof.cjs`.

Minimum behavior:

1. Enumerate media assets under `public/`.
2. Extract image, video, picture, source, iframe, canvas, SVG, OG image, CSS background, and demo references from public HTML/CSS/JS.
3. Identify unreferenced media assets.
4. Identify referenced missing assets.
5. Require alt/label for meaningful images and SVGs.
6. Require transcript/caption/fallback for videos.
7. Require dimensions or aspect-ratio for media that can affect layout.
8. Join media to product feature IDs and route paths.
9. Join media to latest screenshot reports.
10. Detect whether primary pages have at least one visible proof media component.
11. Separate decorative media from product proof.
12. Emit `docs/product-media-proof.json`.
13. Emit `docs/product-media-proof.md`.
14. Fail in strict mode if homepage, product, pricing, enterprise, docs, account, and demo routes lack proof media.

## Implementation Order

1. Build the media inventory in warn mode.
2. Classify existing assets: proof, decorative, social, archive, generated raw, delete.
3. Wire the existing `public/video/kolm-hero.*` assets or explicitly retire them.
4. Add or replace homepage first-screen media with a real product proof surface.
5. Add product-media proof to `/product`, `/pricing`, `/enterprise`, `/docs`, and `/account/overview`.
6. Generate route-specific OG/social image ownership.
7. Add screenshot report linkage.
8. Promote verifier from warn mode to fail mode.

## Redline Before Product Media Is Done

Do not claim product media is complete until:

- every important public page has visible product proof media
- video assets are either used with transcript/fallback or archived
- generated raw images are either promoted, optimized, or removed
- social images are route-owned and current
- account screenshots use safe fixture data and cover product states
- product media has dark/light and mobile/desktop screenshot proof
- product media has production proof for the exact deployed commit
- decorative assets are not counted as product proof
- the verifier is wired into `verify:depth`

