#!/usr/bin/env node
// scripts/t1-3-resume-smoke.mjs
//
// T1.3 smoke test — content-hash resume in workers/distill/distill.mjs.
//
// What it proves:
//   1. First run collects N rows, writes pairs-index.json sidecar.
//   2. Second run with --resume + the SAME seeds skips all N (no teacher hits).
//   3. Third run with --resume + a mutated seeds file (1 row changed)
//      re-collects ONLY the changed row (content-hash distinguishes them).
//   4. Backfill: deleting pairs-index.json + resuming still skips the
//      previously-collected rows by retroactively hashing them.
//
// Uses a tiny mock teacher HTTP server (no real API spend).
// IMPORTANT: uses async spawn (not spawnSync) so the parent's event loop
// stays free to serve the mock HTTP requests the child worker makes.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]):/, '$1:'));
const WORKER = path.join(REPO, 'workers', 'distill', 'distill.mjs');

const TMP = path.join(os.tmpdir(), `kolm-t1-3-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
fs.mkdirSync(TMP, { recursive: true });
const OUT = path.join(TMP, 'out');
fs.mkdirSync(OUT, { recursive: true });

const SPEC_PATH = path.join(TMP, 'spec.json');
const SEEDS_PATH = path.join(TMP, 'seeds.jsonl');

fs.writeFileSync(SPEC_PATH, JSON.stringify({
  spec_version: 't1-3-smoke',
  student_base: 'Qwen/Qwen2.5-0.5B-Instruct',
  system: 'You are a smoke-test teacher.',
}, null, 2));

function writeSeeds(rows) {
  fs.writeFileSync(SEEDS_PATH, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const SEEDS_V1 = [
  { id: 'r1', input: 'what is 1+1?', output: '2' },
  { id: 'r2', input: 'what is 2+2?', output: '4' },
  { id: 'r3', input: 'what is 3+3?', output: '6' },
  { id: 'r4', input: 'what is 4+4?', output: '8' },
  { id: 'r5', input: 'what is 5+5?', output: '10' },
];
writeSeeds(SEEDS_V1);

let teacherHits = 0;
const seenInputs = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    teacherHits++;
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const userMsg = (parsed.messages || []).find((m) => m.role === 'user');
    const inputText = userMsg ? userMsg.content : '';
    seenInputs.push(inputText);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: `mock-answer-for: ${inputText}` } }],
    }));
  });
});

function runWorker(extraArgs) {
  return new Promise((resolve) => {
    const argv = [
      WORKER,
      '--spec', SPEC_PATH,
      '--seeds', SEEDS_PATH,
      '--out', OUT,
      '--mode', 'collect',
      '--teacher', 'local:mock-model',
      '--local-endpoint', `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      '--local-api-key', 'sk-test',
      '--max-rows', '5',
      '--no-redact',
      '--no-holdout-split',
      ...extraArgs,
    ];
    const proc = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c) => stdout += c);
    proc.stderr.on('data', (c) => stderr += c);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function countPairsRows() {
  const p = path.join(OUT, 'training-pairs.jsonl');
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length;
}

function readSidecar() {
  const p = path.join(OUT, 'pairs-index.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL  ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${msg}`);
  }
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.log(`[t1-3] mock teacher listening on 127.0.0.1:${server.address().port}`);

  // RUN 1
  console.log('\n[run 1] fresh collect of 5 rows');
  teacherHits = 0;
  const r1 = await runWorker([]);
  // Windows libuv has a known shutdown-time assertion (UV_HANDLE_CLOSING in
  // async.c:76) that can flip exit code to non-zero on otherwise-successful
  // runs. Verify by artifact state instead of exit code.
  assert(countPairsRows() === 5, 'after run 1, training-pairs.jsonl has 5 rows');
  assert(teacherHits === 5, `after run 1, teacher was hit exactly 5 times (got ${teacherHits})`);
  const sc1 = readSidecar();
  assert(sc1 && Array.isArray(sc1.pair_hashes) && sc1.pair_hashes.length === 5,
    'pairs-index.json has 5 pair_hashes');

  // RUN 2
  console.log('\n[run 2] resume with same seeds — should skip all 5');
  teacherHits = 0;
  await runWorker(['--resume']);
  assert(teacherHits === 0, `after resume w/ same seeds, teacher was hit 0 times (got ${teacherHits})`);
  assert(countPairsRows() === 5, 'after run 2, still 5 rows (no duplicates)');

  // RUN 3 — backfill
  console.log('\n[run 3] delete sidecar, resume — should backfill from training-pairs.jsonl');
  fs.unlinkSync(path.join(OUT, 'pairs-index.json'));
  teacherHits = 0;
  await runWorker(['--resume']);
  assert(teacherHits === 0, `after backfill resume, teacher was hit 0 times (got ${teacherHits})`);
  assert(readSidecar() !== null, 'sidecar was rebuilt after backfill');

  // RUN 4 — mutate
  console.log('\n[run 4] mutate r3 input, resume — should re-collect only r3');
  const SEEDS_V2 = JSON.parse(JSON.stringify(SEEDS_V1));
  SEEDS_V2[2].input = 'what is 3 times 3?';
  writeSeeds(SEEDS_V2);
  teacherHits = 0;
  seenInputs.length = 0;
  await runWorker(['--resume']);
  assert(teacherHits === 1, `after mutation, teacher was hit exactly 1 time (got ${teacherHits})`);
  assert(seenInputs[0] && seenInputs[0].includes('3 times 3'),
    `the one teacher hit was for the mutated input (got: ${JSON.stringify(seenInputs[0])})`);
  assert(countPairsRows() === 6, `training-pairs.jsonl now has 6 rows (5 originals + 1 new)`);

  server.close();
  if (process.exitCode === 1) {
    console.error(`\n[t1-3] FAILED — fixture preserved at: ${TMP}`);
    process.exit(1);
  } else {
    console.log(`\n[t1-3] all checks passed`);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e); server.close(); process.exit(2);
});
