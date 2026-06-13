# Homepage Command Deck Design Upgrade

Date: 2026-06-13

## Design Problem

The homepage had become mechanically valid but visually generic. The hero showed image 2, yet the first viewport still depended mostly on copy, and the proof board below it read as ordinary SaaS cards rather than a memorable infrastructure product surface.

## Design Rule

Kolm should look like an enterprise API control room:

1. The first viewport must show the product/category, the artifact, the primary action, and live proof metrics.
2. Image 2 should behave like a product artifact stage, not a decorative card.
3. The second section should make the category wedge visual: source systems, Kolm kernel, and proof outputs.
4. Competitor research belongs in a market map, not vague comparison claims.
5. The page must stay honest: no public "100x" superiority claim until benchmark, package-release, certification, and partner-adoption gates close.

## Implementation

- Added a hero command strip with route, group, channel, and open-gate invariants.
- Reframed the proof board as a `Command Deck` with the compact headline `Control every API signal into proof.` and explicit readiness-gated artifact language.
- Added a right-side invariant rail so the second viewport has a visible command surface instead of a large empty copy block.
- Removed the inherited section-head width constraint that was forcing the command-deck headline into a narrow desktop column.
- Wrapped invariant-row copy so inline code stays in the value column, and kept the proof metric strip two-column on phone viewports.
- Converted the proof strip into a dark command bar so the page has a signature visual rhythm.
- Added source/kernel/proof labels to the control map.
- Upgraded the central API Control Center kernel copy from "govern the loop" to "sign the transition" and tied semantic promotion to adapter evidence, policy, redaction, and receipt gates.
- Added a direct API contract action inside the public-contract console.
- Added tablet and mobile guards for the new section head, map labels, command strip, and proof board.

## Verification Requirement

Run:

```powershell
node --test --test-concurrency=1 tests/site.test.js tests/product-compiler-contract.test.js
npm.cmd run ui:audit:critical -- --routes / --json
npm.cmd run ui:audit:critical -- --json
npm.cmd run build:control-files
npm.cmd run verify:control-files
npm.cmd run lint:refs
npm.cmd run verify:claims-scope
```

The full repo `npm.cmd run lint` is currently blocked by broad pre-existing unused-variable and undefined-symbol debt outside this design pass. Do not use that failure as evidence that the homepage visual system is unverified; use the targeted page contracts and UI surface audits for this pass.
