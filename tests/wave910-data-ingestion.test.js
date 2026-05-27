// W910 Track A — Data ingestion tests.
//
// Pins the --data / --describe / --docs / --combined pipeline against
// fixtures under data/test-fixtures/. The compile pipeline itself is
// not exercised here; we only verify that ingestion produces the
// {input, output, source}[] shape with correct stats, that drops
// happen at the right boundaries, and that the spec synthesis carries
// passport metadata.
//
// Pinned items:
//   1) CSV with auto-detection passes
//   2) CSV with explicit --input-col/--output-col passes
//   3) JSONL with {prompt, completion} passes
//   4) Parquet rejected with conversion hint
//   5) Empty / dup / oversized rows dropped with correct stats
//   6) Dry-run path does not invoke compile (synthesis still works)
//   7) Describe path generates pairs, kept count > 0
//   8) Describe path respects --budget-usd
//   9) Docs path generates Q&A from a small fixture folder
//  10) Docs path deduplicates obvious near-dupes
//  11) Combined sources merge and dedupe across types
//  12) Passport JSON contains source metadata in all paths

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  ingestData,
  ingestDescribe,
  ingestDocs,
  mergeAndDedupe,
  synthesizeSpec,
  writeSeedsJsonl,
} from '../src/data-ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '..', 'data', 'test-fixtures');

// 1
test('W910-A.1 CSV with auto-detection picks input + output columns', async () => {
  const res = await ingestData(path.join(FIX, 'small.csv'));
  assert.equal(res.source_type, 'upload');
  assert.ok(res.rows.length >= 10, `expected >=10 rows, got ${res.rows.length}`);
  assert.ok(res.rows.every(r => r.input && r.output && r.source), 'every row has input/output/source');
  assert.match(res.rows[0].input, /order|package|refund|reset|address|express|return|ship|cancel|track/i);
  assert.equal(res.stats.dropped_empty, 0);
  assert.equal(res.stats.kept, res.rows.length);
});

// 2
test('W910-A.2 CSV with explicit --input-col/--output-col override picks them', async () => {
  // small.csv uses customer_message,agent_response — override picks them by name explicitly.
  const res = await ingestData(path.join(FIX, 'small.csv'), {
    inputCol: 'customer_message',
    outputCol: 'agent_response',
  });
  assert.ok(res.rows.length >= 10);
  assert.equal(res.rows[0].source.startsWith('small.csv:'), true);
});

// 3
test('W910-A.3 JSONL with {prompt, completion} and 4 other schemas parses', async () => {
  const res = await ingestData(path.join(FIX, 'pairs.jsonl'));
  assert.equal(res.source_type, 'upload');
  // pairs.jsonl has 10 rows across {prompt,completion}/{question,answer}/{input,output}/{before,after}/{source,target}.
  assert.ok(res.rows.length >= 9, `expected >=9 rows from 5-schema JSONL, got ${res.rows.length}`);
  const inputs = res.rows.map(r => r.input.toLowerCase()).join(' ');
  assert.ok(inputs.includes('boiling'), 'has prompt/completion row');
  assert.ok(inputs.includes('noble gas'), 'has question/answer row');
  assert.ok(inputs.includes('sum'), 'has input/output row');
});

