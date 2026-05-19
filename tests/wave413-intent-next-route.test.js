// W413 — surface the W412 `kolm next` recommender on the post-auth dashboard.
//
// Two contracts:
//   (1) GET /v1/intent/next is auth-gated, returns {ok, recommendations,
//       generated_at, snapshot_summary} envelope.
//   (2) public/account/overview.html injects a Next-Actions panel that fetches
//       /v1/intent/next and renders top-3 ranked actions as cards with a copy
//       button per command. Behavior assertion — we look for the panel marker,
//       the fetch URL, and the data-w413 hooks, NOT for prose copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OVERVIEW_HTML = path.join(REPO_ROOT, 'public', 'account', 'overview.html');
const ROUTER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');

async function makeAppAndTenant() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  return { app, apiKey: t.api_key, tenantId: t.id };
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const out = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// =============================================================================
// 1) Route is registered.
// =============================================================================

test('W413 #1 — /v1/intent/next route is wired in src/router.js', () => {
  assert.ok(/['"`]\/v1\/intent\/next['"`]/.test(ROUTER_SRC),
    'router.js must declare /v1/intent/next');
});

// =============================================================================
// 2) Unauthenticated request returns 401.
// =============================================================================

test('W413 #2 — /v1/intent/next without auth returns 401', async () => {
  const { app } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/intent/next');
    assert.equal(r.status, 401, '/v1/intent/next must reject unauthenticated requests');
    const body = await r.json().catch(() => ({}));
    // Auth middleware may return {error: ...} OR our handler may return
    // {ok:false}. Either way, the response must signal failure (no ok=true).
    assert.notEqual(body.ok, true, 'response must not carry ok:true on unauth');
  });
});

// =============================================================================
// 3) Authenticated request returns the W412 envelope.
// =============================================================================

test('W413 #3 — /v1/intent/next returns {ok, recommendations, generated_at, snapshot_summary}', async () => {
  const { app, apiKey } = await makeAppAndTenant();
  await withServer(app, async (base) => {
    const r = await fetch(base + '/v1/intent/next', {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    assert.equal(r.status, 200, '/v1/intent/next must return 200 to an authed tenant');
    const body = await r.json();
    assert.equal(body.ok, true, 'envelope ok=true');
    assert.ok(Array.isArray(body.recommendations), 'recommendations array present');
    assert.ok(body.recommendations.length >= 1, 'recommender always returns >= 1 entry');
    assert.ok(typeof body.generated_at === 'string', 'generated_at is an ISO string');
    assert.ok(body.snapshot_summary && typeof body.snapshot_summary === 'object', 'snapshot_summary object present');
    // The summary must carry the W412-added counters.
    for (const k of ['artifacts', 'captures', 'namespaces', 'opportunities', 'datasets', 'jobs']) {
      assert.ok(k in body.snapshot_summary, 'snapshot_summary must include ' + k);
    }
    // Each recommendation entry has the same shape recommendNext emits.
    for (const rec of body.recommendations) {
      assert.ok(typeof rec.action === 'string', 'rec.action is a string');
      assert.ok(typeof rec.command === 'string' && rec.command.length > 0, 'rec.command non-empty');
      assert.ok(typeof rec.why === 'string', 'rec.why is a string');
      assert.ok(typeof rec.rank === 'number', 'rec.rank is a number');
    }
  });
});

// =============================================================================
// 4) HTML wires the Next-Actions panel — markers + fetch URL.
// =============================================================================

test('W413 #4 — overview.html injects the Next-Actions panel + fetch call', () => {
  const html = fs.readFileSync(OVERVIEW_HTML, 'utf8');
  // Panel container with the W413 marker.
  assert.ok(/data-w413\s*=\s*"next-actions"/.test(html),
    'overview.html must carry data-w413="next-actions" panel marker');
  // Body container that JS fills.
  assert.ok(/id\s*=\s*"next-actions-body"/.test(html),
    'overview.html must carry id="next-actions-body" mount point');
  // The fetch goes to /v1/intent/next.
  assert.ok(/kfetch\s*\(\s*["']\/v1\/intent\/next["']/.test(html),
    'overview.html must fetch /v1/intent/next via kfetch');
  // Recommendation card marker (data-w413="next-action") and the copy button hook.
  assert.ok(/data-w413\s*=\s*\\?"next-action\\?"/.test(html),
    'overview.html must render each rec as data-w413="next-action"');
  assert.ok(/data-copy\s*=/.test(html),
    'overview.html must wire a copy button per recommendation');
});

// =============================================================================
// 5) Panel sits ABOVE the metric-grid (so it's the first thing the user sees).
// =============================================================================

test('W413 #5 — Next-Actions panel renders above the metric-grid', () => {
  const html = fs.readFileSync(OVERVIEW_HTML, 'utf8');
  const idxPanel = html.indexOf('data-w413="next-actions"');
  const idxGrid  = html.indexOf('id="metric-grid"');
  assert.ok(idxPanel > 0, 'panel marker present');
  assert.ok(idxGrid > 0,  'metric-grid marker present');
  assert.ok(idxPanel < idxGrid, 'Next-Actions panel must precede metric-grid in the DOM');
});
