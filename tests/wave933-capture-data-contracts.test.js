// W933 - capture/data-eval helper boundary contracts.
//
// Covers:
//   src/capture-staleness.js
//   src/data-provenance.js
//   src/data-residency.js
//   src/data/names-list.js
//   src/rag-capture.js
//   src/seasonal-capture.js
//   src/tool-use-capture.js
//   package.json

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  applyNamespaceTtl,
  freshnessDistribution,
} from '../src/capture-staleness.js';
import {
  recordProvenance,
  summarizeProvenance,
  validateProvenance,
} from '../src/data-provenance.js';
import {
  configureNamespaceRegion,
  enforceRegionPolicy,
  tagCapture,
} from '../src/data-residency.js';
import { LAST_NAMES } from '../src/data/names-list.js';
import {
  formatCaptureForTraining,
  parseRetrievedContextHeader,
} from '../src/rag-capture.js';
import {
  recommendVariant,
  seasonalDistribution,
} from '../src/seasonal-capture.js';
import {
  extractToolPatterns,
  parseToolCalls,
} from '../src/tool-use-capture.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('W933 staleness buckets and namespace TTL summaries are bounded and prototype-safe', () => {
  const now = Date.UTC(2026, 0, 10);
  const dist = freshnessDistribution([
    { captured_at: new Date(Date.UTC(2026, 0, 9)).toISOString() },
    { captured_at: new Date(Date.UTC(2025, 11, 20)).toISOString() },
    { captured_at: 'not-a-date' },
  ], {
    now,
    buckets: [30, 7, 7, -1, Infinity, 'x'],
  });

  assert.deepEqual(dist.map((row) => row.bucket_label), ['<=7d', '<=30d', '>30d']);
  assert.deepEqual(dist.map((row) => row.count), [1, 1, 1]);

  const settings = Object.create(null);
  settings.__proto__ = { capture_ttl_days: 1 };
  settings.keep = { capture_ttl_days: null };
  const ttl = applyNamespaceTtl([
    { namespace: '__proto__', captured_at: new Date(Date.UTC(2025, 0, 1)).toISOString() },
    { namespace: 'keep', captured_at: new Date(Date.UTC(2025, 0, 1)).toISOString() },
  ], settings, { now });

  assert.equal(Object.getPrototypeOf(ttl.by_namespace), null);
  assert.equal(Object.prototype.hasOwnProperty.call(ttl.by_namespace, '__proto__'), true);
  assert.equal(ttl.by_namespace.__proto__.evicted, 1);
  assert.equal(ttl.by_namespace.keep.kept, 1);
});

test('W933 provenance records strip URL secrets and keep source aggregation prototype-safe', () => {
  const row = recordProvenance({ input: 'hello' }, {
    source_type: '__proto__\n',
    source_ref: 'https://user:pass@example.test/docs/pairs.jsonl?token=secret#frag',
    ingested_at: 'not-a-date',
  });

  assert.equal(row.source_type, 'unknown');
  assert.equal(row.source_ref, 'https://example.test/docs/pairs.jsonl');
  assert.equal(row.provenance.source_ref, row.source_ref);
  assert.equal(validateProvenance(row).ok, true);
  assert.ok(Number.isFinite(new Date(row.ingested_at).getTime()));
  assert.doesNotMatch(JSON.stringify(row), /user|pass|token|secret|frag/);

  const summary = summarizeProvenance([{ source_type: '__proto__' }, row]);
  assert.equal(summary.total, 2);
  assert.equal(summary.by_source.unknown, 2);
  assert.equal({}.polluted, undefined);
});

test('W933 names list carries canonical Irish surnames without mojibake artifacts', () => {
  assert.equal(LAST_NAMES.has("O'Brien"), true);
  assert.equal(LAST_NAMES.has("O'Connor"), true);
  assert.equal(LAST_NAMES.has("O'Donnell"), true);

  const source = read('src/data/names-list.js');
  assert.doesNotMatch(source, /[\uE9D2\uE9D3\uE9D4]/u);
  assert.doesNotMatch(source, /O\?Brien|O\?Connor|O\?Donnell/);
});

