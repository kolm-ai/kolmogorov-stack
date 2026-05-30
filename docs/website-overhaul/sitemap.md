# kolm — First-Principles Sitemap (Phase 0 decision)

Derived from positioning (AI Compiler; own/prove/govern; indie-led + enterprise-monetized), the 6 personas, and the page manifest (1,187 pages today → intentional target ~150–200). Drives Phase 3 dispositions.

## Top nav (5)
**Product · Solutions · Proof · Docs · Pricing** — (+ Sign in / Start free). Kills the wrapper/studio jargon split.

## Intentional marketing spine (KEEP/ELEVATE/NET-NEW)
- `/` — home (8-section arc: own it → proof → how → receipt → run anywhere → enterprise trust → personas → close)
- `/product` *(NET-NEW; merges wrapper + studio)* — the compiler, end to end
- `/proof` *(NET-NEW)* — the moat surface: Trinity-500 benchmark + live receipt verify + signed-provenance explainer
- `/solutions` + `/solutions/{developers,teams,enterprise}` *(NET-NEW hub)* + verticals `/healthcare /finance /legal /defense /insurance` (merge each `*-v2` → canonical)
- `/pricing` (6 tiers, real)
- `/enterprise` (SSO/SCIM/RBAC/BYOC/data-residency/audit + secure-training guarantee)
- `/security` (true SOC2 status, SLSA, SBOM, threat-model, secure-training guarantee)
- `/compare` hub + the real competitor set (`/compare/kolm-vs-{openai,together,openpipe,fireworks,predibase,ollama,…}`) — KEEP, consolidate `/vs/*`+`how-vs-*` duplicates into `/compare/*`
- `/about`, `/manifesto`, `/changelog`, `/blog` (KEEP dated launch posts; RETIRE template stubs), `/customers` *(NET-NEW, only when real logos exist)*
- `/start` (no-code), `/quickstart`, `/download`

## Docs (491 → curated tree)
Keep one canonical tree: getting-started, connect-providers, distill, quantize, serve/run, gateway, govern, deploy (docker/k8s/vllm/airgap), enterprise, API, SDKs, .kolm spec. MERGE the overlapping gateway/studio/run sub-suites into one per area. RETIRE thin stubs + untranslated i18n. Target ~80–120 real docs pages.

## App (`/account`, 93 → coherent set)
KEEP the real surfaces: overview, models, builds, distill-runs, captures, datasets, artifacts, devices/fleet, billing, api-keys, settings, team/members/groups, governance (audit/approvals/lifecycle/evidence), enterprise/sso, namespaces. RETIRE `_template`/`_slug` example fixtures + duplicate views.

## Big cuts (RETIRE-by-redirect, never blind-delete)
- `compile/` (71) + `marketplace/` (18) + most `research/` (59) + `cookbook/` (35) stubs → redirect to the canonical hub (`/docs`, `/research` index, `/account/builds`). Grep `tests/` for each slug; keep test-anchor stubs.
- `*-v2` verticals → canonical. `about-the-assistant` → `/about`. `wrapper`+`studio` → `/product`. `vs/*` + `how-vs-*` → `/compare/*`.

## Net-new pages to build
`/product`, `/proof`, `/solutions` (+3 children), `/customers` (gated on real traction).

> Execution note: all cuts via vercel.json redirect + test-anchor stub. The KEEP/ELEVATE set (~150–200) gets the exhaustive atomic per-page SOTA sweep in Phase 3.
