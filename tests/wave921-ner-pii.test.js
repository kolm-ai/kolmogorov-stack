// tests/wave921-ner-pii.test.js
//
// W921 Phase-1 — ML/NER-style PII recognizer (src/ner-recognizer.js) +
// Presidio-style span merger (src/span-merge.js).
//
// These are UNIT tests: they require NO model and NO onnxruntime-node. The
// recognizer's dependency-free gazetteer+context-rule backend is exercised
// directly, and the merge tier is fed both synthetic and real phi-redactor
// findings. The token round-trip invariant (phi.reinject(applyPlan(...)) ===
// original) is asserted against the real phi-redactor.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  recognize,
  loadNerSession,
  nerAvailable,
  nerStatus,
  defaultLabels,
  GLINER_LABEL_MAP,
  contextLemmasFor,
  _internal as nerInternal,
} from '../src/ner-recognizer.js';

import {
  mergeFindings,
  resolveOverlaps,
  applyContextBoost,
  applyPlan,
} from '../src/span-merge.js';

import * as phi from '../src/phi-redactor.js';

// --------------------------------------------------------------------------
// ner-recognizer: label map + defaults
// --------------------------------------------------------------------------

test('defaultLabels returns a non-empty frozen-source label set', () => {
  const labels = defaultLabels();
  assert.ok(Array.isArray(labels) && labels.length > 0);
  assert.ok(labels.includes('person'));
  // returned a copy, not the frozen original
  labels.push('mutation');
  assert.ok(!defaultLabels().includes('mutation'));
});

test('GLINER_LABEL_MAP folds human labels onto kolm CLASSES', () => {
  assert.equal(GLINER_LABEL_MAP['person'], 'NAME');
  assert.equal(GLINER_LABEL_MAP['phone number'], 'PHONE');
  assert.equal(GLINER_LABEL_MAP['social security number'], 'SSN');
  // unknown label falls back to OTHER via the internal mapper
  assert.equal(nerInternal._labelToClass('totally unknown label'), 'OTHER');
  // keyword fallback for a near-miss label
  assert.equal(nerInternal._labelToClass('home phone'), 'PHONE');
});

// --------------------------------------------------------------------------
// ner-recognizer: rule backend recognizes free-text PII the regex tier misses
// --------------------------------------------------------------------------

test('recognize() catches an unlabeled person name after a trigger word', async () => {
  const text = 'I spoke with Maria about her results.';
  const out = await recognize(text);
  assert.equal(out.engine, 'rule');
  assert.equal(out.model_id, 'kolm-rule-ner-v1');
  const names = out.spans.filter((s) => s.label === 'NAME');
  assert.ok(names.length >= 1, 'expected at least one NAME span');
  const maria = names.find((s) => text.slice(s.start, s.end).startsWith('Maria'));
  assert.ok(maria, 'expected Maria to be recognized');
  // regex tier (phi.redact) provably misses an unlabeled bare name
  const { map } = phi.redact(text);
  assert.ok(!Object.values(map).includes('Maria'), 'regex tier should miss bare Maria');
});

test('recognize() catches a multi-word name after an honorific', async () => {
  const text = 'Please call Dr Maria Lopez tomorrow.';
  const out = await recognize(text);
  const span = out.spans.find((s) => s.label === 'NAME' && text.slice(s.start, s.end).includes('Maria'));
  assert.ok(span, 'expected a NAME span');
  assert.equal(text.slice(span.start, span.end), 'Maria Lopez');
  assert.ok(span.score >= 0.6);
});

test('recognize() catches a free-text street address without a label keyword', async () => {
  const text = 'They moved to 742 Evergreen Terrace last spring.';
  const out = await recognize(text);
  const geo = out.spans.find((s) => s.label === 'GEO');
  assert.ok(geo, 'expected a GEO span');
  assert.ok(text.slice(geo.start, geo.end).includes('Evergreen'));
});

test('recognize() does not over-fire on sentence-initial cap words', async () => {
  const text = 'The patient arrived. Today the weather was nice.';
  const out = await recognize(text);
  const names = out.spans.filter((s) => s.label === 'NAME');
  assert.equal(names.length, 0, 'no NAME spans for plain sentence-initial words');
});

test('recognize() returns spans with valid clamped offsets', async () => {
  const text = 'I spoke with Maria Lopez at 742 Evergreen Terrace.';
  const out = await recognize(text);
  for (const s of out.spans) {
    assert.ok(s.start >= 0 && s.end <= text.length && s.end > s.start);
    assert.ok(typeof s.score === 'number' && s.score >= 0 && s.score <= 1);
  }
});

