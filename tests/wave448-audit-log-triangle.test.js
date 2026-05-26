// W448 — audit-log surface triangle (CLI + TUI + web).
//
// The audit's P1 Account cluster listed `/account/audit` as ❌ unwired. The
// page existed and the JSON route existed, but the CLI verb did not exist,
// the TUI had no audit view, and the route did not accept ?format=csv even
// though the page's export button posted that exact query.
//
// W448 closes the triangle:
//   - GET /v1/account/audit-log now accepts ?format=csv and ?since=<iso|epoch>
//   - cli/kolm.js has a top-level `kolm audit` verb hitting that route
//   - TUI registers an `audit-log` view (key E) hitting the same route
//   - VIEW_ALIAS routes `:audit` and `:auditlog` to the new view
//
// Behavior assertions only — page-text markers banned (W202-W210 lesson).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function _mkHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w448-'));
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_STORE_DRIVER = 'json';
  return tmp;
}

async function _makeAppAndTenant() {
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 1000 });
  return { app, apiKey: t.api_key, tenantId: t.id };
}

function _withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const out = await fn(`http://127.0.0.1:${server.address().port}`);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

// =============================================================================
// 1) Route: /v1/account/audit-log accepts ?format=csv (the page export button)
// =============================================================================

test('W448 #1 — GET /v1/account/audit-log?format=csv returns text/csv', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/account/audit-log?format=csv', {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    assert.equal(r.status, 200, 'route must 200 on auth\'d csv query');
    const ctype = r.headers.get('content-type') || '';
    assert.ok(ctype.startsWith('text/csv'),
      'content-type must start with text/csv, got: ' + ctype);
    const body = await r.text();
    const firstLine = body.split('\n')[0];
    assert.equal(firstLine, 'at,actor,op,payload',
      'csv must lead with the documented header row');
  });
});

// =============================================================================
// 2) Route: /v1/account/audit-log accepts ?since= filter (ISO + epoch)
// =============================================================================

test('W448 #2 — GET /v1/account/audit-log?since=<iso> is honored without error', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    // ISO timestamp
    const r1 = await fetch(base + '/v1/account/audit-log?since=2026-05-01T00:00:00Z', {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.ok(Array.isArray(j1.entries), 'entries array must be present');
    // Epoch ms
    const r2 = await fetch(base + '/v1/account/audit-log?since=' + Date.now(), {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.ok(Array.isArray(j2.entries), 'entries array must be present for epoch since');
  });
});

// =============================================================================
// 3) Route: unauthenticated csv request returns header row, not 500
// =============================================================================

test('W448 #3 — unauth ?format=csv returns the header row not 500', async () => {
  _mkHome();
  const { app } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/account/audit-log?format=csv');
    // The route returns 200 with an empty CSV envelope when no tenant is
    // attached — same shape the page consumes. This is the "no tenant, no
    // rows" honest answer, not a 500.
    assert.ok(r.status === 200 || r.status === 401,
      'unauth must return 200 (empty envelope) or 401, never 500; got ' + r.status);
    if (r.status === 200) {
      const text = await r.text();
      const ctype = r.headers.get('content-type') || '';
      assert.ok(ctype.startsWith('text/csv'),
        'content-type must be text/csv even on empty envelope, got: ' + ctype);
      assert.equal(text.trim(), 'at,actor,op,payload',
        'empty envelope must be just the header row');
    }
  });
});

// =============================================================================
// 4) CLI: `kolm audit` is registered as a top-level verb
// =============================================================================

test('W448 #4 — cli/kolm.js registers `audit` as a top-level verb', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  // Dispatch case.
  assert.ok(/case 'audit':\s*await\s+withErrorContext\('audit'/.test(cli),
    'cli/kolm.js must register `case \'audit\':` in the top-level dispatch');
  // Completion list (kolm completion bash et al. expose this list).
  assert.ok(/COMPLETION_VERBS\s*=[\s\S]*?'audit'[\s\S]*?\]/.test(cli),
    'COMPLETION_VERBS must include `audit`');
  // HELP entry.
  assert.ok(/audit:\s*`kolm audit/.test(cli),
    'HELP table must include an `audit` entry');
  // The function itself.
  assert.ok(/async function cmdAudit\(/.test(cli),
    'cli/kolm.js must define async function cmdAudit(args)');
});

// =============================================================================
// 5) CLI: cmdAudit hits the documented route
// =============================================================================

test('W448 #5 — cmdAudit calls GET /v1/account/audit-log with auth + filters', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  // Source-grep the function body.
  const m = cli.match(/async function cmdAudit\(args\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'cmdAudit function body must be locatable');
  const body = m[1];
  assert.ok(body.includes('/v1/account/audit-log'),
    'cmdAudit must hit /v1/account/audit-log (mirror of the web page)');
  assert.ok(/--since|sinceRaw/.test(body),
    'cmdAudit must accept --since for date filtering');
  assert.ok(/--format|format=csv/.test(body),
    'cmdAudit must accept --format csv for CSV export');
  assert.ok(/--limit/.test(body),
    'cmdAudit must accept --limit for pagination cap');
  assert.ok(/--json/.test(body),
    'cmdAudit must accept --json for raw envelope');
  assert.ok(/authorization.*Bearer/.test(body),
    'cmdAudit must send Bearer auth');
});

// =============================================================================
// 6) TUI: an audit-log view is registered
// =============================================================================

test('W448 #6 — TUI registers an audit-log view hitting the same route', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  // View row.
  assert.ok(/id:\s*'audit-log',[^\n]*endpoint:\s*'\/v1\/account\/audit-log'/.test(cli),
    'TUI_VIEWS must include an audit-log row hitting /v1/account/audit-log');
  // VIEW_ALIAS for command mode `:audit`. The map keys are quoted post-W409i
  // to satisfy no-dupe-keys lint, so allow both `audit:` and `'audit':` forms.
  assert.ok(/['"]?audit['"]?:\s*['"]audit-log['"]/.test(cli),
    'VIEW_ALIAS must route `:audit` → audit-log view');
});

// =============================================================================
// 7) Web page still wires to the same route (no drift)
// =============================================================================

test('W448 #7 — /account/audit-log.html fetches the same /v1/account/audit-log route', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'public', 'account', 'audit-log.html'), 'utf8');
  assert.ok(html.includes('/v1/account/audit-log'),
    'page must call /v1/account/audit-log (same route as CLI + TUI)');
  // The export button posts ?format=csv — make sure the page still does.
  assert.ok(/format=csv/.test(html),
    'page must export CSV via ?format=csv (the same flag W448 wired into the route)');
});
