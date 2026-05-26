// W815 — Active Learning Loop tests.
//
// One atomic test per contract. Anti-brittleness (W604):
//   - Never assert exact HTML byte counts; use regex + numeric threshold.
//   - Never write explicit-array family checks (wave family regex + min).
//
// Coverage:
//   W815-1  high-info-density scorer — components blend, importance pulled
//           from W711, weakness flag wired, novelty against cluster reference,
//           recency half-life.
//   W815-2  coverage-gap detector — bucketing, median floor, demand_proxy,
//           insufficient-captures envelope.
//   W815-3  recommend-next-capture — returns recommendations with the
//           dashboard-expected fields.
//   W815-4  feed-loop into W720 — event-store rows carry the expected
//           feedback flags.
//   W815-5  dashboard HTML exists + has the W815 coverage-gap slots.
//   W815-6  CLI sub-command `kolm active-learn --help` is wired.
//   W815-7  W775-unblock contract: exact exported signature.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as eventStore from '../src/event-store.js';
import * as kolmStore from '../src/store.js';

import {
  ACTIVE_LEARNING_VERSION,
  MIN_CAPTURES_FOR_GAPS,
  scoreCaptureRichness,
  detectCoverageGaps,
  recommendNextCaptures,
  feedToSelfImprovement,
  getCoverageGapsForNamespace,
  __internals,
} from '../src/active-learning.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

const W815_TENANTS = [
  'tenant_w815_a', 'tenant_w815_b', 'tenant_w815_c',
  'tenant_w815_d', 'tenant_w815_e', 'tenant_w815_f',
  'tenant_w815_g',
];

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w815-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (kolmStore._resetForTests) kolmStore._resetForTests();
  delete process.env.KOLM_TENANT_ID;
  return tmp;
}

