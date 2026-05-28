// W918 P3.4 — OpenRouter generation history importer lock-in tests.
//
// Pins the contract of src/importers/openrouter.js against the fixture at
// data/eval-fixtures/openrouter-sample.jsonl. Sibling agents wire the CLI
// dispatcher; these assertions cover the per-row normalisation that the
// dispatcher relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { parse, parseFile } from '../src/importers/openrouter.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const FIXTURE = path.join(repoRoot, 'data', 'eval-fixtures', 'openrouter-sample.jsonl');

test('W918-P3.4.a parseFile on fixture returns 3 rows, 0 skipped, 0 parseErrors', () => {
  const result = parseFile(FIXTURE);
  assert.equal(result.source, 'openrouter', 'result.source must be "openrouter"');
  assert.equal(result.rows.length, 3, 'expected 3 rows from the 3-line fixture');
  assert.equal(result.skipped, 0, 'expected 0 skipped rows on a clean fixture');
  assert.equal(result.parseErrors.length, 0, 'expected no parse errors on a clean fixture');
});

test('W918-P3.4.b each row has source:openrouter, non-empty messages, model string', () => {
  const { rows } = parseFile(FIXTURE);
  for (const row of rows) {
    assert.equal(row.source, 'openrouter', 'row.source must be "openrouter"');
    assert.ok(Array.isArray(row.messages), 'row.messages must be an array');
    assert.ok(row.messages.length > 0, 'row.messages must be non-empty');
    for (const m of row.messages) {
      assert.equal(typeof m.role, 'string', 'each message must have a string role');
      assert.equal(typeof m.content, 'string', 'each message must have a string content');
      assert.ok(m.content.length > 0, 'each message content must be non-empty');
    }
    assert.equal(typeof row.model, 'string', 'row.model must be a string');
    assert.ok(row.model.length > 0, 'row.model must be non-empty');
    assert.ok(row.response && typeof row.response === 'object', 'row.response must be an object');
    assert.equal(typeof row.response.content, 'string', 'row.response.content must be a string');
    assert.ok(row.response.content.length > 0, 'row.response.content must be non-empty');
  }
  // Spot-check the three expected provider slugs.
  const slugs = rows.map((r) => r.model);
  assert.ok(slugs.some((s) => s.startsWith('anthropic/')), 'expected one anthropic/ row');
  assert.ok(slugs.some((s) => s.startsWith('openai/')), 'expected one openai/ row');
  assert.ok(slugs.some((s) => s.startsWith('mistralai/')), 'expected one mistralai/ row');
});

test('W918-P3.4.c malformed row {} is skipped, parse does not throw', () => {
  let result;
  assert.doesNotThrow(() => {
    result = parse(JSON.stringify({}));
  }, 'parse must not throw on a malformed empty-object row');
  assert.equal(result.rows.length, 0, 'malformed row must not produce a kolm capture row');
  assert.equal(result.skipped, 1, 'malformed row must be counted as skipped');
  assert.equal(result.parseErrors.length, 1, 'malformed row must produce exactly one parseError');
  assert.equal(result.parseErrors[0].idx, 0, 'parseError idx must point at the offending row');
  assert.equal(typeof result.parseErrors[0].reason, 'string', 'parseError reason must be a string');
  assert.ok(result.parseErrors[0].reason.length > 0, 'parseError reason must be non-empty');
});

test('W918-P3.4.d JSON-array wrap parses the same as JSONL', () => {
  const jsonlResult = parseFile(FIXTURE);
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const rowObjects = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  const arrayResult = parse(JSON.stringify(rowObjects));
  assert.equal(arrayResult.rows.length, jsonlResult.rows.length, 'array wrap row count must match JSONL row count');
  assert.equal(arrayResult.skipped, jsonlResult.skipped, 'array wrap skipped count must match JSONL skipped count');
  assert.equal(arrayResult.parseErrors.length, jsonlResult.parseErrors.length, 'array wrap parseErrors must match JSONL parseErrors');
  for (let i = 0; i < arrayResult.rows.length; i++) {
    assert.equal(arrayResult.rows[i].source_id, jsonlResult.rows[i].source_id, `row[${i}].source_id must match across array and JSONL`);
    assert.equal(arrayResult.rows[i].model, jsonlResult.rows[i].model, `row[${i}].model must match across array and JSONL`);
    assert.equal(arrayResult.rows[i].response.content, jsonlResult.rows[i].response.content, `row[${i}].response.content must match across array and JSONL`);
  }
  // Also confirm the { data: [...] } wrap form parses identically.
  const wrappedResult = parse(JSON.stringify({ data: rowObjects }));
  assert.equal(wrappedResult.rows.length, jsonlResult.rows.length, '{ data: [...] } wrap row count must match JSONL row count');
});
