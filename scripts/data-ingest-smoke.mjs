#!/usr/bin/env node
// scripts/data-ingest-smoke.mjs
//
// Smoke test for the KOLM Data Engine INGEST stage (src/data-ingest.js +
// src/data-provenance.js). Isolates ALL state under a fresh temp KOLM_DATA_DIR
// so it never touches the developer's ~/.kolm. Prints "N passed, M failed" and
// exits nonzero if anything fails.
//
// Run: node scripts/data-ingest-smoke.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- isolate state BEFORE importing the module under test --------------------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-ingest-smoke-'));
process.env.KOLM_DATA_DIR = TMP_ROOT;
// Force the event-store JSONL fallback so persistence never blocks on a sqlite
// build and stays inside the isolated dir.
process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';

const {
  INGEST_VERSION,
  ingestDescribe,
  ingestFile,
  ingestDocs,
  ingestFrom,
  ingestCombined,
  ingestPairs,
  readRawPairs,
  rawPairsPath,
  validateProvenance,
} = await import('../src/data-ingest.js');
const { PROVENANCE_VERSION, summarizeProvenance } = await import('../src/data-provenance.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function readLines(namespace) {
  const p = rawPairsPath(namespace);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function mkdtmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// =============================================================================
console.log(`data-ingest smoke (version ${INGEST_VERSION} / provenance ${PROVENANCE_VERSION})`);
console.log(`isolated KOLM_DATA_DIR=${TMP_ROOT}`);

// --- 1. ingestDescribe(n=8) → 8 lines, each with valid provenance ------------
{
  const ns = 'smoke-describe';
  const res = await ingestDescribe({ namespace: ns, description: 'A support agent that handles refund requests for an online store', n: 8 });
  check('1.describe ok envelope', res && res.ok === true, JSON.stringify(res));
  check('1.describe version', res.version === 'ingest-v1', res.version);
  check('1.describe n_written=8', res.n_written === 8, `n_written=${res.n_written}`);
  const lines = readLines(ns);
  check('1.describe 8 lines on disk', lines.length === 8, `lines=${lines.length}`);
  const allValid = lines.every(p => validateProvenance(p).ok);
  check('1.describe every line has valid provenance', allValid);
  const allDescribe = lines.every(p => p.source_type === 'describe');
  check('1.describe source_type=describe', allDescribe);
  const allEmptyOutput = lines.every(p => p.output === '');
  check('1.describe output empty (seed prompts)', allEmptyOutput);
  const hasProvBlock = lines.every(p => p.provenance && p.provenance.source_type === 'describe' && p.provenance.ingested_at && p.provenance.source_ref);
  check('1.describe nested provenance block complete', hasProvBlock);
}

// --- 2. ingestFile on a tmp JSONL of 3 pairs → 3 appended, outputs preserved -
{
  const ns = 'smoke-file';
  const dir = mkdtmp('kolm-ingest-file-');
  const fp = path.join(dir, 'pairs.jsonl');
  fs.writeFileSync(fp, [
    JSON.stringify({ input: 'What is 2+2?', output: '4' }),
    JSON.stringify({ input: 'Capital of France?', output: 'Paris' }),
    JSON.stringify({ input: 'Boiling point of water in C?', output: '100' }),
  ].join('\n') + '\n');
  const res = await ingestFile({ namespace: ns, file: fp });
  check('2.file ok envelope', res && res.ok === true, JSON.stringify(res));
  check('2.file n_written=3', res.n_written === 3, `n_written=${res.n_written}`);
  check('2.file source_type=file', res.source_type === 'file');
  const lines = readLines(ns);
  check('2.file 3 lines on disk', lines.length === 3, `lines=${lines.length}`);
  const outputs = lines.map(p => p.output).sort();
  check('2.file outputs preserved', JSON.stringify(outputs) === JSON.stringify(['100', '4', 'Paris']), JSON.stringify(outputs));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 2b. ingestFile missing file → ok:false input_not_found ------------------
{
  const res = await ingestFile({ namespace: 'smoke-file-missing', file: path.join(TMP_ROOT, 'does-not-exist.jsonl') });
  check('2b.file missing → input_not_found', res && res.ok === false && res.error === 'input_not_found', JSON.stringify(res));
}

// --- 3. ingestDocs on a tmp folder with 2 .md files → ≥2 pairs, type 'docs' --
{
  const ns = 'smoke-docs';
  const dir = mkdtmp('kolm-ingest-docs-');
  fs.writeFileSync(path.join(dir, 'getting-started.md'),
    '# Installing the CLI\nRun npm install to set up the kolm CLI on your machine.\n\n# Resetting your password\nClick the reset link in your account settings to choose a new password.\n');
  fs.writeFileSync(path.join(dir, 'compiling.md'),
    '# Compiling a model\nUse kolm compile with a spec file to compile your first model on a GPU.\n');
  const res = await ingestDocs({ namespace: ns, docs_dir: dir });
  check('3.docs ok envelope', res && res.ok === true, JSON.stringify(res));
  check('3.docs n_written>=2', res.n_written >= 2, `n_written=${res.n_written}`);
  check('3.docs source_type=docs', res.source_type === 'docs');
  const lines = readLines(ns);
  check('3.docs >=2 lines on disk', lines.length >= 2, `lines=${lines.length}`);
  const allDocs = lines.every(p => p.source_type === 'docs' && p.provenance.source_type === 'docs');
  check('3.docs every line source_type=docs', allDocs);
  const allHaveOutput = lines.every(p => p.output && p.output.length > 0);
  check('3.docs chunk text is the reference output', allHaveOutput);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 4. ingestFrom for EACH of the 5 sources → non-empty input extracted -----
{
  const dir = mkdtmp('kolm-ingest-from-');

  const fixtures = {
    'openai-finetune': {
      file: 'oai.jsonl',
      content: [
        JSON.stringify({ messages: [{ role: 'system', content: 'You are support.' }, { role: 'user', content: 'Where is my order #123?' }, { role: 'assistant', content: 'Let me check order #123 for you.' }] }),
        JSON.stringify({ messages: [{ role: 'user', content: 'I want a refund.' }, { role: 'assistant', content: 'I can help with that refund.' }] }),
      ].join('\n'),
    },
    'portkey': {
      file: 'portkey.jsonl',
      content: [
        JSON.stringify({ request: { messages: [{ role: 'user', content: 'How do I reset my password?' }] }, response: { choices: [{ message: { role: 'assistant', content: 'Click reset in settings.' } }] } }),
      ].join('\n'),
    },
    'helicone': {
      file: 'helicone.jsonl',
      content: [
        JSON.stringify({ request: { prompt: 'Summarize the refund policy.' }, response: { choices: [{ text: 'Refunds within 30 days.' }] } }),
      ].join('\n'),
    },
    'litellm': {
      file: 'litellm.jsonl',
      content: [
        JSON.stringify({ request: { messages: [{ role: 'user', content: 'What are your hours?' }] }, response: { content: 'We are open 9-5.' } }),
      ].join('\n'),
    },
    'hf': {
      file: 'hf.jsonl',
      content: [
        JSON.stringify({ prompt: 'Define entropy.', response: 'A measure of disorder.' }),
        JSON.stringify({ instruction: 'Translate to French', input: 'hello', output: 'bonjour' }),
        JSON.stringify({ question: 'What is a noble gas?', answer: 'An inert element like argon.' }),
      ].join('\n'),
    },
  };

  for (const [source, fx] of Object.entries(fixtures)) {
    const fp = path.join(dir, fx.file);
    fs.writeFileSync(fp, fx.content + '\n');
    const ns = 'smoke-from-' + source;
    const res = await ingestFrom({ namespace: ns, source, file: fp });
    check(`4.from:${source} ok envelope`, res && res.ok === true, JSON.stringify(res));
    check(`4.from:${source} source_type`, res.source_type === 'from:' + source, res.source_type);
    check(`4.from:${source} n_written>=1`, res.n_written >= 1, `n_written=${res.n_written}`);
    const lines = readLines(ns);
    const allNonEmptyInput = lines.length > 0 && lines.every(p => p.input && p.input.trim().length > 0);
    check(`4.from:${source} every pair has non-empty input`, allNonEmptyInput, `lines=${lines.length}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 5. ingestCombined over 2 sources → merged=sum, dedupe drops dup id ------
{
  const ns = 'smoke-combined';
  const dir = mkdtmp('kolm-ingest-combined-');
  const fileA = path.join(dir, 'a.jsonl');
  fs.writeFileSync(fileA, [
    JSON.stringify({ input: 'Combined Q one', output: 'A one' }),
    JSON.stringify({ input: 'Combined Q two', output: 'A two' }),
  ].join('\n') + '\n');

  // Two pairs in-memory; one shares an explicit id with the OTHER source to
  // force a dedupe drop on merge.
  const sources = [
    { kind: 'file', file: fileA },
    { kind: 'pairs', pairs: [
      { id: 'dup_marker', input: 'Combined Q three', output: 'A three' },
      { id: 'dup_marker', input: 'Combined Q four', output: 'A four' }, // same id → dropped
    ] },
  ];
  const res = await ingestCombined({ namespace: ns, sources });
  check('5.combined ok envelope', res && res.ok === true, JSON.stringify(res));
  check('5.combined source_type=combined', res.source_type === 'combined');
  check('5.combined has per-source contributions', Array.isArray(res.contributions) && res.contributions.length === 2, JSON.stringify(res.contributions));

  const fileContrib = res.contributions.find(c => c.kind === 'file');
  const pairsContrib = res.contributions.find(c => c.kind === 'pairs');
  check('5.combined file contributed 2', fileContrib && fileContrib.n_written === 2, JSON.stringify(fileContrib));
  // pairs source had 2 inputs but one duplicate id → only 1 written.
  check('5.combined pairs contributed 1 (dup id dropped)', pairsContrib && pairsContrib.n_written === 1, JSON.stringify(pairsContrib));
  check('5.combined dup id reported as skipped', pairsContrib && pairsContrib.dupes_skipped === 1, JSON.stringify(pairsContrib));

  const lines = readLines(ns);
  check('5.combined total on disk = sum of contributions', lines.length === (fileContrib.n_written + pairsContrib.n_written), `lines=${lines.length}`);
  check('5.combined n_written matches', res.n_written === lines.length, `n_written=${res.n_written} lines=${lines.length}`);
  // source_type preserved per pair (file vs pairs both present).
  const types = new Set(lines.map(p => p.source_type));
  check('5.combined source_type preserved per pair', types.has('file') && types.has('pairs'), [...types].join(','));

  // summarizeProvenance sanity.
  const summary = summarizeProvenance(lines);
  check('5.combined summarizeProvenance total matches', summary.total === lines.length, JSON.stringify(summary));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 6. validateProvenance fails on a pair missing source_type ---------------
{
  const bad = { id: 'x', input: 'q', output: 'a', ingested_at: new Date().toISOString(), source_ref: 'ref', provenance: { ingested_at: new Date().toISOString(), source_ref: 'ref' } };
  const v = validateProvenance(bad);
  check('6.validateProvenance fails when source_type missing', v.ok === false && v.missing.includes('source_type'), JSON.stringify(v));
  // And a complete pair passes.
  const good = (await readLines('smoke-describe'))[0];
  check('6.validateProvenance passes on a complete pair', validateProvenance(good).ok === true, JSON.stringify(good && validateProvenance(good)));
}

// =============================================================================
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('failures:');
  for (const f of failures) console.log('  - ' + f);
}

// Best-effort cleanup of the isolated dir.
try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }

process.exit(failed === 0 ? 0 : 1);
