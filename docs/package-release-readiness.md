# Package release readiness

Kolm has several local SDK and installer surfaces whose final public state depends on external package channels. This audit keeps those gates honest: source, manifest, docs, and dry-run commands must be present locally, while npm, PyPI, crates.io, SwiftPM, Maven, Homebrew, apt, winget, and browser-store publication stay explicitly marked as channel work until signed release artifacts exist.

Run:

```bash
node scripts/package-release-readiness.mjs --summary --require-local-contract
node scripts/package-release-readiness.mjs --smoke-installers --summary
node scripts/package-release-readiness.mjs --run-local-checks --summary
```

Machine-readable output:

```bash
node scripts/package-release-readiness.mjs --json
node scripts/package-release-readiness.mjs --catalog
node scripts/package-release-readiness.mjs --target=sdk-ts --json
node scripts/package-release-readiness.mjs --smoke-installers --json
node scripts/package-release-readiness.mjs --run-local-checks --target=langchain-npm --json
```

The checker covers:

- `runtime-wasm`: TypeScript/browser package plus Rust runtime package.
- `ios-android-sdk`: SwiftPM, Android/Kotlin, and React Native package surfaces.
- `sdk-depth`: Node-style packages, Python packages, Rust runtime, mobile SDKs, extension packaging, and integrations.
- `one-line-install`: direct install scripts, Homebrew, apt, and winget manifests.

Version alignment:

- Homebrew tarball URL, apt control version, and all winget package/installer manifests must match the root `package.json` version.
- Version drift is treated as a local structural failure because it sends operators to stale artifacts even before public package channels are published.

Installer smoke:

- PowerShell: runs `scripts/install.ps1 -WhatIf` through `powershell` or `pwsh`, which now performs a no-write dry-run and prints the clone, shim, version, and doctor operations it would execute.
- POSIX shell: runs `sh -n scripts/install.sh` when `sh` is available; otherwise the check is reported as skipped instead of pretending shell execution was proven on that host.
- Debian package plan: runs `node scripts/build-deb.mjs --dry-run --json`, which proves the `.deb` staging layout, package version, files, and `dpkg-deb` availability without writing a package.

Local package checks:

- `--run-local-checks` executes safe local package commands from the package directory instead of only listing them.
- npm package checks run with a workspace-local npm cache so Windows and restricted shells do not write to the user profile.
- Missing toolchains or blocked dependency indexes are reported as explicit skips in normal mode and as failures with `--strict-local-checks`.
- npm SDK dist verification, npm `pack --dry-run`, winget manifest validation, browser extension build dry-run, installer `-WhatIf`, and Debian dry-run checks are expected to pass on this Windows shell; Swift, Gradle, Homebrew, POSIX shell, and some Cargo paths may be skipped when the host lacks toolchains, dependency caches, or permission to execute build scripts.

SDK dist verification:

```bash
node scripts/verify-sdk-dist.mjs sdk-ts --json
node scripts/verify-sdk-dist.mjs sdk-rn --json
```

The TypeScript/browser and React Native packages publish checked-in `dist/` entrypoints. Their `npm run build` commands now verify those entrypoints directly: expected exports, declaration files, root package version alignment, and the `kolm` SDK runtime `VERSION` constant.

Browser extension package plan:

```bash
node scripts/build-browser-extension.mjs --dry-run --json
node scripts/build-browser-extension.mjs --write-source-icons --json
```

The first command validates the MV3 manifest, root-version alignment, source files, icon mappings, and package output path without writing. The second command stages a zip under `build/browser-extension/` and writes deterministic generated PNG icons into the extension source package.

Debian local package layout:

```bash
node scripts/build-deb.mjs --dry-run --json
node scripts/build-deb.mjs --out=build/deb
```

The second command stages `usr/lib/kolm`, `usr/bin/kolm`, `DEBIAN/control`, and documentation. If `dpkg-deb` is available, it also builds `build/deb/kolm_<version>_all.deb`; otherwise it leaves a staged layout and reports that package assembly needs a Debian-capable host.

Statuses:

- `publish_ready`: local contract has no structural failures and no channel placeholders.
- `package_channel_pending`: local contract is valid, but release hashes, registry uploads, or channel review remain.
- `blocked`: local manifest/docs contract is missing or invalid.

This audit never spends money, contacts package registries, uploads artifacts, or reads secret values.
