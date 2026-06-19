// Wave 608: turn the semantic routing flywheel on.
//
// W921 shipped the scorer and route-quality store, but live dispatch still
// passed stats:null. These checks pin the bridge: trained namespace snapshots
// load into ClusterRouterStats, live outcomes persist, and the CLI can create
// the snapshot the gateway consumes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClusterRouterStats } from '../src/semantic-router.js';
import { recordRouteOutcome, getClusterQualityStats } from '../src/route-quality-store.js';
import {
  clearRouteStatsCacheForTests,
  loadRouteStatsForNamespace,
  recordRouteOutcomeFromDispatch,
} from '../src/route-training.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

async function withSandbox(body) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w608-route-'));
  const prev = {
    data: process.env.KOLM_DATA_DIR,
    home: process.env.HOME,
    user: process.env.USERPROFILE,
    storePath: process.env.KOLM_EVENT_STORE_PATH,
    cacheMs: process.env.KOLM_ROUTE_STATS_CACHE_MS,
  };
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ROUTE_STATS_CACHE_MS = '0';
  delete process.env.KOLM_EVENT_STORE_PATH;
  let es = null;
  try {
    es = await import('../src/event-store.js');
    if (typeof es._resetForTests === 'function') es._resetForTests();
    clearRouteStatsCacheForTests();
    return await body();
  } finally {
    clearRouteStatsCacheForTests();
    if (es && typeof es._resetForTests === 'function') {
      try { es._resetForTests(); } catch {}
    }
    if (prev.data === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = prev.data;
    if (prev.home === undefined) delete process.env.HOME; else process.env.HOME = prev.home;
    if (prev.user === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.user;
    if (prev.storePath === undefined) delete process.env.KOLM_EVENT_STORE_PATH; else process.env.KOLM_EVENT_STORE_PATH = prev.storePath;
    if (prev.cacheMs === undefined) delete process.env.KOLM_ROUTE_STATS_CACHE_MS; else process.env.KOLM_ROUTE_STATS_CACHE_MS = prev.cacheMs;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function unitVec(i, dim = 256) {
  const v = new Array(dim).fill(0);
  v[i] = 1;
  return v;
}

test('1. loadRouteStatsForNamespace grafts live quality outcomes onto trained centroids', async () => {
  await withSandbox(async () => {
    const tenant = 'tenant_w608';
    const namespace = 'support';
    await recordRouteOutcome({
      tenant, namespace, cluster_id: 0, model: 'gpt-4o-mini', provider: 'openai',
      realized_quality: 0.91, cost: 0.001, latency_ms: 40, now: 1,
    });
    await recordRouteOutcome({
      tenant, namespace, cluster_id: 0, model: 'claude-opus-4-7', provider: 'anthropic',
      realized_quality: 0.93, cost: 0.05, latency_ms: 200, now: 2,
    });

    const snapshot = {
      version: 'w921-v1',
      k: 1,
      dim: 256,
      centroids: [unitVec(0)],
      counts: [2],
      stats: {},
    };
    const loaded = await loadRouteStatsForNamespace({
      tenant,
      namespace,
      namespaceConfig: { route_stats_snapshot: snapshot, updated_at: 't1' },
      candidates: [
        { provider: 'openai', model: 'gpt-4o-mini' },
        { provider: 'anthropic', model: 'claude-opus-4-7' },
      ],
    });

    assert.ok(loaded.stats instanceof ClusterRouterStats);
    assert.equal(loaded.route_quality_outcomes, 2);
    const mini = loaded.stats._aggregate([0], 'gpt-4o-mini');
    const opus = loaded.stats._aggregate([0], 'claude-opus-4-7');
    assert.equal(mini.n, 1);
    assert.equal(opus.n, 1);
    assert.equal(mini.wins, 1);
    assert.ok(Math.abs(mini.avg_cost - 0.001) < 1e-9);
    assert.ok(Math.abs(opus.avg_latency - 200) < 1e-9);
  });
});

test('2. recordRouteOutcomeFromDispatch persists the final dispatch attempt for the flywheel', async () => {
  await withSandbox(async () => {
    const tenant = 'tenant_w608_record';
    const namespace = 'support';
    const out = await recordRouteOutcomeFromDispatch({
      tenant,
      namespace,
      routerDecision: { cluster_id: 3 },
      result: { ok: true, status: 200, provider: 'openai', attempt: 1 },
      attemptedEntry: { provider: 'openai', model: 'gpt-4o-mini' },
      prompt_text: 'reset my password',
      cost: 0.002,
      latency_ms: 55,
      receipt_id: 'rcpt_1',
      now: 3,
    });
    assert.equal(out.ok, true);
    const stats = await getClusterQualityStats({ tenant, namespace });
    assert.equal(stats.n, 1);
    assert.equal(stats.by_cluster_model[3]['gpt-4o-mini'].wins, 1);
    assert.equal(stats.by_cluster_model[3]['gpt-4o-mini'].mean_latency, 55);
  });
});

test('3. gateway dispatch loads route stats and records route outcomes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');
  assert.match(src, /await import\('\.\/route-training\.js'\)/);
  assert.match(src, /loadRouteStatsForNamespace\(\{/);
  assert.match(src, /stats:\s*_trained && _trained\.stats \? _trained\.stats : null/);
  assert.match(src, /recordRouteOutcomeFromDispatch\(\{/);
  assert.match(src, /receipt_id:\s*receipt\.receipt_id/);
});

test('4. route train CLI persists the namespace snapshot consumed by dispatch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.match(src, /sub === 'train'/);
  assert.match(src, /cmdRouteTrain/);
  assert.match(src, /buildRouteTrainingSnapshot\(\{/);
  assert.match(src, /persistRouteTrainingSnapshot\(\{/);
  assert.match(src, /--activate/);
  assert.match(src, /startsWith\(name \+ '='/);
});

test('5. backend spec records W608 live-loop closure and W991 calibrated quality closure', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');
  assert.match(spec, /W608/);
  assert.match(spec, /Load trained ClusterRouterStats/);
  assert.match(spec, /CLOSED W991/);
  assert.match(spec, /calibrated 'meets-bar' threshold/);
});
