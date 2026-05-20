#!/usr/bin/env bash
# W480 - one-shot Linux build verifier for the C and Rust SDKs.
#
# Runs inside an Ubuntu container so the build is independent of whatever the
# host has installed. Mirrors .github/workflows/sdk-c-rust.yml exactly.
#
# Usage:
#   docker run --rm -v "$PWD":/work -w /work ubuntu:24.04 bash scripts/sdk-linux-build.sh
set -euo pipefail

echo "== sdk linux build =="
echo "[1/9] apt update + install libcurl + libssl + build-essential + curl"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl build-essential pkg-config \
  libcurl4-openssl-dev libssl-dev >/dev/null

echo "[2/9] install rustup + stable rust"
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
source "$HOME/.cargo/env"
rustc --version
cargo --version

echo "[3/9] build C SDK (make)"
cd /work/sdk/c
make clean >/dev/null 2>&1 || true
make

echo "[4/9] C SDK: no-arg usage exits 64"
set +e
./kolm-cli
rc=$?
set -e
if [ "$rc" != "64" ]; then
  echo "FAIL: kolm-cli with no args exited $rc, expected 64" >&2
  exit 1
fi
echo "ok: usage exits 64"

echo "[5/9] C SDK: bogus host returns non-zero (network error path)"
set +e
KOLM_BASE_URL="http://127.0.0.1:1" KOLM_API_KEY=kolm-demo ./kolm-cli health >/dev/null 2>&1
rc=$?
set -e
if [ "$rc" = "0" ]; then
  echo "FAIL: bogus host should have failed" >&2
  exit 1
fi
echo "ok: bogus host exits $rc"

echo "[6/9] rust SDK: cargo check --all-targets"
cd /work/sdk/rust
cargo check --all-targets

echo "[7/9] rust SDK: cargo test"
cargo test

echo "[8/9] rust SDK: cargo build --release --example whoami"
cargo build --release --example whoami

echo "[9/9] rust SDK: --release whoami smoke (bogus host => non-zero)"
set +e
KOLM_BASE_URL="http://127.0.0.1:1" KOLM_API_KEY=kolm-demo target/release/examples/whoami
rc=$?
set -e
if [ "$rc" = "0" ]; then
  echo "FAIL: rust whoami against bogus host should have failed" >&2
  exit 1
fi
echo "ok: rust whoami fails closed on bogus host (rc=$rc)"

echo
echo "== sdk linux build GREEN =="
