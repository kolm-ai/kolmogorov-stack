// W701 - direct contract for src/forge-experts.js.
//
// Focus: local artifact path fencing for the public route, bounded router
// receipt parsing, deterministic digest envelopes, and ASCII-safe CLI bars.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import {
  DEFAULT_PRUNE_THRESHOLD,
  EXPERTS_CONTRACT_VERSION,
  EXPERTS_LIMITS,
  EXPERTS_VERSION,
  analyzeExperts,
  expertErrorStatus,
  normalizeArtifactPath,
  renderActivationBars,
  safeExpertError,
} from '../src/forge-experts.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HEX64_RE = /^[a-f0-9]{64}$/;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function freshDir(prefix = 'kolm-w701-forge-experts-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeArtifactDir(base, name = 'artifact') {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    job_id: 'job_moe',
    artifact_class: 'kolm',
    is_moe: true,
    moe: {
      experts: [
        { id: 'e0' },
        { id: 'e1' },
        { id: 'e2' },
        { id: 'e3' },
      ],
      top_k: 2,
    },
  }, null, 2));
  return dir;
}

function writeRouterLog(artifactDir, lines) {
  fs.writeFileSync(path.join(artifactDir, 'receipts', 'router.jsonl'), lines.join('\n') + '\n');
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('W701 source pins forge-experts safety limits, route fencing, and package wiring', () => {
  const source = read('src/forge-experts.js');
  const router = read('src/router.js');
  const pkg = readJson('package.json');

  assert.equal(EXPERTS_VERSION, 'forge-experts-v1');
  assert.equal(EXPERTS_CONTRACT_VERSION, 'w701-v1');
  assert.equal(DEFAULT_PRUNE_THRESHOLD, 0.01);
  assert.ok(EXPERTS_LIMITS.MAX_ROUTER_LOG_BYTES <= 2 * 1024 * 1024);
  assert.match(source, /normalizeArtifactPath/);
  assert.match(source, /MAX_ROUTER_LOG_LINES/);
  assert.match(source, /analysis_sha256/);
  assert.match(source, /safeExpertError/);
  assert.doesNotMatch(source, /[^\x00-\x7F]/);

  assert.match(router, /allowed_roots:\s*forgeExperts\.defaultAllowedArtifactRoots\(\)/);
  assert.match(router, /forgeExperts\.expertErrorStatus\(e\)/);
  assert.match(router, /forgeExperts\.safeExpertError\(e\)/);

  assert.equal(
    pkg.scripts['verify:forge-experts'],
    'node --test --test-concurrency=1 tests/wave701-forge-experts-contract.test.js',
  );
  assert.match(pkg.scripts['verify:depth'], /verify:forge-inspect && npm run verify:forge-experts && npm run verify:pattern-lake/);
});

test('W701 analyzeExperts parses bounded router receipts and emits a digest-backed envelope', async (t) => {
  const root = freshDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDir = writeArtifactDir(root);
  writeRouterLog(artifactDir, [
    JSON.stringify({ input_idx: 0, experts_activated: [0, 1] }),
    JSON.stringify({ input_idx: 1, experts_activated: [1, 3] }),
    JSON.stringify({ input_idx: 2, experts_activated: [1, '2', 99, -1, 1] }),
    '{not-json',
  ]);

  const analysis = await analyzeExperts(artifactDir, {
    allowed_root: root,
    threshold: 0.25,
  });

  assert.equal(analysis.is_moe, true);
  assert.equal(analysis.num_experts, 4);
  assert.equal(analysis.num_experts_per_tok, 2);
  assert.equal(analysis.total_decisions, 6);
  assert.deepEqual(analysis.expert_activations.map((row) => row.count), [1, 3, 1, 1]);
  assert.deepEqual(analysis.prune_candidates.map((row) => row.expert_id), [0, 2, 3]);
  assert.equal(analysis.router_decision_summary.malformed_lines, 1);
  assert.equal(analysis.router_decision_summary.skipped_out_of_range_ids, 1);
  assert.equal(analysis.router_decision_summary.skipped_invalid_ids, 1);
  assert.equal(analysis.router_decision_summary.skipped_duplicate_ids, 1);
  assert.equal(analysis.source, 'cached_router_decisions');
  assert.equal(analysis.contract_version, 'w701-v1');
  assert.match(analysis.analysis_sha256, HEX64_RE);
  assert.equal(JSON.stringify(analysis).includes(artifactDir), false);
});

test('W701 path, threshold, manifest, and router-log boundaries fail closed', async (t) => {
  const root = freshDir();
  const outsideRoot = freshDir('kolm-w701-outside-');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });
  const inside = writeArtifactDir(root, 'inside');
  const outside = writeArtifactDir(outsideRoot, 'outside');
  writeRouterLog(inside, [JSON.stringify({ experts_activated: [0, 1] })]);

  const normalized = normalizeArtifactPath(inside, { allowed_root: root });
  assert.equal(normalized.is_directory, true);

  await assert.rejects(
    () => analyzeExperts(outside, { allowed_root: root }),
    /experts_artifact_path_outside_allowed_root/,
  );
  await assert.rejects(
    () => analyzeExperts(inside, { allowed_root: root, threshold: 2 }),
    /experts_threshold_invalid/,
  );

  const huge = 'x'.repeat(128);
  writeRouterLog(inside, [huge]);
  await assert.rejects(
    () => analyzeExperts(inside, { allowed_root: root, max_router_log_bytes: 8 }),
    /experts_router_log_too_large/,
  );

  const err = new Error(`experts_artifact_path_outside_allowed_root: ${outside}`);
  assert.equal(safeExpertError(err), 'experts_artifact_path_outside_allowed_root');
  assert.equal(expertErrorStatus(err), 400);
});

