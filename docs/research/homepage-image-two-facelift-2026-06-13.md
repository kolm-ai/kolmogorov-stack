# Homepage Image-2 Facelift - 2026-06-13

## Local Reference

- Workspace reference image: `_audit/test/ev2.png`
- Current homepage screenshot before this pass: `reports/ui-surface-audit/2026-06-13T06-01-56/screenshots/home__desktop.png`

## Visual Gap

The compiler homepage was technically coherent but visually heavy: dark chamber, high glow, dense paneling, and an old audit-era social image. The image-2 reference points in the opposite direction:

- light paper surface
- restrained dotted grid
- thin navigation
- black primary action
- green product accent
- dark technical artifact panel
- more editorial whitespace around the hero copy

That direction fits infrastructure buyers better than a decorative dark landing page because the product should read as an operator-grade control plane.

## Product Requirement

The homepage must keep the proof-led product contract while adopting the image-2 visual language:

1. Preserve the exact compiler positioning: `API behavior in. Device-fit models out.`
2. Preserve the API Control Center first action.
3. Preserve the infra proof board and backend contract endpoints.
4. Use paper-mode homepage styling only on the homepage to avoid accidental regressions on other product pages.
5. Replace audit-era homepage social imagery with a compiler-specific image path.
6. Keep desktop and mobile layouts free of horizontal overflow and sub-44px interactive targets.

## Local Delta

This pass adds `compiler-site--paper-home` and `data-design-reference="image-2"` to `public/index.html`, then scopes the light paper visual system to that page in `public/kolm-main.css`.

It also switches the homepage OpenGraph/Twitter image to `/compiler-brand-hero.png` so the main product no longer uses the old audit-only `brand-hero.png` as its first shared visual.

## Corrective Full-Bleed Pass

The split paper direction was still too close to a conventional SaaS landing page and could regress into a bland product card. The corrected first viewport uses image 2 as the stage, not decoration:

1. The H1 is now the literal product/category signal: `Kolm API Control Center`.
2. `compiler-brand-hero.png` is a full-bleed product artifact behind the copy on desktop and mobile.
3. Dark overlays and the grid are attached to the artifact layer so the composition stays coherent at all breakpoints.
4. The legacy mobile override that converted the artifact into a small card is removed.
5. The primary CTA sends operators directly to `/account/api-control-center`, with `/docs/api` as the secondary proof path.
6. The hero caption states the source-to-proof loop and the readiness gated control posture without claiming external superiority.

## Regression Requirement

`tests/site.test.js` should assert the image-2 design reference, paper-home body class, compiler-specific social image, API Control Center CTA, proof board, route counts, contract endpoints, and bounded claims.
