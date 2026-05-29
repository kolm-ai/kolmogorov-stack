// W921 — the gateway dispatch must emit OpenTelemetry GenAI semantic-convention
// metrics (gen_ai.client.token.usage + gen_ai.client.operation.duration) from
// src/otel.js after each call. Additive + fire-and-forget (no-op when OTEL is
// unconfigured). Source-level lock-in (behavior needs a live dispatch + an OTEL
// exporter).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');

test('W921-OTEL #1 — dispatch imports otel and emits gen_ai token-usage + operation-duration', () => {
  assert.match(ROUTER, /await import\('\.\/otel\.js'\)/, 'dispatch must import src/otel.js');
  assert.match(ROUTER, /otel\.genAiTokenUsage\(\{[\s\S]*?inputTokens:\s*receipt\.input_tokens/,
    'dispatch must emit gen_ai token usage from the receipt token counts');
  assert.match(ROUTER, /otel\.genAiOperationDuration\(\{[\s\S]*?durationMs:\s*phases\.chain_dispatch_ms/,
    'dispatch must emit gen_ai operation duration from the upstream dispatch time');
});

test('W921-OTEL #2 — telemetry is fire-and-forget (never breaks the call)', () => {
  assert.match(ROUTER, /try \{\s*\n\s*otel\.genAiTokenUsage[\s\S]*?\}\s*catch \(_\)\s*\{[^}]*\}/,
    'the otel emit must be wrapped in try/catch so telemetry never affects the response');
});
