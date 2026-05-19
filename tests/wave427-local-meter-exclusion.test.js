// Wave 427 — Local daemon sentinel `local:<host>` must not be metered.
// Audit 2026-05-19 P1-3: shouldMeter() previously only excluded the bare
// 'local' tenant id, so the router's local-daemon stamp ('local:<hostname>')
// was leaking into the usage meters despite the privacy contract that
// local-only daemon traffic is never billed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldMeter } from '../src/usage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const usageJsPath = path.join(__dirname, '..', 'src', 'usage.js');

test('wave427 — shouldMeter("local") returns false (pre-existing)', () => {
  assert.equal(shouldMeter({ tenantId: 'local' }), false);
});

test('wave427 — shouldMeter("anon") returns false (pre-existing)', () => {
  assert.equal(shouldMeter({ tenantId: 'anon' }), false);
});

test('wave427 — shouldMeter("anon_abc") returns false (pre-existing)', () => {
  assert.equal(shouldMeter({ tenantId: 'anon_abc' }), false);
});

test('wave427 — shouldMeter("local:my-host") returns false (NEW)', () => {
  assert.equal(shouldMeter({ tenantId: 'local:my-host' }), false);
});

test('wave427 — shouldMeter("local:dev-box-123") returns false (NEW)', () => {
  assert.equal(shouldMeter({ tenantId: 'local:dev-box-123' }), false);
});

test('wave427 — shouldMeter("tenant_real_id") returns true', () => {
  assert.equal(shouldMeter({ tenantId: 'tenant_real_id' }), true);
});

test('wave427 — shouldMeter("") returns false (defensive — falsy id)', () => {
  // Empty string is falsy and the function rejects it via the `if (!tenantId)` gate.
  assert.equal(shouldMeter({ tenantId: '' }), false);
});

test('wave427 — shouldMeter(null) returns false (defensive — falsy id)', () => {
  assert.equal(shouldMeter({ tenantId: null }), false);
});

test('wave427 — shouldMeter(undefined) returns false (defensive — falsy id)', () => {
  assert.equal(shouldMeter({ tenantId: undefined }), false);
});

test('wave427 — shouldMeter() with no args returns false (defensive)', () => {
  assert.equal(shouldMeter(), false);
});

test('wave427 — localOnly:true short-circuits to false even for real tenant', () => {
  // Regression guard: the localOnly flag wins over a real tenant id.
  assert.equal(shouldMeter({ tenantId: 'tenant_real_id', localOnly: true }), false);
});

test('wave427 — static source: src/usage.js contains a `local:` prefix check', () => {
  const src = fs.readFileSync(usageJsPath, 'utf8');
  assert.ok(
    src.includes("startsWith('local:')"),
    'src/usage.js must contain a startsWith("local:") guard so local-daemon tenant ids are not metered',
  );
});
