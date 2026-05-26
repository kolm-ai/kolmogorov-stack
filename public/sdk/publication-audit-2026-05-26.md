# SDK Publication Audit — 2026-05-26

Auditor: wave3-sdk-audit
Scope: 6 SDKs the homepage advertises (Node, Python, MCP, VSCode, C, Rust).
Method: static read of `sdk/*/{package.json,pyproject.toml,Cargo.toml,README.md}` plus cross-check against `public/index.html` and `public/sdks.html`. No outbound network calls made (registry presence inferred from in-repo signal only — flagged as UNKNOWN where signal is missing).

## Summary

- 6 SDKs reviewed.
- Published (probable): **0**
- Not published: **4** (Node, Python, MCP, VSCode)
- Vendor-only by design (no registry expected): **1** (C — single-header drop-in)
- Unknown without a registry probe: **1** (Rust — crate name `kolm` may collide with an unrelated existing crate; cannot confirm ownership offline)

Homepage status: `public/index.html` line 458 advertises "6 SDKs"; `public/sdks.html` line 134 reads "Six shipped bindings". The sdks.html page is partially candid (Python entry says "Install from source today; PyPI publish in flight") but Node, MCP, and VSCode entries still ship registry-style install commands (`npm install @kolm/sdk`, `npm install -g @kolm/mcp-server`, `code --install-extension kolm.kolm-vscode`) that the in-repo READMEs themselves disclaim.

## Findings

### Node SDK (sdk/node/)

- Package name in manifest: `@kolm/kolm-sdk`
- Version: `0.2.0`
- `private` flag: absent (technically publishable)
- README (`sdk/node/README.md` line 9): "The npm package is not published yet. Use a local checkout while the package is prepared."
- Homepage claim (`public/sdks.html` line 194): `$ npm install @kolm/sdk`
- Status: **NOT-PUBLISHED**
- Constraint: install command on the homepage (`@kolm/sdk`) does not match the manifest name (`@kolm/kolm-sdk`). Even if the homepage line worked, it would resolve to a different (possibly unowned) npm slug.
- Recommendation: publish `@kolm/kolm-sdk` (or `@kolm/sdk` if the `@kolm` org owns it) OR update homepage to the git-from-source line the Node README already documents (`npm i file:./kolm-stack/sdk/node`).

### Python SDK (sdk/python/)

- Package name in manifest: `kolm`
- Version: `0.2.0`
- README (`sdk/python/README.md` line 7): "Registry status: not published under Kolm control. The `kolm` name on PyPI is an unrelated Korean language-modeling toolkit, so do not install the PyPI `kolm` distribution as this SDK until ownership or a new package name is resolved."
- Homepage claim (`public/sdks.html` line 205): `$ pip install git+https://github.com/sneaky-hippo/kolmogorov-stack@main#subdirectory=sdk/python` plus comment "PyPI pending"
- Status: **NOT-PUBLISHED**
- Constraint: name collision on PyPI is a hard blocker — a user who runs `pip install git+https://github.com/sneaky-hippo/kolmogorov-stack@main#subdirectory=sdk/python` lands on the unrelated Korean LM toolkit. Homepage handles this correctly (git-from-source install line), but the implicit `kolm` rename is still unresolved.
- Recommendation: rename to a non-colliding PyPI slug (e.g. `kolm-ai`, `kolm-sdk`, `kolmogorov`) and publish, OR negotiate transfer of the existing `kolm` PyPI namespace.

### MCP SDK (sdk/mcp/)

- Package name in manifest: `@kolm/recipe-mcp`
- Version: `0.2.0`
- `private` flag: absent
- README (`sdk/mcp/README.md` line 9): "This package is not published on npm under Kolm control yet. From a repo checkout, point your MCP client at the local server."
- Homepage claim (`public/sdks.html` line 217): `$ npm install -g @kolm/mcp-server`
- Status: **NOT-PUBLISHED**
- Constraint: install command on the homepage (`@kolm/mcp-server`) does not match the manifest name (`@kolm/recipe-mcp`). Two different slugs; only one can be the real publish target.
- Recommendation: pick a canonical slug, align manifest + homepage + README, then publish.

### VSCode SDK (sdk/vscode/)

- Package name in manifest: `kolm-vscode`, publisher `kolm`, version `0.3.0`
- README (`sdk/vscode/README.md` line 14): `code --install-extension kolm-vscode-0.2.0.vsix` (local `.vsix` file, NOT a marketplace install — and the README version `0.2.0` is stale vs. manifest `0.3.0`)
- Homepage claim (`public/sdks.html` line 229): `$ code --install-extension kolm.kolm-vscode` (marketplace-style `<publisher>.<name>` identifier)
- Status: **NOT-PUBLISHED** (probable). The README install path is a local `.vsix` file produced by `vsce package`, not a marketplace pull. No published-marketplace artifact is referenced anywhere in the repo.
- Constraint: homepage assumes the extension is live on the VS Code Marketplace under `kolm.kolm-vscode`. README contradicts this. Version drift between README (0.2.0) and manifest (0.3.0) is a separate cleanup.
- Recommendation: publish to the VS Code Marketplace via `vsce publish` under publisher `kolm` (requires a verified publisher account) OR change the homepage install line to direct users to the `.vsix` build instructions.