test('recognize() never throws and is empty for empty/oversized input', async () => {
  const a = await recognize('');
  assert.deepEqual(a.spans, []);
  const big = 'a'.repeat(100);
  const b = await recognize(big, { maxChars: 10 });
  assert.equal(b.engine, 'unavailable');
  assert.deepEqual(b.spans, []);
});

test('recognize() respects an explicit threshold', async () => {
  const text = 'I spoke with Maria about her results.';
  const low = await recognize(text, { threshold: 0.4 });
  const high = await recognize(text, { threshold: 0.95 });
  assert.ok(low.spans.length >= high.spans.length);
});

// --------------------------------------------------------------------------
// ner-recognizer: optional ONNX backend stays unavailable without a model
// --------------------------------------------------------------------------

test('loadNerSession() returns null when no model is configured', async () => {
  const prev = process.env.KOLM_NER_MODEL;
  delete process.env.KOLM_NER_MODEL;
  try {
    const sess = await loadNerSession({ force: true });
    assert.equal(sess, null);
    assert.equal(nerAvailable(), false);
    const status = nerStatus();
    assert.equal(status.engine, 'rule');
    assert.equal(status.ready, true);
  } finally {
    if (prev !== undefined) process.env.KOLM_NER_MODEL = prev;
  }
});

test('contextLemmasFor returns a copy per class', () => {
  const a = contextLemmasFor('NAME');
  assert.ok(a.includes('patient'));
  a.push('zzz');
  assert.ok(!contextLemmasFor('NAME').includes('zzz'));
  assert.deepEqual(contextLemmasFor('NONEXISTENT'), []);
});

// --------------------------------------------------------------------------
// span-merge: applyContextBoost
// --------------------------------------------------------------------------

test('applyContextBoost lifts a span when a context lemma is nearby', () => {
  const text = 'The patient Maria was discharged.';
  const span = { start: text.indexOf('Maria'), end: text.indexOf('Maria') + 5, score: 0.45 };
  const boosted = applyContextBoost(span, text, ['patient'], 0.2);
  assert.ok(boosted > 0.45);
  assert.ok(boosted <= 1.0);
});

test('applyContextBoost leaves score unchanged with no lemma in window', () => {
  const text = 'Maria walked to the store far away from any clinical word here.';
  const span = { start: 0, end: 5, score: 0.45 };
  const boosted = applyContextBoost(span, text, ['patient'], 0.2, 10);
  assert.equal(boosted, 0.45);
});

test('context boost lifts a 0.45 person over a 0.5 threshold when patient is nearby', () => {
  const text = 'The patient Maria has a follow-up.';
  const start = text.indexOf('Maria');
  const nerSpans = [{ start, end: start + 5, label: 'NAME', raw_label: 'person', score: 0.45 }];
  const { findings } = mergeFindings([], nerSpans, { text, threshold: 0.5, delta: 0.2 });
  assert.equal(findings.length, 1, 'boosted span survives the 0.5 threshold');
  assert.equal(findings[0].class, 'NAME');
  assert.ok(findings[0].score >= 0.5);
});

test('a 0.45 span below threshold with no context is dropped', () => {
  const text = 'Maria walked downtown.';
  const nerSpans = [{ start: 0, end: 5, label: 'NAME', raw_label: 'person', score: 0.45 }];
  const { findings } = mergeFindings([], nerSpans, { text, threshold: 0.5, delta: 0.2 });
  assert.equal(findings.length, 0);
});

// --------------------------------------------------------------------------
// span-merge: resolveOverlaps (Presidio tiebreaks)
// --------------------------------------------------------------------------

test('resolveOverlaps keeps the longest span on overlap', () => {
  const spans = [
    { start: 10, end: 20, score: 0.9, source: 'ner', class: 'OTHER' },     // 10 wide
    { start: 10, end: 30, score: 0.5, source: 'ner', class: 'NAME' },      // 20 wide -> wins
  ];
  const kept = resolveOverlaps(spans);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].end, 30);
});

test('resolveOverlaps prefers regex source on a length+score tie', () => {
  const spans = [
    { start: 0, end: 10, score: 0.8, source: 'ner', class: 'OTHER' },
    { start: 0, end: 10, score: 0.8, source: 'regex', class: 'SSN' },
  ];
  const kept = resolveOverlaps(spans);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].source, 'regex');
  assert.equal(kept[0].class, 'SSN');
});

test('resolveOverlaps keeps two disjoint spans', () => {
  const spans = [
    { start: 0, end: 5, score: 0.6, source: 'ner', class: 'NAME' },
    { start: 20, end: 26, score: 0.6, source: 'ner', class: 'NAME' },
  ];
  const kept = resolveOverlaps(spans);
  assert.equal(kept.length, 2);
  // returned in source order
  assert.ok(kept[0].start < kept[1].start);
});

