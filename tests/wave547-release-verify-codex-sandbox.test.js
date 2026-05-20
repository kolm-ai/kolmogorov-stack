// Wave 547 - release verifier must stay strict outside Codex while allowing
// local verification to complete when the Codex harness explicitly disables
// child-process network access.
//
// Why this lock-in: in Codex, top-level CLI probes can reach kolm.ai through
// the tool boundary, but child processes launched from release-verify inherit
// CODEX_SANDBOX_NETWORK_DISABLED=1 and fail outbound HTTPS with EACCES. That
// should be reported as an explicit sandbox skip, not confused with a product
// auth failure. In CI or a normal shell, transport failures remain hard fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const DRIVER = path.join(REPO, 'scripts', 'release-verify.cjs');
const SRC = fs.readFileSync(DRIVER, 'utf8');

test('W547 #1 - release-verify detects Codex child-process network sandbox explicitly', () => {
  assert.match(SRC, /function\s+codexSandboxNetworkDisabled\(\)\s*\{\s*return\s+process\.env\.CODEX_SANDBOX_NETWORK_DISABLED\s*===\s*['"]1['"]/,
    'release-verify must look for CODEX_SANDBOX_NETWORK_DISABLED=1');
});

test('W547 #2 - whoami sandbox skip only applies to transport_error envelopes', () => {
  assert.match(SRC, /if\s*\(\s*parsed\.error_type\s*===\s*['"]transport_error['"]\s*\)\s*\{\s*if\s*\(\s*codexSandboxNetworkDisabled\(\)\s*\)/s,
    'the Codex skip must be inside the parsed.error_type === transport_error branch');
});

test('W547 #3 - sandbox skip detail is explicit and non-Codex transport stays fatal', () => {
  assert.match(SRC, /skipped live whoami: Codex sandbox disables child-process network/,
    'the release summary must say this was a harness skip');
  assert.match(SRC, /return\s+\{\s*ok:\s*false,\s*reason:\s*`cloud transport error/,
    'transport errors outside the Codex network sandbox must remain release failures');
});
