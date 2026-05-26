# Homebrew tap for kolm

Ship the kolm CLI through Homebrew on macOS (Apple Silicon + Intel) and
Linux (via Homebrew on Linux).

## Install once the tap is live

```sh
brew tap kolm-ai/kolm
brew install kolm
kolm --version
```

## What this directory contains

- `kolm.rb` &mdash; the Formula. Points at the GitHub release tarball; wraps
  `cli/kolm.js` with a `bin/kolm` shim that calls Node 20.

## Releasing a new version

1. Tag a release on `kolm-ai/kolm-stack` (`v0.2.x`).
2. Compute the tarball SHA-256:
   ```sh
   curl -fL https://github.com/kolm-ai/kolm-stack/archive/refs/tags/v0.2.6.tar.gz | shasum -a 256
   ```
3. Update `url` + `sha256` in `kolm.rb`.
4. Open a PR against `homebrew/kolm-ai/kolm` (the tap repo).

## Notes

- The Formula declares `depends_on "node@20"` because the CLI ships as Node.
  The runtime trainer (Python) is installed by `kolm doctor` after `brew install`.
- We do not bundle Python here. Mixing Brew Python and pyenv Python in one
  Formula is a quick path to support tickets.
- No bottle support yet. The Formula compiles from source on install
  (which is just unpacking a tarball &mdash; there is no native code to build).