// --------------------------------------------------------------------------
// span-merge: regex SSN + overlapping NER 'identifier' collapse to one finding
// --------------------------------------------------------------------------

test('overlapping regex SSN and NER span collapse to the regex finding', () => {
  const text = 'SSN 123-45-6789 on file.';
  const start = text.indexOf('123-45-6789');
  const regexFindings = [
    { type: 'ssn', span: [start, start + 11], reason: 'well-formed SSN', safe_to_send: true },
  ];
  const nerSpans = [
    // NER fuzzily tags the same region as an "account number"
    { start, end: start + 11, label: 'ACCT', raw_label: 'account number', score: 0.9 },
  ];
  const { findings, plan } = mergeFindings(regexFindings, nerSpans, { text });
  assert.equal(findings.length, 1, 'one merged finding, not two');
  assert.equal(findings[0].source, 'regex');
  assert.equal(findings[0].class, 'SSN');
  // plan is non-overlapping
  for (let i = 1; i < plan.length; i++) {
    assert.ok(plan[i].start >= plan[i - 1].end);
  }
});

// --------------------------------------------------------------------------
// span-merge: non-overlapping plan, applyPlan, token round-trip via reinject
// --------------------------------------------------------------------------

test('merged plan is non-overlapping and sorted', () => {
  const text = 'Call Maria Lopez and Dr John Smith at 742 Evergreen Terrace.';
  const spans = [
    { start: text.indexOf('Maria'), end: text.indexOf('Maria') + 'Maria Lopez'.length, label: 'NAME', score: 0.7 },
    { start: text.indexOf('John'), end: text.indexOf('John') + 'John Smith'.length, label: 'NAME', score: 0.7 },
    { start: text.indexOf('742'), end: text.indexOf('Terrace') + 'Terrace'.length, label: 'GEO', score: 0.7 },
  ];
  const { plan } = mergeFindings([], spans, { text });
  assert.equal(plan.length, 3);
  for (let i = 1; i < plan.length; i++) {
    assert.ok(plan[i].start >= plan[i - 1].end, 'plan entries do not overlap');
  }
});

test('phi.reinject(applyPlan(text, plan).text, map) === original text', () => {
  const text = 'I spoke with Maria Lopez at 742 Evergreen Terrace about her chart.';
  const reg = phi.redactPhi(text); // real regex tier findings
  const ner = [
    { start: text.indexOf('Maria'), end: text.indexOf('Maria') + 'Maria Lopez'.length, label: 'NAME', raw_label: 'person', score: 0.7 },
  ];
  const { plan, map } = mergeFindings(reg.findings, ner, { text });
  const applied = applyPlan(text, plan);
  // mergeFindings' own map and applyPlan's derived map agree
  assert.deepEqual(applied.map, map);
  // round-trip invariant: reinjecting the tokens restores the original
  assert.equal(phi.reinject(applied.text, map), text);
  // the unlabeled name was actually masked
  assert.ok(!applied.text.includes('Maria Lopez'));
});

test('identical original substrings map to the same token', () => {
  const text = 'Maria Lopez told Maria Lopez the news.';
  const start1 = text.indexOf('Maria Lopez');
  const start2 = text.lastIndexOf('Maria Lopez');
  const spans = [
    { start: start1, end: start1 + 'Maria Lopez'.length, label: 'NAME', score: 0.7 },
    { start: start2, end: start2 + 'Maria Lopez'.length, label: 'NAME', score: 0.7 },
  ];
  const { plan, map } = mergeFindings([], spans, { text });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].replacement, plan[1].replacement, 'same value -> same token');
  assert.equal(Object.keys(map).length, 1);
  const applied = applyPlan(text, plan);
  assert.equal(phi.reinject(applied.text, applied.map), text);
});

// --------------------------------------------------------------------------
// end-to-end: recognize() spans feed mergeFindings cleanly
// --------------------------------------------------------------------------

test('recognize() output merges with regex findings into a clean plan', async () => {
  const text = 'Patient Maria called from 555-123-4567 about MRN: AB1234.';
  const reg = phi.redactPhi(text);
  const ner = await recognize(text);
  const { plan, findings, map } = mergeFindings(reg.findings, ner.spans, { text });
  // non-overlapping
  for (let i = 1; i < plan.length; i++) {
    assert.ok(plan[i].start >= plan[i - 1].end);
  }
  // round-trips
  const applied = applyPlan(text, plan);
  assert.equal(phi.reinject(applied.text, map), text);
  // at least one finding attributed to each tier that fired
  const sources = new Set(findings.map((f) => f.source));
  assert.ok(sources.has('regex'), 'regex tier contributed');
});
