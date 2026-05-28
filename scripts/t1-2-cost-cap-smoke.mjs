#!/usr/bin/env node
// scripts/t1-2-cost-cap-smoke.mjs
//
// T1.2 smoke test — verifies cost-preview + KOLM_MAX_USD cap end-to-end:
//
//   1. estimateBatchCost({trinity teachers}) — math sanity (Claude 800 +
//      GPT-4o 600 + local 600). Local rows must contribute $0.
//   2. estimateBatchCost on unknown vendor:model -> unknown_models has the slug
//   3. estimateCallCost — single-call estimator returns >0 for cloud, 0 for local
//   4. CLI: kolm distill --recipe trinity-2000 --dry-run --json — envelope
//      contains an `estimate.total_usd` matching #1
//   5. CLI: KOLM_MAX_USD=0.01 kolm distill --recipe trinity-2000 (non-dry-run)
//      — exits non-zero, stderr names KOLM_MAX_USD
//   6. CLI: KOLM_MAX_USD=999 kolm distill --recipe trinity-2000 --dry-run --json
//      — under cap, exits 0
//   7. Worker mid-run cap — start the worker with KOLM_MAX_USD=0.0001 against
//      a mock-cloud teacher and 3 rows; the manifest must record cap_tripped_at_row >= 1
//      and the run must NOT spawn all 3 calls.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { estimateBatchCost, estimateCallCost } from '../src/cost-estimator.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(_here, '..');
const KOLM = path.join(REPO, 'cli', 'kolm.js');
const WORKER = path.join(REPO, 'workers', 'distill', 'distill.mjs');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ok   ${label}`); }
function bad(label, detail) { fail++; console.log(`  FAIL ${label}: ${detail}`); }
function assert(cond, label, detail = '') {
  if (cond) ok(label); else bad(label, detail || 'condition false');
}

console.log('T1.2 — cost preview + KOLM_MAX_USD cap smoke');

// --- 1. trinity estimator math ----------------------------------------------
const trinityTeachers = [
  { slug: 'anthropic:claude-sonnet-4-6', rows: 800 },
  { slug: 'openai:gpt-4o',               rows: 600 },
  { slug: 'kolm:deepseek-r1-distill-qwen-32b', rows: 600 },
];
const est1 = estimateBatchCost({ teachers: trinityTeachers });
// Claude: 800 rows * 256 in tokens * $0.003/1k + 800 * 384 out * $0.015/1k
//       = 800 * (0.256 * 0.003 + 0.384 * 0.015)
//       = 800 * (0.000768 + 0.00576) = 800 * 0.006528 = $5.2224
// GPT-4o: 600 * 256 * 0.0025/1k + 600 * 384 * 0.010/1k
//       = 600 * (0.000640 + 0.00384) = 600 * 0.004480 = $2.6880
// local: $0
// total ≈ $7.9104
assert(est1.total_usd >= 7.5 && est1.total_usd <= 8.5,
  '1: trinity total in expected band ($7.5-$8.5)', `got ${est1.total_usd}`);
const claudeEntry = est1.per_teacher.find((t) => t.slug.startsWith('anthropic:'));
assert(claudeEntry && claudeEntry.est_usd > 0, '1: claude row has positive cost');
const localEntry = est1.per_teacher.find((t) => t.vendor === 'kolm');
assert(localEntry && localEntry.est_usd === 0, '1: local vendor contributes $0', `got ${localEntry?.est_usd}`);
assert(est1.unknown_models.length === 0, '1: no unknown models for trinity recipe');

// --- 2. unknown model handling -----------------------------------------------
const est2 = estimateBatchCost({
  teachers: [{ slug: 'openai:made-up-model-9000', rows: 100 }],
});
assert(est2.unknown_models.includes('openai:made-up-model-9000'),
  '2: unknown model surfaced in unknown_models');
assert(est2.per_teacher[0].unknown_price === true,
  '2: per_teacher entry has unknown_price=true');

// --- 3. per-call estimator ---------------------------------------------------
const callCloud = estimateCallCost({
  vendor: 'anthropic', model: 'claude-sonnet-4-6',
  input_chars: 1000, response_chars: 1500,
});
assert(callCloud > 0, '3: cloud call estimate > 0', `got ${callCloud}`);
const callLocal = estimateCallCost({
  vendor: 'local', model: 'deepseek-r1',
  input_chars: 1000, response_chars: 1500,
});
assert(callLocal === 0, '3: local call estimate = 0', `got ${callLocal}`);

// --- 4. CLI dry-run JSON envelope --------------------------------------------
const r4 = spawnSync(process.execPath, [KOLM, 'distill', '--recipe', 'trinity-2000', '--dry-run', '--json'], { encoding: 'utf8' });
assert(r4.status === 0, '4: CLI --dry-run --json exit 0', `status=${r4.status}`);
const jsonStart = (r4.stdout || '').indexOf('{');
let envelope = null;
try { envelope = JSON.parse((r4.stdout || '').slice(jsonStart)); } catch { /* leave null */ }
assert(envelope?.estimate?.total_usd > 0, '4: envelope.estimate.total_usd > 0', `got ${envelope?.estimate?.total_usd}`);
assert(Math.abs((envelope?.estimate?.total_usd || 0) - est1.total_usd) < 0.01,
  '4: CLI estimate matches programmatic estimate',
  `cli=${envelope?.estimate?.total_usd} prog=${est1.total_usd}`);

// --- 5. CLI cap below estimate (non-dry-run) ---------------------------------
// Use a cap of $0.01 — trinity estimate is ~$8 so this must fail-closed.
const r5 = spawnSync(process.execPath, [KOLM, 'distill', '--recipe', 'trinity-2000'], {
  encoding: 'utf8',
  env: { ...process.env, KOLM_MAX_USD: '0.01' },
});
assert(r5.status !== 0, '5: CLI exits non-zero when estimate > cap', `status=${r5.status}`);
assert(/KOLM_MAX_USD/.test(r5.stderr || ''), '5: stderr names KOLM_MAX_USD', r5.stderr?.slice(0, 200));

// --- 6. CLI cap above estimate (dry-run) -------------------------------------
const r6 = spawnSync(process.execPath, [KOLM, 'distill', '--recipe', 'trinity-2000', '--dry-run', '--json'], {
  encoding: 'utf8',
  env: { ...process.env, KOLM_MAX_USD: '999' },
});
assert(r6.status === 0, '6: CLI under cap exit 0', `status=${r6.status}`);
assert(/cap:\s+\$999\.00/.test(r6.stdout || ''), '6: stdout prints cap');

// --- 7. worker in-loop cap ---------------------------------------------------
// Stand up a tiny mock-OpenAI server that returns a verbose response so
// the per-call cost estimate is high enough that 1 call > $0.0001 cap.
// Mock vendor = openai; with input ~ 1500 chars + response ~ 3000 chars,
// per-call estimate ~= 0.375 * 0.0025 + 0.75 * 0.010 = ~$0.0084 — comfortably
// above $0.0001. Cap should trip after row 1.
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}
const port = await freePort();
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'mock-' + Math.random().toString(36).slice(2),
      object: 'chat.completion',
      choices: [{
        message: {
          role: 'assistant',
          content: 'Sure, I can help. ' + 'verbose response '.repeat(180),
        },
      }],
    }));
  });
});
await new Promise((r) => mock.listen(port, '127.0.0.1', r));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-t1-2-'));
const seedsPath = path.join(tmpDir, 'seeds.jsonl');
const specPath = path.join(tmpDir, 'spec.json');
const outDir = path.join(tmpDir, 'out');
fs.mkdirSync(outDir, { recursive: true });
// 3 seeds so the cap should trip well before the last
const seeds = [
  { id: 'r1', input: 'I need a refund for order 12345. ' + 'extra prompt text '.repeat(60), output: '' },
  { id: 'r2', input: 'When will my order ship? ' + 'extra prompt text '.repeat(60), output: '' },
  { id: 'r3', input: 'My account is locked. ' + 'extra prompt text '.repeat(60), output: '' },
];
fs.writeFileSync(seedsPath, seeds.map((s) => JSON.stringify(s)).join('\n') + '\n');
fs.writeFileSync(specPath, JSON.stringify({ job_id: 'jt12cap', system: 'be brief' }));

await new Promise((resolve) => {
  const child = spawn(process.execPath, [
    WORKER,
    '--mode=collect',
    `--spec=${specPath}`,
    `--seeds=${seedsPath}`,
    `--out=${outDir}`,
    '--teacher=openai:gpt-4o',
    '--max-rows=3',
    '--no-preflight',
    '--no-holdout-split',
  ], {
    env: {
      ...process.env,
      KOLM_MAX_USD: '0.0001',                   // tiny cap, must trip after row 1
      OPENAI_API_KEY: 'sk-mock-test-key',       // bypass missing-key guard
      KOLM_UPSTREAM_OPENAI_BASE: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.on('exit', () => {
    if (process.env.T1_2_VERBOSE) {
      console.log('--- worker stdout ---'); console.log(stdout);
      console.log('--- worker stderr ---'); console.log(stderr);
    }
    resolve();
  });
});
mock.close();

const manifestPath = path.join(outDir, 'manifest.json');
assert(fs.existsSync(manifestPath), '7: worker wrote manifest');
let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* leave null */ }
assert(manifest, '7: manifest is valid JSON');
assert(manifest?.cost_cap_usd === 0.0001, '7: manifest records cost_cap_usd', `got ${manifest?.cost_cap_usd}`);
assert(manifest?.cap_tripped_at_row >= 1, '7: cap_tripped_at_row >= 1', `got ${manifest?.cap_tripped_at_row}`);
assert(manifest?.training_pairs_collected < 3,
  '7: collected fewer rows than max because of cap',
  `got ${manifest?.training_pairs_collected}`);
assert(manifest?.cumulative_usd_estimated >= 0.0001,
  '7: cumulative usd estimate reached/exceeded cap',
  `got ${manifest?.cumulative_usd_estimated}`);

// cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
