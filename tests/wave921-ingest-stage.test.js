// W921 — KOLM Data Engine INGEST stage lock-in.
//
// Pins the key invariants of the persistent (namespace-scoped) INGEST surface
// in src/data-ingest.js, mirroring the authoritative contract in
// scripts/data-ingest-smoke.mjs. State is isolated under a fresh temp
// KOLM_DATA_DIR set BEFORE the module is imported, so these never touch the
// developer's ~/.kolm.
//
// Locked invariants:
//   1) rawPairsPath(ns) lands under KOLM_DATA_DIR as <root>/<ns>/raw-pairs.jsonl
//   2) ingestDescribe({namespace,description,n}) writes n empty-output SEED pairs,
//      each with a complete nested provenance block (source_type:'describe')
//   3) ingestFile preserves outputs verbatim; a missing file → input_not_found
//   4) ingestCombined merges sources and dedupes by explicit id
//   5) every written pair passes validateProvenance

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate state BEFORE importing the module under test.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921-ingest-'));
process.env.KOLM_DATA_DIR = TMP_ROOT;
process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';

const {
  INGEST_VERSION,
  ingestDescribe,
  ingestFile,
  ingestCombined,
  ingestPairs,
  readRawPairs,
  rawPairsPath,
  validateProvenance,
} = await import('../src/data-ingest.js');

test('W921-INGEST.1 rawPairsPath is <KOLM_DATA_DIR>/<ns>/raw-pairs.jsonl', () => {
  assert.equal(INGEST_VERSION, 'ingest-v1');
  const p = rawPairsPath('my-ns');
  assert.equal(p, path.join(TMP_ROOT, 'my-ns', 'raw-pairs.jsonl'));
});

test('W921-INGEST.2 ingestDescribe writes n empty-output seeds with provenance', async () => {
  const ns = 'lock-describe';
  const res = await ingestDescribe({ namespace: ns, description: 'a refund support bot', n: 6 });
  assert.equal(res.ok, true);
  assert.equal(res.version, 'ingest-v1');
  assert.equal(res.n_written, 6);
  assert.equal(res.source_type, 'describe');

  const lines = readRawPairs(ns);
  assert.equal(lines.length, 6);
  assert.ok(lines.every(p => p.output === ''), 'seed prompts have empty output');
  assert.ok(lines.every(p => p.source_type === 'describe'), 'top-level source_type=describe');
  assert.ok(lines.every(p => p.provenance && p.provenance.source_type === 'describe'
    && p.provenance.ingested_at && p.provenance.source_ref), 'complete nested provenance block');
  assert.ok(lines.every(p => validateProvenance(p).ok), 'every seed passes validateProvenance');
});

test('W921-INGEST.3 ingestFile preserves outputs; missing file → input_not_found', async () => {
  const ns = 'lock-file';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921-file-'));
  const fp = path.join(dir, 'pairs.jsonl');
  fs.writeFileSync(fp, [
    JSON.stringify({ input: 'Q1', output: 'A1' }),
    JSON.stringify({ input: 'Q2', output: 'A2' }),
  ].join('\n') + '\n');

  const res = await ingestFile({ namespace: ns, file: fp });
  assert.equal(res.ok, true);
  assert.equal(res.n_written, 2);
  assert.equal(res.source_type, 'file');

  const outputs = readRawPairs(ns).map(p => p.output).sort();
  assert.deepEqual(outputs, ['A1', 'A2'], 'outputs preserved verbatim');

  const missing = await ingestFile({ namespace: 'lock-file-missing', file: path.join(dir, 'nope.jsonl') });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'input_not_found');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('W921-INGEST.4 ingestCombined merges sources and dedupes by explicit id', async () => {
  const ns = 'lock-combined';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921-combined-'));
  const fileA = path.join(dir, 'a.jsonl');
  fs.writeFileSync(fileA, [
    JSON.stringify({ input: 'Cq one', output: 'Ca one' }),
    JSON.stringify({ input: 'Cq two', output: 'Ca two' }),
  ].join('\n') + '\n');

  const res = await ingestCombined({
    namespace: ns,
    sources: [
      { kind: 'file', file: fileA },
      { kind: 'pairs', pairs: [
        { id: 'dup_x', input: 'Cq three', output: 'Ca three' },
        { id: 'dup_x', input: 'Cq four', output: 'Ca four' }, // same id → dropped
      ] },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.source_type, 'combined');
  assert.equal(res.contributions.length, 2);

  const fileContrib = res.contributions.find(c => c.kind === 'file');
  const pairsContrib = res.contributions.find(c => c.kind === 'pairs');
  assert.equal(fileContrib.n_written, 2);
  assert.equal(pairsContrib.n_written, 1, 'duplicate id dropped → only 1 pairs row written');
  assert.equal(pairsContrib.dupes_skipped, 1);

  const lines = readRawPairs(ns);
  assert.equal(lines.length, 3, 'total = sum of contributions');
  assert.equal(res.n_written, lines.length);
  const types = new Set(lines.map(p => p.source_type));
  assert.ok(types.has('file') && types.has('pairs'), 'per-pair source_type preserved');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('W921-INGEST.5 ingestPairs is a standalone in-memory source', async () => {
  const ns = 'lock-pairs';
  const res = await ingestPairs({ namespace: ns, pairs: [{ input: 'P1', output: 'O1' }] });
  assert.equal(res.ok, true);
  assert.equal(res.n_written, 1);
  assert.equal(res.source_type, 'pairs');
  assert.ok(readRawPairs(ns).every(p => validateProvenance(p).ok));
});

test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});
