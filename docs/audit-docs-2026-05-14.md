# kolm docs + README audit — 2026-05-14

Reference output from the docs-audit agent. Use this to drive the v10b docs fix wave.

## Top 15 problems (ranked by user impact)

1. **No deployment/operations guide** — README has ops bits, no dedicated ops/checklist doc.
2. **Stale trainer-bridge references** — README/spec say LoRA bundling is "next"; the trainer at `apps/trainer/` already ships.
3. **CLI verbs vs docs mismatch** — CLI exposes 40+ commands; public docs list only ~10. distill/tune/rag/serve/capture undocumented publicly.
4. **RS-1 spec incomplete** — v0 vs v0.1 receipt shapes documented incompletely; ed25519 mentioned in README:199 but not in docs/rs-1.md.
5. **Missing installation guide** — quickstart assumes global npm install works; no Node version matrix, no Windows gotchas.
6. **API reference incomplete** — README lists 40+ endpoints; api.html renders only ~12. `/v1/plans`, `/v1/session/*`, `/v1/embed`, `/v1/compose` missing from public reference.
7. **No troubleshooting guide** — public/troubleshooting.html minimal/empty. Common issues (rate limits, auth, BYOC attestation, trainer timeouts) undocumented.
8. **Broken cross-references** — README:14 points to `public/docs/rs-1.md`; spec lives at `docs/rs-1.md`.
9. **Glossary thin** — missing: verifier, k-sample, witness, sandbox, adapter, specialist, bundle tiers, capture namespace, HMAC chain.
10. **Code samples may be stale** — public/docs.html:60 "captured 2026-05-11" hardcoded.
11. **BYOC/attestation undocumented** — `packages/attestation/README.md` exists; no public guide. Enterprise feature dark.
12. **Tone drift** — articles read marketing; api reference terse. Inconsistent audience.
13. **Quickstart prerequisites missing** — no mention of Anthropic API key, auth flow, example JSON format.
14. **Outdated product-gates section** — README:192-201 says "next gates: replace JSON store" but `KOLM_DATA_DIR` is already prod.
15. **No security model deep dive** — secret rotation, leak playbook, offline verification limits, third-party attestation undocumented.

## Missing sections (priority)

| Section | Home | Priority |
|---|---|---|
| Installation | docs/getting-started.md, public/install | High |
| Troubleshooting | public/troubleshooting.html | High |
| Deployment / prod checklist | docs/ops.md | High |
| CLI Reference (full 28-verb table) | public/cli.html | High |
| BYOC / attestation | public/byoc.html | Medium |
| Glossary expansion (20+ terms) | public/glossary.html | Medium |
| Tune / distill workflow | public/docs.html | Medium |
| Migration guides | docs/migrations.md | Low |
| FAQ / common errors | public/faq.html | Medium |

## Stale content to delete

- README:27 — "Full LoRA weight bundling is the next product gate" (trainer bridge ships)
- README:192-201 — Product Gates section confuses roadmap with reality
- public/docs.html:60 — "captured 2026-05-11" hardcoded date

## Code samples needing re-verification

- cli/kolm.js:8-47 example commands vs actual help output
- docs/rs-1.md:48-54 curl example for offline receipt verification
- apps/trainer/README.md:17-30 — Docker + uv venv examples vs current main.py

## Canonical docs hierarchy (proposed)

```
/quickstart           60s: login → compile → run → verify
/docs
  Getting Started     install, prerequisites, auth
  Tutorials           CLI, API, BYOC golden paths
  API Reference       all endpoints with schemas
  CLI Reference       28 verbs grouped: author, run, evolve, observe, deploy, govern
  Concepts            K-score, recipe, receipt, distillation, witnesses, attestation
  Glossary            full
  Troubleshooting     rate limits, auth, trainer, attestation
  Security            receipt validation, offline verification, attestation
/spec                 RS-1 spec, schemas
/api                  reference (alias /docs)
/research             articles + benchmarks
/changelog            releases + spec changes
/glossary             standalone searchable
```
