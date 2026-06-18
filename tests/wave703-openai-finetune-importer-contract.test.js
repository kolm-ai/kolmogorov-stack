// W703 - direct contract for src/importers/openai-finetune.js.
//
// Focus: bounded OpenAI fine-tune JSONL parsing, stable capture row hashes,
// safe error envelopes, namespace controls, and optional file-root fencing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OPENAI_FINETUNE_CONTRACT_VERSION,
  OPENAI_FINETUNE_IMPORTER_VERSION,
  OPENAI_FINETUNE_LIMITS,
  _internal,
  parse,
  parseFile,
} from '../src/importers/openai-finetune.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HEX64_RE = /^[a-f0-9]{64}$/;
const TS = '2026-06-18T00:00:00Z';
const TS_ISO = '2026-06-18T00:00:00.000Z';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function assertNoUnsafeControlBytes(rel) {
  const bytes = fs.readFileSync(path.join(ROOT, rel));
  const bad = [...bytes].filter((b) => b < 32 && b !== 9 && b !== 10 && b !== 13);
  assert.deepEqual(bad, [], `${rel} must not contain raw control bytes`);
}

test('W703 source pins OpenAI fine-tune importer bounds and depth wiring', () => {
  const source = read('src/importers/openai-finetune.js');
  const pkg = readJson('package.json');

  assert.equal(OPENAI_FINETUNE_IMPORTER_VERSION, 'w703-openai-finetune-v1');
  assert.equal(OPENAI_FINETUNE_CONTRACT_VERSION, 'w703-v1');
  assert.equal(OPENAI_FINETUNE_LIMITS.MAX_FILE_BYTES, 16 * 1024 * 1024);
  assert.match(source, /MAX_MESSAGES_PER_ROW/);
  assert.match(source, /MAX_CONTENT_PARTS/);
  assert.match(source, /import_sha256/);
  assert.match(source, /input_sha256/);
  assert.match(source, /allowed_roots/);
  assert.match(source, /invalid_json/);
  assert.doesNotMatch(source, /[^\x00-\x7F]/);
  assertNoUnsafeControlBytes('src/importers/openai-finetune.js');

  assert.equal(
    pkg.scripts['verify:openai-finetune-importer'],
    'node --test --test-concurrency=1 tests/wave703-openai-finetune-importer-contract.test.js',
  );
  assert.match(pkg.scripts['verify:depth'], /verify:failure-modes-w745 && npm run verify:openai-finetune-importer && npm run verify:poisoning-orchestrator && node --test/);
});

test('W703 parse emits stable capture rows for chat and completion formats', () => {
  const chat = {
    messages: [
      { role: 'system', content: 'You are support.' },
      { role: 'user', content: 'Open ticket 123.' },
      { role: 'assistant', content: 'Ticket 123 is open.' },
      { role: 'user', content: [{ type: 'text', text: 'Add priority high.' }] },
      { role: 'assistant', content: 'Priority is now high.' },
    ],
  };
  const completion = { prompt: 'Classify: refund request', completion: 'billing_refund' };
  const text = `${JSON.stringify(chat)}\n${JSON.stringify(completion)}\n`;

  const first = parse(text, { namespace: 'tenant.ns-1', ts: TS });
  const second = parse(text, { namespace: 'tenant.ns-1', ts: TS });

  assert.deepEqual(first, second, 'fixed timestamp import must be deterministic');
  assert.equal(first.source, 'openai-finetune');
  assert.equal(first.importer_version, OPENAI_FINETUNE_IMPORTER_VERSION);
  assert.equal(first.contract_version, OPENAI_FINETUNE_CONTRACT_VERSION);
  assert.match(first.input_sha256, HEX64_RE);
  assert.match(first.import_sha256, HEX64_RE);
  assert.equal(first.rows.length, 2);
  assert.equal(first.errors.length, 0);
  assert.equal(first.stats.lines_parsed, 2);
  assert.equal(first.stats.rows_emitted, 2);

  const row = first.rows[0];
  assert.equal(row.ts, TS_ISO);
  assert.equal(row.namespace, 'tenant.ns-1');
  assert.equal(row.output, 'Priority is now high.');
  assert.match(row.input, /\[system\] You are support\./);
  assert.match(row.input, /\[user\] Open ticket 123\./);
  assert.match(row.input, /\[assistant\] Ticket 123 is open\./);
  assert.match(row.input, /\[user\] Add priority high\./);
  assert.equal(row.id, _internal.rowId(row.input, row.output));
  assert.equal(row.meta.source, 'openai-finetune');
  assert.equal(row.meta.original_format, 'chat');
  assert.equal(row.meta.source_line, 1);
  assert.match(row.meta.input_sha256, HEX64_RE);
  assert.match(row.meta.output_sha256, HEX64_RE);
  assert.match(row.meta.row_sha256, HEX64_RE);

  const legacy = first.rows[1];
  assert.equal(legacy.input, 'Classify: refund request');
  assert.equal(legacy.output, 'billing_refund');
  assert.equal(legacy.meta.original_format, 'completion');
});