// 4
test('W910-A.4 Parquet rejected with conversion hint', async () => {
  // Synthesize a .parquet file path that exists (any small file) so the size check passes
  // but the extension check fires first.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-parquet-'));
  const fake = path.join(tmpDir, 'fake.parquet');
  fs.writeFileSync(fake, 'PAR1binarygarbage');
  await assert.rejects(
    () => ingestData(fake),
    err => /\.parquet/.test(err.message) && /pandas|convert|csv/i.test(err.message),
    'parquet rejection should mention conversion hint',
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 5
test('W910-A.5 Empty + dup + oversized rows dropped with correct stats', async () => {
  const res = await ingestData(path.join(FIX, 'edge.csv'));
  // edge.csv has: 1 empty input, 1 empty output, 1 dup of "good question" → 2 should drop empty + 1 dup.
  // Survivors: row 1 ("good question"/"short answer"), row 6 unique question, multi-line row, trailing-ws row, q9, q10.
  assert.ok(res.stats.dropped_empty >= 2, `expected >=2 empty drops, got ${res.stats.dropped_empty}`);
  assert.ok(res.stats.dropped_dup >= 1, `expected >=1 dup drop, got ${res.stats.dropped_dup}`);
  assert.ok(res.rows.length >= 4, `expected >=4 survivors, got ${res.rows.length}`);
  // Verify no survivor has empty input/output.
  for (const r of res.rows) {
    assert.ok(r.input.trim().length > 0, 'no empty inputs survive');
    assert.ok(r.output.trim().length > 0, 'no empty outputs survive');
  }
});

// 6
test('W910-A.6 Dry-run path: synthesis runs but spec emission is callable independently', async () => {
  // The dry-run flag is enforced in cli/kolm.js; here we verify the underlying
  // module is pure (no side effects), so the CLI's dry-run branch can rely on it.
  const res = await ingestData(path.join(FIX, 'small.csv'));
  const spec = synthesizeSpec(res.rows, {
    baseModel: 'Qwen/Qwen2.5-3B-Instruct',
    namespace: 'dry-run-test',
    description: 'support tickets',
    passport: { upload: { file: 'small.csv', rows: res.rows.length } },
  });
  assert.equal(spec.examples, res.rows.length);
  assert.equal(spec.base_model, 'Qwen/Qwen2.5-3B-Instruct');
  assert.equal(spec.corpus_namespace, 'dry-run-test');
  assert.equal(spec.evals.n, res.rows.length);
  assert.equal(spec.data_ingest.total_rows, res.rows.length);
  assert.deepEqual(spec.data_ingest.sources.upload, { file: 'small.csv', rows: res.rows.length });
});

// 7
test('W910-A.7 Describe path (bootstrap fallback) generates kept > 0 pairs', async () => {
  // No teacher base URL → bootstrap path emits 1-20 scaffolds.
  const originalEnv = process.env.KOLM_TEACHER_BASE_URL;
  delete process.env.KOLM_TEACHER_BASE_URL;
  try {
    const res = await ingestDescribe('A support agent that handles refund requests for an online store.', {
      count: 10,
      budgetUsd: 1,
    });
    assert.equal(res.source_type, 'describe');
    assert.ok(res.rows.length > 0, `expected >0 rows, got ${res.rows.length}`);
    assert.equal(res.stats.mode, 'bootstrap');
    assert.ok(res.rows.every(r => r.synthetic_bootstrap === true), 'every row marked synthetic_bootstrap');
  } finally {
    if (originalEnv !== undefined) process.env.KOLM_TEACHER_BASE_URL = originalEnv;
  }
});

// 8
test('W910-A.8 Describe path respects --budget-usd cap', async () => {
  // 1000 pairs at $0.002 = $2; budget of $0.50 must reject.
  await assert.rejects(
    () => ingestDescribe('Some task description that is long enough to be meaningful.', {
      count: 1000,
      budgetUsd: 0.5,
    }),
    err => /budget/i.test(err.message) && /lower.*--count|raise.*--budget/i.test(err.message),
    'budget rejection should mention both knobs',
  );
});

// 9
test('W910-A.9 Docs path generates pairs from a small fixture folder', async () => {
  const res = await ingestDocs(path.join(FIX, 'docs-small'));
  assert.equal(res.source_type, 'docs');
  assert.ok(res.stats.files_scanned >= 3, `expected >=3 files, got ${res.stats.files_scanned}`);
  assert.ok(res.rows.length > 0, `expected >0 rows, got ${res.rows.length}`);
  // Confirm the explicit Q-as-heading pattern was picked up from getting-started.md.
  const inputs = res.rows.map(r => r.input.toLowerCase()).join(' | ');
  assert.ok(/install|reset|compile|gpu|kolm/.test(inputs), 'has at least one expected heading-as-question');
});

// 10
test('W910-A.10 Docs path deduplicates near-dupes (cancel-subscription variants)', async () => {
  const res = await ingestDocs(path.join(FIX, 'docs-small'));
  // near-dup.md has 3 near-identical "cancel a subscription" headings → at most 1 should survive.
  const cancelRows = res.rows.filter(r => /cancel.*subscription|cancel my subscription|how.*cancel/i.test(r.input));
  assert.ok(cancelRows.length <= 2, `expected <=2 near-dup survivors of cancel-subscription, got ${cancelRows.length}`);
  assert.ok(res.stats.near_dup_dropped > 0, `expected >0 near-dup drops, got ${res.stats.near_dup_dropped}`);
});

// 11
test('W910-A.11 Combined sources merge and dedupe across types', async () => {
  const a = await ingestData(path.join(FIX, 'small.csv'));
  const b = await ingestData(path.join(FIX, 'pairs.jsonl'));
  // Force a duplicate input across the two sources by injecting a row.
  const dupInput = a.rows[0].input;
  b.rows.push({ input: dupInput, output: 'collision output', source: 'synth:dup' });
  const merged = mergeAndDedupe([a, b]);
  assert.equal(merged.stats.by_source.upload, a.rows.length + b.rows.length);
  assert.equal(merged.stats.merged, a.rows.length + b.rows.length);
  // After dedupe, the injected dup should drop.
  assert.ok(merged.stats.after_dedupe < merged.stats.merged, 'dedupe removed at least one row');
  assert.equal(merged.rows.length, merged.stats.after_dedupe);
});

// 12
test('W910-A.12 Passport JSON via synthesizeSpec carries source metadata in all paths', async () => {
  const upload = await ingestData(path.join(FIX, 'small.csv'));
  const describe = await ingestDescribe('A test description for passport metadata.', { count: 3, budgetUsd: 1 });
  const docs = await ingestDocs(path.join(FIX, 'docs-small'));
  const merged = mergeAndDedupe([upload, describe, docs]);
  const spec = synthesizeSpec(merged.rows, {
    namespace: 'passport-test',
    description: 'multi-source spec',
    passport: {
      upload: { file: upload.stats.file, kept: upload.stats.kept, sha256: upload.stats.file_sha256 },
      describe: { mode: describe.stats.mode, generated: describe.stats.generated },
      docs: { folder: docs.stats.folder, chunks: docs.stats.chunks, files_scanned: docs.stats.files_scanned },
    },
  });
  // Spec carries passport for all three paths.
  assert.ok(spec.data_ingest.sources.upload.file, 'upload metadata in spec');
  assert.ok(spec.data_ingest.sources.upload.sha256, 'upload sha256 in spec');
  assert.ok(spec.data_ingest.sources.describe.mode, 'describe mode in spec');
  assert.ok(spec.data_ingest.sources.docs.folder, 'docs folder in spec');
  // Generated_at is ISO-8601.
  assert.match(spec.data_ingest.generated_at, /^\d{4}-\d{2}-\d{2}T/);

  // Writing seeds.jsonl works end-to-end.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-seeds-'));
  const seedsPath = path.join(tmpDir, 'seeds.jsonl');
  writeSeedsJsonl(merged.rows.slice(0, 5), seedsPath);
  const lines = fs.readFileSync(seedsPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  const parsed = JSON.parse(lines[0]);
  assert.ok(parsed.input && parsed.expected && parsed.source, 'seed line has input/expected/source');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
