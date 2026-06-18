// W927 - direct contract test for packages/runtime-rs/build.ps1 and build.sh.
//
// This pins the cross-platform Rust runtime build launchers: no-install CI
// mode, explicit tool checks, deterministic cargo command order, and direct
// depth verification for both script atoms.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const PS_REL = 'packages/runtime-rs/build.ps1';
const SH_REL = 'packages/runtime-rs/build.sh';
const CONTRACT_VERSION = 'w927-runtime-rs-build-scripts-v1';

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function tryRun(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 15000,
  });
  return result;
}

test('W927 runtime-rs build scripts are wired into direct depth verification', () => {
  const pkg = readJson('package.json');
  const ps = read(PS_REL);
  const sh = read(SH_REL);

  assert.equal(
    pkg.scripts['verify:runtime-rs-build-scripts'],
    'node --test --test-concurrency=1 tests/wave927-runtime-rs-build-scripts-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:llamaindex-package-manifest && npm run verify:runtime-rs-build-scripts && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.match(ps, new RegExp(CONTRACT_VERSION));
  assert.match(sh, new RegExp(CONTRACT_VERSION));
  assert.equal(PS_REL, 'packages/runtime-rs/build.ps1');
  assert.equal(SH_REL, 'packages/runtime-rs/build.sh');
});

test('W927 build scripts keep the native/test/cli/wasm command sequence explicit', () => {
  const ps = read(PS_REL);
  const sh = read(SH_REL);

  for (const source of [ps, sh]) {
    assert.match(source, /cargo build --release/);
    assert.match(source, /cargo test --release/);
    assert.match(source, /cargo build --release --bin kolm-verify/);
    assert.match(source, /cargo build --release --target wasm32-unknown-unknown --features wasm/);
    assert.match(source, /wasm32-unknown-unknown/);
    assert.doesNotMatch(source, /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i);
    assert.doesNotMatch(source, /\b(eval|Start-Process)\b|rm\s+-rf|Remove-Item/i);
  }
});

test('W927 build scripts require tools and support hermetic no-install mode', () => {
  const ps = read(PS_REL);
  const sh = read(SH_REL);

  assert.match(ps, /function Require-Command/);
  assert.match(ps, /Require-Command "cargo"/);
  assert.match(ps, /Require-Command "rustup"/);
  assert.match(ps, /\[switch\]\$NoInstall/);
  assert.match(ps, /\$env:KOLM_RUNTIME_NO_RUSTUP -eq "1"/);
  assert.match(ps, /exit 3/);

  assert.match(sh, /require_cmd\(\)/);
  assert.match(sh, /require_cmd cargo/);
  assert.match(sh, /require_cmd rustup/);
  assert.match(sh, /--no-install\) NO_INSTALL=1/);
  assert.match(sh, /\$\{KOLM_RUNTIME_NO_RUSTUP:-0\}/);
  assert.match(sh, /exit 3/);
});

test('W927 build scripts parse on available local shells', () => {
  const bash = tryRun('bash', ['-n', SH_REL]);
  if (bash.error?.code !== 'ENOENT') {
    assert.equal(bash.status, 0, bash.stderr || bash.stdout);
  }

  const psCommand = `$src = Get-Content -Raw '${PS_REL}'; [void][scriptblock]::Create($src)`;
  let parsed = tryRun('pwsh', ['-NoProfile', '-Command', psCommand]);
  if (parsed.error?.code === 'ENOENT') {
    parsed = tryRun('powershell', ['-NoProfile', '-Command', psCommand]);
  }
  if (parsed.error?.code !== 'ENOENT') {
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
  }
});