### C SDK (sdk/c/)

- Manifest: NONE (single-header library; no package manifest — by design)
- Files: `kolm.h`, `kolm-format.h`, `kolm-cli.c`, `Makefile`, `README.md`
- README (`sdk/c/README.md` line 5–14): vendor the header into your tree; `#define KOLM_IMPLEMENTATION` in one TU; link libcurl.
- Homepage claim (`public/sdks.html` line 240): `$ curl -L -o kolm.h https://github.com/sneaky-hippo/kolmogorov-stack/raw/main/sdk/c/kolm.h`
- Status: **PUBLISHED-PROBABLE** (in the vendor-from-source sense — there is no registry to publish to for an stb-style single-header library; serving the raw file from GitHub IS the publish channel)
- Constraint: depends on the GitHub raw URL staying stable. No semver guarantee outside of the `KOLM_SDK_VERSION` constant inside the header itself.
- Recommendation: none needed. The header-only model matches the homepage claim. Optional: mirror to a CDN with a stable versioned URL (e.g. `kolm.ai/sdk/c/kolm.h`).

### Rust SDK (sdk/rust/)

- Package name in manifest: `kolm`
- Version: `0.2.0`
- `Cargo.toml` repository URL: `https://github.com/kolm-ai/kolm-stack` (note: differs from the actual repo `sneaky-hippo/kolmogorov-stack` — manifest points at a placeholder org that may not exist)
- README (`sdk/rust/README.md` line 7–11): `[dependencies] kolm = "0.2"` — implies the crate is published on crates.io
- Homepage claim (`public/sdks.html` line 249, 252): badge reads "kolm v0.1.0", install line reads `$ cargo add kolm`, comment reads `# or in Cargo.toml: kolm = "0.1"`
- Status: **UNKNOWN**
- Constraints:
  1. Cannot confirm crates.io ownership of the `kolm` name offline. The slug is short and generic; a name-squat collision is plausible.
  2. Homepage badge ("v0.1.0") and inline `kolm = "0.1"` snippet are out of sync with the Cargo.toml version (`0.2.0`).
  3. `Cargo.toml` repository URL points at `github.com/kolm-ai/kolm-stack` while the real monorepo is `github.com/sneaky-hippo/kolmogorov-stack`. A `cargo publish` from this manifest would ship the wrong repo link.
- Recommendation: confirm crates.io ownership of `kolm` (or pivot to `kolm-sdk` / `kolm-ai`), publish v0.2.0, then update the homepage version pill and inline snippet to match.

## Cross-cutting follow-ups (flagged, not fixed)

1. **Name drift across surfaces.** Three SDKs (Node, MCP, VSCode) have different slugs in the manifest vs. the homepage install line. Pick one canonical name per SDK, then propagate through manifest, README, homepage, and docs/sdk/* pages.
2. **Version drift.** VSCode README references v0.2.0 while manifest is v0.3.0. Rust homepage badge says v0.1.0 while Cargo.toml is v0.2.0. A pre-publish version-sync script (similar to `scripts/build-changelog.cjs`) would catch this.
3. **Homepage claim "6 SDKs" is partially defensible.** All 6 sources exist in `sdk/*/` and are functional from a checkout. But the consumer reading "6 SDKs" plus a marketplace-style install line will hit a 404 on npm / VS Code Marketplace for at least 3 of them. The sdks.html Python entry is the model: explicit "PyPI pending" note plus a git-from-source install line. Apply the same pattern to the Node, MCP, and VSCode entries until those registries actually contain the package.
4. **Repo URL mismatch in Rust Cargo.toml.** `kolm-ai/kolm-stack` vs. real `sneaky-hippo/kolmogorov-stack`. Fix before any `cargo publish`.

## Top 3 blockers (post-launch fix order)

1. **PyPI name collision on `kolm`.** Cannot publish until rename or namespace transfer. Recommended slug: `kolm-ai` or `kolm-sdk`.
2. **Three npm/marketplace slugs that do not match the manifest.** Node (`@kolm/sdk` vs `@kolm/kolm-sdk`), MCP (`@kolm/mcp-server` vs `@kolm/recipe-mcp`), VSCode (homepage assumes marketplace, README ships a local `.vsix`). Decide canonical names and align everywhere before publishing.
3. **Rust crate `kolm` ownership unverified.** Short generic name on crates.io is a likely collision. Confirm or rename before `cargo publish`.

Until items 1–3 land, the homepage "6 SDKs" claim should either soften to "6 source-available SDKs · registry publish in flight" or each of the 4 not-published bindings should adopt the git-from-source / vendor-from-source install lines that the in-repo READMEs already document.
