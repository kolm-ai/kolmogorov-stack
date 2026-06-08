# State-of-the-Art Readiness — Punch-list (tracker)

Current grade: **C+** (world-class crypto core, junior-grade packaging). Bar = "an elite security researcher respects it on sight; an enterprise buyer trusts it on first read." Source: `SOTA-AUDIT.json`.

## P0 — must fix before showing elite auditors / enterprise buyers
- [x] **Crypto: validate `asymmetricKeyType==='ed25519'` in all key loaders** — `src/ed25519.js` (2), `src/auditor-attestation.js` (2) + new test `tests/wave167-ed25519-keytype.test.js` (6/6 green; existing 50/50 green). ✅
- [ ] **Sitewide positioning** → audit/researcher-signed narrative (hero, h1, title, meta, OG/Twitter, footer, nav, README). *Needs founder eye on brand voice.*
- [ ] **/researchers (auditor network) page** + /onboard/auditor + co-sign terms. *Needs real auditor names/bios/credentials from founder.*
- [ ] **Promote Halborn pentest** — remove `noindex`, add hero/proof badge + `/security/audit-reports` table.
- [x] **Client-side receipt-verify (REAL, offline)** — `public/kolm-verify.js`: dependency-free WebCrypto Ed25519 verifier; canonicalization byte-identical to `receipt-schema.js`; recomputes fingerprint, optional issuer-key pinning, no canned "OK" lines. Proven by `scripts/verify-browser-parity.mjs` (server-verify ✅ + browser-path ✅ + tamper ✅) against a now-**reproducible** `public/sample-receipt.json` (fixed demo key + id/timestamp). **Page UI wired ✅:** `public/verify-widget.js` (auto-mounts `[data-verify-widget]`, streams real checks, Tamper→red) in the hero + live-demo of `index-2026.html`; full paste/load/drop verifier at `public/verify-2026.html`. E2E re-proven by importing the *actual* shipped module under Node WebCrypto: sample ok=true / tamper ok=false ✅.
- [ ] **Public explainer + SECURITY.md** — `SECURITY.md` ✅ written; still need `/docs/auditor-attestation`, `/docs/transparency-log`.
- [x] **🔴 P0 — killed verifier theater in `packages/browser-extension/verifier.js`** — was printing hard-coded `[6/6] OK signature valid` with NO crypto. Now: real zip-header + real SHA-256 checks, then candidly defers full HMAC-chain/Ed25519/K-score to `kolm verify` (no fake greens). (`public/verify-prod.html` was already candid.) ✅

## P1 — important, soon
- [x] **`secrets-vault.js` perm hardening** — `writePrivateFile()` + `ensureDir()` now chmod 0o600/0o700 AND verify the mode on POSIX, throwing `vault_file_insecure`/`vault_dir_insecure` instead of the old silent `catch {}`. win32 skips (no POSIX modes). Covered by `tests/wave168` #8/#9. ✅
- [x] **Export `verifyInclusionProof`** from `transparency-log.js` — stand-alone offline proof verify; accepts snake_case (server) + camelCase (merkle) shapes; optional signed-checkpoint binding (root+size match + Ed25519 sig). `tests/wave168` #1-#7 (7/7). ✅
- [~] **Widen `keyFingerprint` to 256-bit** — **DEFERRED (intentional).** 128-bit truncated SHA-256 gives 2^128 second-preimage resistance (sufficient for a key id); widening ripples through 69 files incl. embedded receipt fingerprints + `wave310` test. Documented as a deliberate truncation in `SECURITY.md` instead of a risky churn. Revisit only if an external cryptographer flags it.
- [ ] Transparency log: public read endpoints + honest single-process durability disclosure (Rekor anchor = roadmap).
- [ ] Formal spec `/docs/spec/kolm-attestation-v1` (RFC-style).
- [ ] Engage external cryptographer (Trail of Bits / NCC) — long lead, start early. *Founder decision.*
- [ ] Quantified proof points + SOC 2 schedule with dates.
- [ ] `SECURITY.md` ✅ + `CODEOWNERS` (needs founder GitHub handle/team).

## P2 — polish / hardening
- [ ] in-toto receipt version negotiation in verify.
- [ ] DSSE PAE byte-vector test (RFC 9453 interop).
- [ ] crossCheck drift tolerance configurable (default 1e-4; 1e-6 regulatory).
- [ ] CI signing-guard key-freshness re-check.
- [ ] `SignerInterface` (HSM/KMS abstraction: FS/Env + AWS KMS stub).
- [ ] Key-compromise/revocation path (valid_until + CKL).
- [ ] Transparency-log cross-tenant + concurrency isolation tests.
- [ ] Test isolation: per-test `KOLM_ED25519_KEY_STORE`.
- [ ] Design: monochrome accent discipline, `font-display: swap`, remove dead CSS.
- [ ] JSON-LD schema for audit-service narrative.
- [ ] `router.js` (~27k lines) + `src/` split into domain routers (long-horizon).
- [ ] Binder offline state: surface `{ed25519_verified, hmac_verified}`.

## Needs founder input (not blocking the technical fixes)
1. **Auditor bios** for /researchers (names, credentials, LinkedIn) — the credibility centerpiece.
2. **Brand voice sign-off** on the positioning rewrite before it goes live.
3. **GitHub handle/team** for CODEOWNERS; **go/no-go on external crypto review**; **deploy approval** (nothing ships to prod without it).
