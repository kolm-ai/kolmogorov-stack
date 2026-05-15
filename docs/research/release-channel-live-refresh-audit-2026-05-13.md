# Release Channel Live Refresh Audit

Date: 2026-05-13

Scope: live `kolm.ai` docs and integrations positioning, npm/PyPI/Docker/package-manager registry state, root source package dry-run, GitHub Action contract, local SDK package metadata, and release workflow evidence.

## Executive Summary

The release-channel story is still a launch blocker. The public repo is reachable and the root CLI help works locally, but the public install and integration surface is not release-backed.

The live `/docs` page is materially behind the current Kolm surface. It still presents the older hosted API, old package names, old MCP install surface, and old brand footer. Local `public/docs.html` has moved toward the Kolm CLI, but still includes a missing public npm CLI package and a missing Homebrew tap command. Local `public/integrations.html` labels GitHub Actions, Node, Python, npm, Homebrew, Windows package managers, and Docker as shipped even when the evidence is source-only, preview-only, or absent from public package channels.

Registry checks on 2026-05-13 confirmed:

- `npm view` for the public CLI package returned 404.
- `npm view` for the root package returned 404.
- `npm view` for the Node SDK package returned 404.
- PyPI `kolm` is occupied by an unrelated 2017 Korean language-model toolkit.
- The public GitHub repo URL returns 200.
- The implied Homebrew tap, Scoop manifest, winget manifest path, and Docker Hub repository checks return 404.

The root source package has become riskier since the prior audit. A fresh escalated `npm pack --dry-run --json` reported 699 entries, 243,697,965 bytes packed, and 263,769,399 bytes unpacked. It includes 272 `tmp/` entries, 62 `docs/research/` entries, 163 `public/` entries, and 8 test entries. It includes no package lock and no root license file. That makes the current GitHub-source install a broad worktree snapshot, not a curated release artifact.

The GitHub composite action still does not match the root CLI. It calls `whoami`, `verify`, and `compile --json`; local CLI probes show `whoami` and `verify` are unknown commands, and `compile --help` does not document JSON output. A user copying the action can fail after install even if the GitHub-source package resolves.

The near-term safe claim is narrow:

> Preview users can install the root CLI from the public GitHub source. Published npm packages, Homebrew tap, winget/Scoop manifest, Docker image, PyPI package, VS Code marketplace listing, release signatures, SLSA provenance, SBOMs, and the GitHub composite action are not release-backed until channel checks and smoke tests pass.

## What Is Solid

- The public GitHub repo URL returned 200.
- Root `package.json` defines `bin.kolm` and local CLI help executes.
- The repo has source trees for Node, Python, VS Code, Homebrew, winget, Docker, and GitHub Actions.
- The Homebrew and winget stubs self-identify as preview and pending a tagged release.

## Highest-Risk Gaps

### Live Docs Are Older Than The Current Product

The live docs still describe the older hosted API and old package ecosystem. This is more severe than a normal docs typo because the live page teaches users to install packages and call hosts that do not match the current local CLI/product direction.

Recommended action: deploy current docs only after package labels are generated from evidence, or add a live banner that marks the page as legacy.

### Public Npm CLI Is Missing

Local docs still show the public CLI package tab first, while `npm view` returns 404. This is the fastest first-run failure path.

Recommended action: either publish and smoke the package or make GitHub-source preview the only install command until publication.

### Source Install Is Not Curated

The current root dry-run includes `tmp/` screenshots, research docs, public site assets, tests, and no root lock/license file. The package is now about 244 MB packed.

Recommended action: add a root `files` allowlist or `.npmignore`, exclude `tmp/`, `docs/research/`, tests, and public bulk from CLI installs, then snapshot dry-run contents in CI.

### GitHub Action Is Out Of Contract

The composite action calls root CLI commands and output modes that are not available. A shipped label is unsafe until the action is smoke-tested against the current CLI.

Recommended action: either implement the missing commands/output mode or rewrite the action around current commands and fixtures.

### PyPI Name Collision Blocks Clean Python Launch

The intended Python project name is already occupied by an unrelated project. The local script entry is also named for the older Recipe surface rather than `kolm`.

Recommended action: pick a publishable Python package name, update scripts/imports/docs, and add command-contract tests.

### Package-Manager Labels Are Source-Only

Homebrew, Windows package managers, and Docker are currently ways to install prerequisites or run a source install, not public channel artifacts. Calling them shipped hides the absence of a tap, manifest, image, and release workflow.

Recommended action: mark them source-install recipes or preview until channel artifacts exist and are verified.

## Release Gate Needed

Before any page can label a release surface as shipped, the repo needs a machine-readable release evidence manifest with at least:

- public repo URL check,
- npm package availability and version match,
- package dry-run allowlist check,
- GitHub Action smoke test,
- Python package name ownership and wrapper contract test,
- Homebrew formula audit with real SHA,
- winget/Scoop manifest validation,
- Docker image existence and digest,
- VS Code extension package smoke or marketplace status,
- release workflow evidence for provenance, signatures, checksums, and SBOM.

Docs should render badges from that manifest rather than hand-written labels.

## Validation Performed

- Opened live `https://kolm.ai/docs` and confirmed the old package/API surface remains live.
- Opened `https://pypi.org/project/kolm/` and confirmed unrelated package ownership, latest version 1.1.4, and 2017 release date.
- `npm view` checks for the public CLI package, root package, and Node SDK package returned 404.
- Public GitHub repo availability check returned 200.
- Homebrew tap, Scoop manifest, winget manifest path, and Docker Hub repository checks returned 404.
- Local CLI probes confirmed `whoami` and `verify` are unknown commands.
- `kolm compile --help` does not document `--json`.
- `npm pack --dry-run --json` required escalation after sandbox/cache EPERM and then reported 699 entries, 243,697,965 bytes packed, 263,769,399 bytes unpacked, 272 `tmp/` entries, and no lock/license file.
- Root `cmd /c npm test` in the preceding sandbox slice passed 53 of 54 tests, with only the pre-existing auth readiness test failing.