test('W703 parse rejects hostile or oversized input without leaking raw content', () => {
  const valid = JSON.stringify({
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
  });

  const invalid = parse('{"prompt":"secret-token",', { namespace: 'safe', ts: TS });
  assert.equal(invalid.rows.length, 0);
  assert.equal(invalid.errors[0].code, 'invalid_json');
  assert.equal(JSON.stringify(invalid).includes('secret-token'), false);

  const unsafeNamespace = parse(valid, { namespace: 'bad\nnamespace', ts: TS });
  assert.equal(unsafeNamespace.rows.length, 0);
  assert.equal(unsafeNamespace.errors[0].code, 'namespace_invalid');

  const badTs = parse(valid, { namespace: 'safe', ts: 'not-a-date' });
  assert.equal(badTs.errors[0].code, 'timestamp_invalid');

  const manyMessages = {
    messages: [
      ...Array.from({ length: OPENAI_FINETUNE_LIMITS.MAX_MESSAGES_PER_ROW + 1 }, () => ({ role: 'user', content: 'x' })),
      { role: 'assistant', content: 'y' },
    ],
  };
  const tooManyMessages = parse(JSON.stringify(manyMessages), { namespace: 'safe', ts: TS });
  assert.equal(tooManyMessages.errors[0].code, 'messages_array_too_large');

  const tooManyParts = {
    messages: [
      { role: 'user', content: Array.from({ length: OPENAI_FINETUNE_LIMITS.MAX_CONTENT_PARTS + 1 }, () => ({ text: 'x' })) },
      { role: 'assistant', content: 'y' },
    ],
  };
  const partLimit = parse(JSON.stringify(tooManyParts), { namespace: 'safe', ts: TS });
  assert.equal(partLimit.errors[0].code, 'message_content_too_many_parts');

  const lineLimit = parse('\n'.repeat(OPENAI_FINETUNE_LIMITS.MAX_LINES), { namespace: 'safe', ts: TS });
  assert.equal(lineLimit.errors[0].code, 'line_count_limit_exceeded');
});

test('W703 parseFile supports allowed root fencing and returns the same contract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w703-openai-ft-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w703-openai-ft-outside-'));
  try {
    const file = path.join(dir, 'train.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ prompt: 'a', completion: 'b' })}\n`, 'utf8');

    const parsed = parseFile(file, { allowed_roots: [dir], namespace: 'file.ns', ts: TS });
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].namespace, 'file.ns');
    assert.equal(parsed.rows[0].ts, TS_ISO);
    assert.equal(parsed.errors.length, 0);
    assert.match(parsed.import_sha256, HEX64_RE);

    const outside = path.join(outsideDir, 'train.jsonl');
    fs.writeFileSync(outside, `${JSON.stringify({ prompt: 'x', completion: 'y' })}\n`, 'utf8');
    assert.throws(
      () => parseFile(outside, { allowed_roots: [dir], namespace: 'file.ns', ts: TS }),
      (err) => err && err.code === 'openai_finetune_file_outside_allowed_roots',
    );

    assert.throws(
      () => parseFile(dir, { namespace: 'file.ns', ts: TS }),
      (err) => err && err.code === 'openai_finetune_file_not_regular',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