test('W701 renderActivationBars is ASCII and clamps width', () => {
  const rendered = renderActivationBars({
    is_moe: true,
    expert_activations: [
      { expert_id: 0, pct: 100 },
      { expert_id: 1, pct: 25 },
    ],
    prune_candidates: [{ expert_id: 1 }],
  }, { width: 1000 });

  assert.doesNotMatch(rendered, /[^\x00-\x7F]/);
  assert.match(rendered, /Expert\s+0\s+#{80}\s+100\.0%/);
  assert.match(rendered, /Expert\s+1\s+#{20}-{60}\s+25\.0%  prune\?/);
});

test('W701 /v1/experts fences artifact roots and redacts filesystem paths', async (t) => {
  const allowedRoot = freshDir();
  const outsideRoot = freshDir('kolm-w701-route-outside-');
  t.after(() => {
    fs.rmSync(allowedRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });
  const previous = process.env.KOLM_EXPERTS_ARTIFACT_ROOT;
  t.after(() => {
    if (previous == null) delete process.env.KOLM_EXPERTS_ARTIFACT_ROOT;
    else process.env.KOLM_EXPERTS_ARTIFACT_ROOT = previous;
  });
  process.env.KOLM_EXPERTS_ARTIFACT_ROOT = allowedRoot;

  const inside = writeArtifactDir(allowedRoot, 'inside');
  writeRouterLog(inside, [JSON.stringify({ experts_activated: [0, 1] })]);
  const outside = writeArtifactDir(outsideRoot, 'outside');
  writeRouterLog(outside, [JSON.stringify({ experts_activated: [0, 1] })]);

  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(express.json());
  app.use(buildRouter());

  await withServer(app, async (base) => {
    const ok = await fetch(`${base}/v1/experts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_path: inside, threshold: 0.5 }),
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
    assert.equal(okBody.contract_version, 'w701-v1');
    assert.match(okBody.analysis_sha256, HEX64_RE);

    const blocked = await fetch(`${base}/v1/experts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_path: outside }),
    });
    assert.equal(blocked.status, 400);
    const text = await blocked.text();
    assert.equal(text.includes(outside), false);
    const body = JSON.parse(text);
    assert.deepEqual(body, {
      ok: false,
      error: 'experts_artifact_path_outside_allowed_root',
    });
  });
});
