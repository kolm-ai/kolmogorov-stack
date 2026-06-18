#!/usr/bin/env bash
# kolm-runtime build script (Linux / macOS).
#
# Builds the crate in release mode for the host triple, runs every test,
# and then cross-compiles a WASM module for browser-side verification.
#
# Required toolchain:
#   - Rust 1.75 or later (stable channel)
#   - wasm32-unknown-unknown target installed:
#       rustup target add wasm32-unknown-unknown
#
# Optional:
#   - wasm-bindgen-cli (for generating the JS glue):
#       cargo install wasm-bindgen-cli
#
# Usage:
#   ./build.sh            # build + test + wasm
#   ./build.sh --skip-wasm
#   ./build.sh --skip-tests
#   ./build.sh --no-install  # fail if wasm target is missing

set -euo pipefail

cd "$(dirname "$0")"

BUILD_CONTRACT_VERSION="w927-runtime-rs-build-scripts-v1"
SKIP_WASM=0
SKIP_TESTS=0
NO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-wasm) SKIP_WASM=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --no-install) NO_INSTALL=1 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 not found on PATH" >&2
    exit 127
  fi
}

echo "kolm-runtime build contract: $BUILD_CONTRACT_VERSION"
require_cmd cargo
if [ "$SKIP_WASM" -eq 0 ]; then
  require_cmd rustup
fi

echo "[1/4] cargo build --release"
cargo build --release

if [ "$SKIP_TESTS" -eq 0 ]; then
  echo "[2/4] cargo test --release"
  cargo test --release
else
  echo "[2/4] (skipping tests)"
fi

echo "[3/4] cargo build --release --bin kolm-verify"
cargo build --release --bin kolm-verify

if [ "$SKIP_WASM" -eq 0 ]; then
  echo "[4/4] cargo build --release --target wasm32-unknown-unknown --features wasm"
  if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
    if [ "$NO_INSTALL" -eq 1 ] || [ "${KOLM_RUNTIME_NO_RUSTUP:-0}" = "1" ]; then
      echo "wasm32-unknown-unknown target missing; run rustup target add wasm32-unknown-unknown" >&2
      exit 3
    fi
    echo "  installing wasm32-unknown-unknown target..."
    rustup target add wasm32-unknown-unknown
  fi
  cargo build --release --target wasm32-unknown-unknown --features wasm
else
  echo "[4/4] (skipping wasm)"
fi

echo "done."
echo "  native lib:  target/release/libkolm_runtime.{rlib,a,so,dylib}"
echo "  cli binary:  target/release/kolm-verify"
if [ "$SKIP_WASM" -eq 0 ]; then
  echo "  wasm:        target/wasm32-unknown-unknown/release/kolm_runtime.wasm"
fi
