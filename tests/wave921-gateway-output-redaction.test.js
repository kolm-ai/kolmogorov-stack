// W921 P0 (C1) — the /v1/gateway/dispatch handler must substitute the redacted
// output into the CLIENT response (JSON + SSE) when the namespace redact_mode
// is redact_all (outputScan.action === 'redact'). Before this fix the handler
// computed outputScan but returned the raw upstream output to the caller, so
// redact_all callers received un-redacted PII/PHI while the signed receipt
// claimed redaction_applied — a fail-open leak. This is a source-level lock-in
// (the behavior lives deep in a server boot + upstream mock); it guards the
// substitution wiring from being removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');

test('W921-C1 #1 — dispatch computes a redacted client output gated on outputScan.action', () => {
  assert.match(ROUTER, /const\s+_redactOut\s*=\s*outputScan\.action\s*===\s*'redact'/,
    'dispatch must gate client-output redaction on outputScan.action === "redact"');
  assert.match(ROUTER, /const\s+clientOutputText\s*=\s*_redactOut\s*\?\s*String\(outputScan\.output_text/,
    'dispatch must derive clientOutputText from outputScan.output_text when redacting');
});

test('W921-C1 #2 — the SSE stream uses the redacted clientOutputText, not raw outputText', () => {
  assert.match(ROUTER, /const\s+text\s*=\s*String\(clientOutputText\s*\|\|\s*''\)/,
    'the SSE assembled text must come from clientOutputText (redacted), not the raw outputText');
});

test('W921-C1 #3 — the JSON response spreads the redacted clientJson, not raw result.json', () => {
  // The dispatch JSON response object spreads clientJson (redacted copy) before kolm_receipt.
  assert.match(ROUTER, /\.\.\.clientJson,\s*\n\s*kolm_receipt:\s*receipt/,
    'the dispatch JSON response must spread clientJson (redacted) immediately before kolm_receipt');
  // And clientJson rewrites both OpenAI (choices[].message.content) and Anthropic (content[].text) shapes.
  assert.match(ROUTER, /clientJson\.choices\s*=\s*clientJson\.choices\.map/,
    'clientJson must rewrite the OpenAI choices[0].message.content shape');
  assert.match(ROUTER, /clientJson\.content\s*=\s*clientJson\.content\.map/,
    'clientJson must rewrite the Anthropic content[].text shape');
});
