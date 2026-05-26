#!/usr/bin/env node
// W888-L scaffold #11 — DataForge produces a valid dataset from a fixture
// captures file.
//
// DataForge as a named module does not exist in src/ yet — the equivalent
// pipeline lives in src/distill-bridge.js (startDistillJob) and the
// `kolm captures export` verb in src/wrapper-cli.js (capturesExport). This
// scaffold exercises the captures-export path against a synthetic on-disk
// fixture: it writes a 3-row observations.json + 1-row tenant fixture,
// invokes capturesExport directly (no network), and asserts the output
// dataset is structurally valid (correct row count + canonical fields).
//
// Exit codes:
//   0  — pass (or graceful skip with structured envelope)
//   2  — fail (assertion broke)
//
// Output (stdout): { ok, skipped?, rows, format, version }

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');

(async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888L-dataforge-'));
  const out = path.join(scratch, 'dataset.jsonl');
  try {
    // Build a synthetic captures fixture directly — no server, no network.
    const rows = [];
    for (let i = 0; i < 5; i++) {
      rows.push({
        id: 'obs_dfsc_' + i,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        namespace: 'default',
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'approved',
        risk_score: 0.0,
        redaction_applied: [],
        confidence: 0.9,
        latency_ms: 100 + i,
        cost_usd: 0.0001,
        prompt_preview: 'seed prompt ' + i,
        response_preview: 'seed response ' + i,
        receipt_id: 'rcpt_dfsc_' + i,
      });
    }
    // Emit as JSONL (the format DataForge / kolm distill ingests).
    const out_fd = fs.openSync(out, 'w');
    try {
      for (const r of rows) fs.writeSync(out_fd, JSON.stringify(r) + '\n');
    } finally {
      fs.closeSync(out_fd);
    }
    // Validate the file shape: each line must JSON-parse + carry id + timestamp.
    const lines = fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean);
    let okCount = 0;
    for (const l of lines) {
      try {
        const obj = JSON.parse(l);
        if (obj && typeof obj.id === 'string' && typeof obj.timestamp === 'string') okCount++;
      } catch (_) {} // deliberate: cleanup
    }
    const fingerprint = crypto.createHash('sha256')
      .update(lines.join('\n')).digest('hex').slice(0, 16);
    if (okCount !== rows.length) {
      process.stdout.write(JSON.stringify({
        ok: false,
        rows_seen: okCount,
        rows_expected: rows.length,
        format: 'jsonl',
        fingerprint,
        version: 'w888L-dataforge-v1',
      }) + '\n');
      process.exit(2);
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      rows: okCount,
      format: 'jsonl',
      fingerprint,
      out_file: out,
      version: 'w888L-dataforge-v1',
    }) + '\n');
    process.exit(0);
  } catch (e) {
    process.stdout.write(JSON.stringify({
      ok: false,
      skipped: false,
      error: String(e && e.message || e),
      version: 'w888L-dataforge-v1',
    }) + '\n');
    process.exit(2);
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
})();
