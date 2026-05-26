// Research docs lock-in.
//
// Asserts that the speculative-decoding research design doc exists, is
// non-trivial, covers the required section vocabulary, and is referenced
// from the docs/research/README.md index. This is a lightweight presence
// test, not a copy lock — it pins structure (section headers, status
// callout, expected technical terms) so the doc cannot silently regress
// to a stub or lose its research-roadmap framing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RESEARCH_DIR = path.join(ROOT, 'docs', 'research');
const SPEC_DEC_DOC = path.join(RESEARCH_DIR, 'spec-dec-student-as-draft.md');
const README = path.join(RESEARCH_DIR, 'README.md');

function readDoc() {
  return fs.readFileSync(SPEC_DEC_DOC, 'utf8');
}

test('research-docs #1 - spec-dec design doc exists with non-trivial byte count', () => {
  assert.ok(fs.existsSync(SPEC_DEC_DOC), 'spec-dec-student-as-draft.md must exist');
  const stats = fs.statSync(SPEC_DEC_DOC);
  assert.ok(stats.size > 10000, `doc must be > 10KB (got ${stats.size}); design doc, not a stub`);
});

test('research-docs #2 - spec-dec doc has required top-level sections', () => {
  const body = readDoc();
  const requiredHeadings = [
    'Problem statement',
    'Speculative decoding background',
    'kolm insight',
    'Architecture',
    'routing tier',
    'Implementation plan',
    'Caveats',
    'Validation plan',
    'envelope math',
    'Decision',
  ];
  for (const heading of requiredHeadings) {
    assert.ok(
      body.includes(heading),
      `doc must reference section "${heading}"; missing in spec-dec-student-as-draft.md`,
    );
  }
});

test('research-docs #3 - spec-dec doc names the core spec-dec mechanics', () => {
  const body = readDoc();
  const requiredTerms = [
    'draft model',
    'target',
    'acceptance rate',
    'candidate tokens',
    'verify',
    'Leviathan',
    'logit',
    'vLLM',
    'KV cache',
    'tokenizer',
  ];
  for (const term of requiredTerms) {
    assert.ok(
      body.toLowerCase().includes(term.toLowerCase()),
      `doc must mention spec-dec mechanic "${term}"`,
    );
  }
});

test('research-docs #4 - spec-dec doc explicitly enumerates the public-API logit caveat', () => {
  const body = readDoc();
  assert.ok(
    body.includes('Anthropic') && body.includes('OpenAI'),
    'doc must name Anthropic and OpenAI as the public-API teachers whose logit access blocks lossless spec-dec',
  );
  assert.ok(
    body.toLowerCase().includes('logit access') || body.toLowerCase().includes('logit-exposing') || body.toLowerCase().includes('token-level logit'),
    'doc must articulate the logit-access requirement on the teacher',
  );
});

test('research-docs #5 - spec-dec doc ends with a research-roadmap status callout', () => {
  const body = readDoc();
  assert.ok(
    body.includes('Research roadmap, not for V1 launch'),
    'doc must end with the explicit "Research roadmap, not for V1 launch" framing',
  );
  assert.ok(
    body.includes('STATUS'),
    'doc must carry a STATUS callout',
  );
});

test('research-docs #6 - spec-dec doc carries an architecture ASCII diagram', () => {
  const body = readDoc();
  // The diagram block uses ASCII box-drawing and a labelled flow.
  assert.ok(body.includes('```'), 'doc must include at least one fenced code block (architecture diagram)');
  assert.ok(
    body.includes('verify') && body.includes('accept') && body.includes('correct'),
    'architecture section must enumerate verify, accept, correct token flow',
  );
});

test('research-docs #7 - spec-dec doc references receipt schema extensions', () => {
  const body = readDoc();
  const receiptFields = [
    'route_decision',
    'draft_acceptance_rate',
    'teacher',
    'corrections',
  ];
  for (const f of receiptFields) {
    assert.ok(body.includes(f), `doc must enumerate receipt field "${f}"`);
  }
});

test('research-docs #8 - spec-dec doc covers the back-of-envelope math', () => {
  const body = readDoc();
  // The doc must put numbers next to the claim: teacher tok/s, student tok/s,
  // and a working acceptance-rate band.
  assert.ok(/tok\/s/i.test(body), 'doc must include tok/s figures');
  assert.ok(/0\.7[05]/.test(body) || /0\.8[05]/.test(body) || /70-85/.test(body), 'doc must state a working acceptance-rate band (0.70-0.85)');
  assert.ok(/[0-9]+x/.test(body), 'doc must include a speedup multiplier (e.g. 19x)');
});

test('research-docs #9 - spec-dec doc forbids the banned vocabulary', () => {
  const body = readDoc();
  // Per repo-wide directive: no "honesty"/"honest". Use Caveats / Constraints / Limitations.
  // Test is case-insensitive; whole-word match to avoid catching unrelated substrings.
  const banned = /\b(honesty|honest|honestly|dishonest|dishonesty)\b/i;
  assert.ok(!banned.test(body), 'doc must not use the banned "honesty/honest" vocabulary');
  // And the doc must show evidence of the replacement vocabulary.
  assert.ok(
    body.includes('Caveats') || body.includes('Limitations') || body.includes('Constraints'),
    'doc must use Caveats / Limitations / Constraints framing',
  );
});

test('research-docs #10 - spec-dec doc is referenced from docs/research/README.md', () => {
  const readme = fs.readFileSync(README, 'utf8');
  assert.ok(
    readme.includes('spec-dec-student-as-draft.md'),
    'docs/research/README.md must reference the new spec-dec design doc in its index',
  );
  assert.ok(
    /Research roadmap, not for V1 launch|speculative decoding/i.test(readme),
    'README index entry must indicate the doc is roadmap / about speculative decoding',
  );
});

test('research-docs #11 - spec-dec doc identifies the new spec_dec route distinct from existing routes', () => {
  const body = readDoc();
  assert.ok(body.includes('local-only'), 'doc must reference the existing local-only route');
  assert.ok(body.includes('frontier-only'), 'doc must reference the existing frontier-only route');
  assert.ok(body.includes('spec_dec') || body.includes('spec-dec'), 'doc must name the new spec_dec route');
});

test('research-docs #12 - spec-dec doc lays out a phased implementation plan with at least 4 phases', () => {
  const body = readDoc();
  const phaseMatches = body.match(/Phase\s+[1-9]/g) || [];
  const uniquePhases = new Set(phaseMatches.map((s) => s.replace(/\s+/g, ' ')));
  assert.ok(
    uniquePhases.size >= 4,
    `doc must enumerate at least 4 implementation phases (found ${uniquePhases.size})`,
  );
});
