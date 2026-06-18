# kolm-runtime build script (Windows / PowerShell).
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
#   .\build.ps1            # build + test + wasm
#   .\build.ps1 -SkipWasm
#   .\build.ps1 -SkipTests
#   .\build.ps1 -NoInstall  # fail if wasm target is missing

[CmdletBinding()]
param(
    [switch]$SkipWasm,
    [switch]$SkipTests,
    [switch]$NoInstall
)

$ErrorActionPreference = "Stop"
$BuildContractVersion = "w927-runtime-rs-build-scripts-v1"

function Require-Command($Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Error "$Name not found on PATH"
        exit 127
    }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Write-Host "kolm-runtime build contract: $BuildContractVersion"
Require-Command "cargo"
if (-not $SkipWasm) {
    Require-Command "rustup"
}

Write-Host "[1/4] cargo build --release"
cargo build --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipTests) {
    Write-Host "[2/4] cargo test --release"
    cargo test --release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Write-Host "[2/4] (skipping tests)"
}

Write-Host "[3/4] cargo build --release --bin kolm-verify"
cargo build --release --bin kolm-verify
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipWasm) {
    Write-Host "[4/4] cargo build --release --target wasm32-unknown-unknown --features wasm"
    $installed = (rustup target list --installed) -join "`n"
    if ($installed -notmatch "wasm32-unknown-unknown") {
        if ($NoInstall -or $env:KOLM_RUNTIME_NO_RUSTUP -eq "1") {
            Write-Error "wasm32-unknown-unknown target missing; run rustup target add wasm32-unknown-unknown"
            exit 3
        }
        Write-Host "  installing wasm32-unknown-unknown target..."
        rustup target add wasm32-unknown-unknown
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    cargo build --release --target wasm32-unknown-unknown --features wasm
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Write-Host "[4/4] (skipping wasm)"
}

Write-Host "done."
Write-Host "  native lib:  target\release\kolm_runtime.{rlib,lib,dll}"
Write-Host "  cli binary:  target\release\kolm-verify.exe"
if (-not $SkipWasm) {
    Write-Host "  wasm:        target\wasm32-unknown-unknown\release\kolm_runtime.wasm"
}