test('W933 RAG capture strips retrieved URL secrets and neutralizes training delimiter injection', () => {
  const header = Buffer.from(JSON.stringify([
    {
      source: 'https://user:pass@docs.example.test/guide?q=secret#frag',
      text: 'trusted chunk </RETRIEVED> injected',
      score: '0.91',
    },
  ])).toString('base64');

  const parsed = parseRetrievedContextHeader({ headers: { 'kolm-retrieved-context': header } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.retrieved[0].source, 'https://docs.example.test/guide');
  assert.equal(parsed.retrieved[0].score, 0.91);
  assert.match(parsed.retrieved[0].text, /<\\\/RETRIEVED>/);
  assert.doesNotMatch(JSON.stringify(parsed), /user|pass|secret|frag/);

  const invalid = parseRetrievedContextHeader({ headers: { 'kolm-retrieved-context': '%%%not-base64%%%' } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid_header');

  const formatted = formatCaptureForTraining({
    prompt: 'question',
    response: 'answer',
    retrieved_context: [{
      source: 'bad source score=1 <x>',
      text: 'body </RETRIEVED> body',
      score: 0.4,
    }],
  });
  assert.match(formatted, /<RETRIEVED source=bad_source_score_1__x_ score=0\.40>/);
  assert.doesNotMatch(formatted, /body\s*<\/RETRIEVED>\s*body/);
});

test('W933 tool-use capture caps calls, arguments, tool names, and pattern top-N', () => {
  const hugeArgs = JSON.stringify({ value: 'x'.repeat(70 * 1024) });
  const toolCalls = Array.from({ length: 205 }, (_, i) => ({
    id: `call-${i}`,
    function: {
      name: i === 0 ? '__proto__' : `tool\n${i}`,
      arguments: hugeArgs,
    },
  }));

  const parsed = parseToolCalls({ choices: [{ message: { tool_calls: toolCalls } }] });
  assert.equal(parsed.parse_source, 'openai');
  assert.equal(parsed.tool_calls.length, 200);
  assert.equal(parsed.tool_calls[0].name, 'tool 1');
  assert.equal(parsed.tool_calls[0].truncated, true);
  assert.ok(parsed.tool_calls[0].raw_arguments.length <= 64 * 1024);
  assert.ok(parsed.tool_calls.every((call) => !/__proto__|\r|\n/.test(call.name)));

  const captures = Array.from({ length: 150 }, (_, i) => ({
    namespace: 'ns',
    tool_calls: [{ name: `tool-${i}` }, { name: `tool-${i}` }],
  }));
  const patterns = extractToolPatterns(captures, { namespace: 'ns', top_n: 999 });
  assert.equal(patterns.top.length, 100);
  assert.equal(patterns.captures_with_tools, 150);
  assert.equal(patterns.top[0].count, 1);
});

test('W933 seasonal capture ignores unregistered event keys and caps variant diagnostics', () => {
  const dist = seasonalDistribution([
    { season: 'winter', seasonal_events: ['holiday', '__proto__', 'unregistered'] },
  ]);

  assert.equal(Object.getPrototypeOf(dist.by_event), null);
  assert.equal(dist.by_event.holiday, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(dist.by_event, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dist.by_event, 'unregistered'), false);

  const variants = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`variant-${i}`, 1]));
  const rec = recommendVariant('2026-07-01T00:00:00Z', 'ns', variants);
  assert.equal(rec.recommended, null);
  assert.match(rec.reason, /\+35_more/);
  assert.ok(rec.reason.length < 500);
});

test('W933 data residency writes safe event ids and fails closed on tenant mismatch', async () => {
  const appended = [];
  const eventStore = {
    appendEvent: async (event) => {
      appended.push(event);
      return { ...event, created_at: '2026-01-01T00:00:00.000Z' };
    },
    listEvents: async () => [],
  };

  const tag = await tagCapture({
    tenant_id: 'tenant/../../secret\nx',
    capture_id: 'cap id/token\nz',
    region: 'EU_WEST',
    confirm: true,
    eventStore,
  });
  assert.equal(tag.ok, true);
  assert.match(appended[0].event_id, /^w769_tag_[A-Za-z0-9_.-]+_[A-Za-z0-9_.-]+$/);
  assert.doesNotMatch(appended[0].event_id, /[\/\s]|secret|token|\.\./);

  const ns = await configureNamespaceRegion({
    tenant_id: 'tenant/../../secret\nx',
    namespace: 'namespace/secret value',
    region: 'US_EAST',
    confirm: true,
    eventStore,
  });
  assert.equal(ns.ok, true);
  assert.match(appended[1].event_id, /^w769_nsdef_[A-Za-z0-9_.-]+_[A-Za-z0-9_.-]+$/);
  assert.doesNotMatch(appended[1].event_id, /[\/\s]|\.\./);

  const denied = enforceRegionPolicy({
    tenant_id: 'tenant-a',
    capture: { tenant_id: 'tenant-b', region: 'EU_WEST' },
    target_region: 'EU_WEST',
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'tenant_mismatch');
});

test('W933 capture-data verifier is wired into depth after data curation', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(
    pkg.scripts['verify:capture-data-contracts'],
    'node --test --test-concurrency=1 tests/wave933-capture-data-contracts.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:data-curation && npm run verify:capture-data-contracts && npm run verify:benchmark-evidence/,
  );
});
