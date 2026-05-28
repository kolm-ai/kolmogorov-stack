// W921 P0 — fallback_reason must be clamped to the schema enum at the receipt
// boundary, so an unexpected logging value can NEVER throw inside validateReceipt
// and abort a live gateway call (fail-open). Unknown reasons collapse to null;
// the dispatch handler's attempted[] array still carries the raw detail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'gateway-receipt.js'), 'utf8');

test('W921-P0 #1 — gateway-receipt clamps fallback_reason to the FALLBACK_REASONS enum', () => {
  assert.match(SRC, /FALLBACK_REASONS/, 'gateway-receipt.js must import FALLBACK_REASONS from the schema');
  assert.match(SRC, /r\.fallback_reason\s*=\s*FALLBACK_REASONS\.includes\(_fr\)\s*\?\s*_fr\s*:\s*null/,
    'fallback_reason must be clamped to enum-or-null (never an arbitrary string that fails validateReceipt)');
});

test('W921-P0 #2 — buildAndSignReceipt does not throw on an out-of-enum fallback_reason', async () => {
  const { buildAndSignReceipt } = await import('../src/gateway-receipt.js');
  const base = {
    namespace_id: 'wave921-clamp', route_decision: 'frontier', provider: 'openai',
    model: 'gpt-4o-mini', input_text: 'hello', output_text: 'world',
    input_tokens: 1, output_tokens: 1, cost_usd: 0,
  };
  let r;
  assert.doesNotThrow(() => { r = buildAndSignReceipt({ ...base, fallback_reason: 'transport_error_NOT_IN_ENUM' }); },
    'an out-of-enum fallback_reason must not throw');
  assert.equal(r.receipt.fallback_reason, null, 'unknown fallback_reason clamps to null');
  const r2 = buildAndSignReceipt({ ...base, fallback_reason: 'upstream_429' });
  assert.equal(r2.receipt.fallback_reason, 'upstream_429', 'a valid fallback_reason is preserved');
});