// Generate a deterministic-but-spread synthetic capture corpus we can reuse
// across tests. We rotate among `nClusters` prompts so the bucket distribution
// is uneven (one cluster will dominate, others will be tiny — clear gaps).
function makeCorpus({ n = 60, nClusters = 6, weightFirst = 0.5 } = {}) {
  const prompts = [];
  for (let i = 0; i < nClusters; i++) {
    prompts.push(`prompt cluster ${i} alpha beta gamma`);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    // First N×weightFirst captures all land in cluster 0 (overrepresented);
    // the rest spread evenly across the remaining clusters (some under-rep'd).
    const idx = (i < Math.floor(n * weightFirst))
      ? 0
      : 1 + ((i - Math.floor(n * weightFirst)) % (nClusters - 1));
    out.push({
      capture_id: 'cap_' + i,
      namespace: 'ns_corpus',
      prompt: prompts[idx],
      response: 'a response with about ten tokens for token density math here',
      created_at: new Date(Date.now() - i * 60_000).toISOString(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// W815-1 — scorer
// ---------------------------------------------------------------------------

test('W815 #1 — scoreCaptureRichness returns {score, components, version} with all four signals', () => {
  const env = scoreCaptureRichness({
    prompt: 'short',
    response: 'a long response with several distinct unique tokens here please',
    created_at: new Date().toISOString(),
  });
  assert.equal(env.version, ACTIVE_LEARNING_VERSION);
  assert.ok(typeof env.score === 'number');
  assert.ok(env.score >= 0 && env.score <= 1);
  assert.ok(env.components && typeof env.components === 'object');
  for (const k of ['importance', 'weakness', 'novelty', 'recency']) {
    assert.ok(Object.prototype.hasOwnProperty.call(env.components, k),
      `score components missing ${k}`);
    assert.ok(env.components[k] >= 0 && env.components[k] <= 1,
      `component ${k} out of [0,1]: ${env.components[k]}`);
  }
});

test('W815 #2 — weakness_signal:true pulls component to 1.0; :false → 0.0; missing → 0.5', () => {
  const base = { prompt: 'x', response: 'y', created_at: new Date().toISOString() };
  const yes = scoreCaptureRichness({ ...base, weakness_signal: true });
  const no = scoreCaptureRichness({ ...base, weakness_signal: false });
  const missing = scoreCaptureRichness({ ...base });
  assert.equal(yes.components.weakness, 1.0);
  assert.equal(no.components.weakness, 0.0);
  assert.equal(missing.components.weakness, 0.5);
  // Score with weakness=true must be strictly greater than with weakness=false
  // (other signals equal).
  assert.ok(yes.score > no.score, `expected yes.score (${yes.score}) > no.score (${no.score})`);
});

test('W815 #3 — recency half-life — capture 7 days old scores ~0.5 freshness', () => {
  const nowMs = Date.now();
  const sevenDaysAgo = nowMs - __internals.RECENCY_HALFLIFE_MS;
  const r = __internals._recencyScore(sevenDaysAgo, nowMs);
  // 2^(-1) = 0.5 exactly.
  assert.ok(Math.abs(r - 0.5) < 1e-9, `recency at 7d should be 0.5, got ${r}`);
  // Missing timestamp → 0.5 neutral.
  assert.equal(__internals._recencyScore(undefined, nowMs), 0.5);
  // 14 days = 2 halflives = 0.25.
  const fourteenDaysAgo = nowMs - 2 * __internals.RECENCY_HALFLIFE_MS;
  const r2 = __internals._recencyScore(fourteenDaysAgo, nowMs);
  assert.ok(Math.abs(r2 - 0.25) < 1e-9);
});

test('W815 #4 — novelty against cluster reference: duplicate scores 0, novel scores 1', () => {
  const refShingles = __internals._ngramSet('foo bar baz qux quux corge', 3);
  // Same prompt → Jaccard=1 → novelty=0.
  const dup = scoreCaptureRichness(
    { prompt: 'foo bar baz qux quux corge', response: 'x' },
    { cluster_reference: refShingles },
  );
  assert.ok(dup.components.novelty < 0.01,
    `duplicate prompt expected novelty≈0, got ${dup.components.novelty}`);
  // Disjoint vocabulary → Jaccard=0 → novelty=1.
  const novel = scoreCaptureRichness(
    { prompt: 'completely different topic xyzzy plover plugh', response: 'x' },
    { cluster_reference: refShingles },
  );
  assert.ok(novel.components.novelty > 0.99,
    `disjoint prompt expected novelty≈1, got ${novel.components.novelty}`);
});

// ---------------------------------------------------------------------------
// W815-2 — coverage-gap detector
// ---------------------------------------------------------------------------

test('W815 #5 — insufficient captures returns honest envelope', () => {
  const env = detectCoverageGaps([{ prompt: 'one', response: 'two' }]);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'insufficient_captures_for_coverage');
  assert.equal(env.n, 1);
  assert.ok(typeof env.hint === 'string' && env.hint.length > 0);
  assert.equal(env.version, ACTIVE_LEARNING_VERSION);
});

test('W815 #6 — uneven bucket distribution surfaces gaps with positive gap_score', () => {
  const corpus = makeCorpus({ n: 60, nClusters: 6, weightFirst: 0.5 });
  // 30 captures land in cluster 0; remaining 30 split across 5 clusters (6 each).
  // Median bucket size is 6 (cluster 0 is the outlier; 5 buckets of 6).
  // Under-rep'd buckets: anything below cutoff (median × 0.5 = 3) is a gap;
  // with cluster sizes [30,6,6,6,6,6] we get NO gap — design the test to
  // surface a gap by making one cluster smaller. Drop a few captures from
  // one bucket so it falls below cutoff.
  // Drop all-but-one capture from one of the small clusters.
  const trimmed = corpus.filter((c, i) => {
    if (i < 30) return true; // keep cluster 0
    // keep only one capture from cluster 1
    if (c.prompt === 'prompt cluster 1 alpha beta gamma') {
      return i === 30; // first cluster-1 capture only
    }
    return true;
  });
  const env = detectCoverageGaps(trimmed);
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.gaps));
  // We expect at least one gap (the cluster trimmed to 1 capture vs median≈6).
  assert.ok(env.gaps.length >= 1, 'expected at least one gap; got ' + env.gaps.length);
  for (const g of env.gaps) {
    assert.ok(typeof g.cluster_id === 'string');
    assert.ok(g.gap_score > 0, 'gap_score must be positive; got ' + g.gap_score);
    assert.ok(g.recommended_count >= 1);
    assert.ok(g.current_count < env.median_bucket_size);
  }
});

test('W815 #7 — demand_proxy boosts gaps with production traffic', () => {
  const corpus = makeCorpus({ n: 60, nClusters: 6, weightFirst: 0.5 });
  // Trim two clusters down to 1 capture each so both are gaps with the SAME
  // shortfall, then pass a production_histogram that gives one bucket much
  // higher demand than the other.
  const trimmed = corpus.filter((c, i) => {
    if (i < 30) return true;
    if (c.prompt === 'prompt cluster 1 alpha beta gamma' && i !== 30) return false;
    if (c.prompt === 'prompt cluster 2 alpha beta gamma' && i !== 36) return false;
    return true;
  });
  // We don't know the actual hash-bucket key for each prompt without
  // running the bucketer; compute it.
  const k1 = __internals._bucketKey({ prompt: 'prompt cluster 1 alpha beta gamma' });
  const k2 = __internals._bucketKey({ prompt: 'prompt cluster 2 alpha beta gamma' });
  const env = detectCoverageGaps(trimmed, {
    production_histogram: { [k1]: 1000, [k2]: 1 },
  });
  assert.equal(env.ok, true);
  // The k1-bucket gap should have a much higher gap_score than the k2 gap.
  const g1 = env.gaps.find(g => g.cluster_id === k1);
  const g2 = env.gaps.find(g => g.cluster_id === k2);
  assert.ok(g1 && g2, 'both gap rows must be present');
  assert.ok(g1.gap_score > g2.gap_score,
    `demand_proxy must boost gap_score: g1=${g1.gap_score} g2=${g2.gap_score}`);
});

test('W815 #8 — production_histogram surfaces zero-capture cluster as a gap', () => {
  // Build a corpus with NO captures in cluster_zero but production demand.
  const captures = makeCorpus({ n: 50, nClusters: 5, weightFirst: 0.4 });
  // production demand for a cluster that has zero captures
  const env = detectCoverageGaps(captures, {
    production_histogram: { cluster_zero_nowhere: 500 },
  });
  assert.equal(env.ok, true);
  const z = env.gaps.find((g) => g.cluster_id === 'cluster_zero_nowhere');
  assert.ok(z, 'zero-capture but high-demand bucket must surface as a gap');
  assert.equal(z.current_count, 0);
  assert.ok(z.gap_score > 0);
});

// ---------------------------------------------------------------------------
// W815-3 — recommendation surface
// ---------------------------------------------------------------------------

test('W815 #9 — recommendNextCaptures returns dashboard-shaped recommendations', async () => {
  freshDir();
  const tenant = 'tenant_w815_a';
  const namespace = 'ns_recs';
  // Seed enough events for the coverage analysis.
  for (let i = 0; i < 40; i++) {
    // Skew distribution so we get real gaps.
    const cluster = i < 30 ? 'alpha alpha alpha' : 'beta beta beta';
    await eventStore.appendEvent({
      tenant_id: tenant,
      namespace,
      provider: 'openai',
      model: 'gpt-4',
      status: 'ok',
      prompt_redacted: `${cluster} extra prompt token ${i}`,
      prompt_tokens: 5,
      completion_tokens: 10,
    });
  }
  const env = await recommendNextCaptures(tenant, namespace, { top_k: 5 });
  assert.equal(env.ok, true);
  assert.equal(env.namespace, namespace);
  assert.equal(env.version, ACTIVE_LEARNING_VERSION);
  assert.ok(Array.isArray(env.recommendations));
  for (const r of env.recommendations) {
    for (const k of ['topic_cluster', 'gap_score', 'recommended_count', 'capture_template']) {
      assert.ok(Object.prototype.hasOwnProperty.call(r, k),
        `recommendation missing key ${k}`);
    }
    assert.ok(typeof r.capture_template === 'string' && r.capture_template.length > 0);
  }
});

test('W815 #10 — recommendNextCaptures refuses without tenant_id', async () => {
  const env = await recommendNextCaptures(null, 'ns');
  assert.equal(env.ok, false);
  assert.equal(env.error, 'missing_tenant_id');
  assert.equal(env.version, ACTIVE_LEARNING_VERSION);
});

// ---------------------------------------------------------------------------
// W815-4 — feed-loop into W720
// ---------------------------------------------------------------------------

test('W815 #11 — feedToSelfImprovement writes event-store rows with active_learning_gap:true', async () => {
  freshDir();
  const tenant = 'tenant_w815_b';
  const namespace = 'ns_feed';
  const gaps = [
    { cluster_id: 'cluster_alpha', gap_score: 0.9, recommended_count: 5 },
    { cluster_id: 'cluster_beta', gap_score: 0.7, recommended_count: 3 },
  ];
  const env = await feedToSelfImprovement(tenant, namespace, gaps);
  assert.equal(env.ok, true);
  assert.equal(env.written, 2);
  assert.equal(env.attempted, 2);

  // Verify the rows landed in the event-store with the expected feedback shape.
  const rows = await eventStore.listEvents({ tenant_id: tenant, namespace });
  const gapRows = rows.filter((r) => {
    if (!r.feedback) return false;
    try {
      const fb = JSON.parse(r.feedback);
      return fb && fb.kind === 'active_learning_gap';
    } catch (_) { return false; }
  });
  assert.equal(gapRows.length, 2);
  for (const r of gapRows) {
    const fb = JSON.parse(r.feedback);
    assert.equal(fb.capture_candidate, true);
    assert.equal(fb.weakness_signal, false);
    assert.equal(fb.active_learning_gap, true);
    assert.equal(fb.version, ACTIVE_LEARNING_VERSION);
  }
});

test('W815 #12 — feedToSelfImprovement honest envelope on missing tenant_id', async () => {
  const env = await feedToSelfImprovement(null, 'ns', [{ cluster_id: 'x' }]);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'missing_tenant_id');
  assert.equal(env.version, ACTIVE_LEARNING_VERSION);
});

// ---------------------------------------------------------------------------
// W815-5 — dashboard HTML
// ---------------------------------------------------------------------------

test('W815 #13 — /account/active-learning.html ships with the coverage-gap slots', () => {
  const p = path.join(process.cwd(), 'public', 'account', 'active-learning.html');
  assert.ok(fs.existsSync(p), 'public/account/active-learning.html must exist');
  const html = fs.readFileSync(p, 'utf8');
  // Regex-with-threshold lock-ins, never byte counts.
  assert.ok(/coverage[ -]gap/i.test(html), 'must mention coverage-gap');
  assert.ok(/recommend/i.test(html), 'must surface "recommend" text');
  assert.ok(/(w815|active.learning.loop)/i.test(html), 'must mark the wave/contract');
  // ks- scaffold classes reused for visual consistency.
  const ksClassMatches = html.match(/class="ks[\w-]*"|ks-nav|ks-footer/g) || [];
  assert.ok(ksClassMatches.length >= 5, 'should reuse ks- scaffold (got ' + ksClassMatches.length + ')');
});

test('W815 #14 — vercel.json rewrites /account/active-learning to the HTML', () => {
  const p = path.join(process.cwd(), 'vercel.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rewrites = cfg.rewrites || [];
  const hit = rewrites.find((r) => r && r.source === '/account/active-learning'
    && r.destination === '/account/active-learning.html');
  assert.ok(hit, 'vercel.json must include {/account/active-learning → .html}');
});

// ---------------------------------------------------------------------------
// W815-6 — CLI sub-command
// ---------------------------------------------------------------------------

test('W815 #15 — kolm active-learn --help responds with the W815 usage', () => {
  const r = spawnSync(process.execPath, [CLI_PATH, 'active-learn', '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  // Either exit 0 with usage to stdout, or exit 2 with usage to stderr — both
  // are acceptable wirings as long as the W815 usage text shows up.
  const combined = (r.stdout || '') + (r.stderr || '');
  assert.ok(/active-learn/i.test(combined),
    'help output must mention active-learn; got: ' + combined.slice(0, 400));
  assert.ok(/namespace|--top|gap/i.test(combined),
    'help should describe namespace/top/gap flags; got: ' + combined.slice(0, 400));
});

test('W815 #16 — kolm active-learn (no auth) returns honest auth_required envelope under --json', () => {
  // Run from an isolated HOME so the user's local config can't surface.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w815-cli-'));
  const r = spawnSync(process.execPath, [CLI_PATH, 'active-learn', '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmp,
      USERPROFILE: tmp,
      KOLM_DATA_DIR: path.join(tmp, '.kolm'),
      KOLM_API_KEY: '',
      KOLM_TENANT_ID: '',
    },
  });
  // We expect a JSON envelope (ok:false, error:'auth_required') OR if the
  // CLI doesn't gate on auth (uses local-only data) an ok:true with empty
  // recommendations. EITHER WAY the output is valid JSON.
  const out = (r.stdout || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (_) {} // deliberate: cleanup
  assert.ok(parsed && typeof parsed === 'object',
    'expected JSON envelope; got stdout=' + out.slice(0, 200) + ' stderr=' + (r.stderr || '').slice(0, 200));
  // version is stamped on every active-learning envelope.
  if (parsed.version) {
    assert.equal(parsed.version, ACTIVE_LEARNING_VERSION);
  }
});

// ---------------------------------------------------------------------------
// W815-7 — W775-unblock contract (LOAD-BEARING signature)
// ---------------------------------------------------------------------------

test('W815 #17 — getCoverageGapsForNamespace exact exported signature', async () => {
  // The W775 daemon imports this exact name from src/active-learning.js
  // and destructures {ok, gaps, computed_at}. Any rename or shape change
  // BREAKS the killer-feature contract.
  assert.equal(typeof getCoverageGapsForNamespace, 'function');
  assert.equal(getCoverageGapsForNamespace.name, 'getCoverageGapsForNamespace');

  freshDir();
  // Missing tenant_id → honest envelope.
  const noTenant = await getCoverageGapsForNamespace('ns');
  assert.equal(noTenant.ok, false);
  assert.equal(noTenant.error, 'missing_tenant_id');
  assert.equal(noTenant.version, ACTIVE_LEARNING_VERSION);
  assert.ok(typeof noTenant.computed_at === 'string');
  // ISO 8601 timestamp shape.
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(noTenant.computed_at));
});

test('W815 #18 — getCoverageGapsForNamespace insufficient_captures envelope', async () => {
  freshDir();
  const tenant = 'tenant_w815_c';
  // Seed only ONE capture — well under MIN_CAPTURES_FOR_GAPS.
  await eventStore.appendEvent({
    tenant_id: tenant,
    namespace: 'ns_thin',
    provider: 'openai',
    model: 'gpt-4',
    status: 'ok',
    prompt_redacted: 'lone prompt',
  });
  const env = await getCoverageGapsForNamespace('ns_thin', { tenant_id: tenant });
  assert.equal(env.ok, false);
  assert.equal(env.error, 'insufficient_captures_for_coverage');
  assert.equal(env.n, 1);
  assert.equal(env.version, ACTIVE_LEARNING_VERSION);
  assert.ok(typeof env.hint === 'string' && env.hint.length > 0);
  assert.ok(typeof env.computed_at === 'string');
});

test('W815 #19 — getCoverageGapsForNamespace ok:true returns gaps with the required keys', async () => {
  freshDir();
  const tenant = 'tenant_w815_d';
  const namespace = 'ns_full';
  // Seed >MIN_CAPTURES_FOR_GAPS captures with a skewed bucket distribution.
  for (let i = 0; i < 40; i++) {
    const cluster = i < 30 ? 'alpha alpha alpha' : 'beta beta beta';
    await eventStore.appendEvent({
      tenant_id: tenant,
      namespace,
      provider: 'openai',
      model: 'gpt-4',
      status: 'ok',
      prompt_redacted: `${cluster} prompt body ${i}`,
    });
  }
  const env = await getCoverageGapsForNamespace(namespace, {
    tenant_id: tenant, top_k: 3,
  });
  assert.equal(env.ok, true);
  assert.equal(env.version, ACTIVE_LEARNING_VERSION);
  assert.ok(typeof env.computed_at === 'string');
  assert.ok(Array.isArray(env.gaps));
  // Every gap MUST carry the three load-bearing keys.
  for (const g of env.gaps) {
    assert.ok(typeof g.cluster_id === 'string', 'cluster_id missing');
    assert.ok(typeof g.gap_score === 'number', 'gap_score missing');
    assert.ok(typeof g.recommended_count === 'number', 'recommended_count missing');
  }
});

test('W815 #20 — getCoverageGapsForNamespace honors opts.min_captures override', async () => {
  freshDir();
  const tenant = 'tenant_w815_e';
  const namespace = 'ns_lowbar';
  // Seed just 5 captures across 2 clusters.
  for (let i = 0; i < 5; i++) {
    const cluster = i < 3 ? 'gamma gamma gamma' : 'delta delta delta';
    await eventStore.appendEvent({
      tenant_id: tenant,
      namespace,
      provider: 'openai',
      model: 'gpt-4',
      status: 'ok',
      prompt_redacted: `${cluster} prompt ${i}`,
    });
  }
  // Default min_captures (30) → insufficient.
  const def = await getCoverageGapsForNamespace(namespace, { tenant_id: tenant });
  assert.equal(def.ok, false);
  assert.equal(def.error, 'insufficient_captures_for_coverage');
  // Override min_captures to 3 → ok:true.
  const ovr = await getCoverageGapsForNamespace(namespace, {
    tenant_id: tenant, min_captures: 3,
  });
  assert.equal(ovr.ok, true);
  assert.ok(Array.isArray(ovr.gaps));
});

test('W815 #21 — tenant fence: foreign-tenant captures never surface in gaps', async () => {
  freshDir();
  const owner = 'tenant_w815_f';
  const foreign = 'tenant_w815_g';
  const namespace = 'ns_fenced';
  // Seed 40 owner captures.
  for (let i = 0; i < 40; i++) {
    await eventStore.appendEvent({
      tenant_id: owner,
      namespace,
      provider: 'openai',
      model: 'gpt-4',
      status: 'ok',
      prompt_redacted: 'owner cluster prompt ' + i,
    });
  }
  // Seed 100 foreign captures in the SAME namespace.
  for (let i = 0; i < 100; i++) {
    await eventStore.appendEvent({
      tenant_id: foreign,
      namespace,
      provider: 'openai',
      model: 'gpt-4',
      status: 'ok',
      prompt_redacted: 'foreign cluster prompt ' + i,
    });
  }
  // Owner reads owner's view — must not see foreign rows.
  const env = await getCoverageGapsForNamespace(namespace, { tenant_id: owner });
  assert.equal(env.ok, true);
  assert.equal(env.n, 40, 'owner must only see their own 40 captures');
});

// ---------------------------------------------------------------------------
// Version + module metadata
// ---------------------------------------------------------------------------

test('W815 #22 — module version + MIN_CAPTURES_FOR_GAPS constants', () => {
  assert.equal(ACTIVE_LEARNING_VERSION, 'w815-v1');
  assert.equal(MIN_CAPTURES_FOR_GAPS, 30);
});
