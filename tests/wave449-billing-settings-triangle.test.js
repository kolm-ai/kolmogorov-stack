// W449/W450 — billing + settings triangle closers.
//
// W449 = TUI parity for /account/billing (CLI verb + page existed already).
// W450 = new /v1/account/settings surface: route (GET/PUT) + CLI verb
//        (`kolm settings show / set k=v`) + TUI view + page.
//
// Behavior assertions only — no page-text markers (W202-W210 lesson).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function _mkHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w449-'));
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
// W449 #1 — TUI registers a billing view hitting /v1/billing/usage
// =============================================================================

test('W449 #1 — TUI billing view exists and hits /v1/billing/usage', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.ok(/id:\s*'billing',[^\n]*endpoint:\s*'\/v1\/billing\/usage'/.test(cli),
    'TUI_VIEWS must include a billing row hitting /v1/billing/usage');
  // The :billing command alias for vim-style command mode.
  assert.ok(/'billing':\s*'billing'/.test(cli),
    'VIEW_ALIAS must route `:billing` to the billing view');
});

// =============================================================================
// W449 #2 — billing triangle: page + route + CLI verb all reference the
//           same /v1/billing/usage endpoint (one source of truth)
// =============================================================================

test('W449 #2 — billing triangle: page + CLI + route all reference /v1/billing/usage', () => {
  const page = fs.readFileSync(path.join(REPO_ROOT, 'public', 'account', 'billing.html'), 'utf8');
  const cli  = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  const rtr  = fs.readFileSync(path.join(REPO_ROOT, 'src', 'router.js'), 'utf8');
  assert.ok(page.includes('/v1/billing/usage'), 'page must call /v1/billing/usage');
  assert.ok(cli.includes('/v1/billing/usage'), 'CLI cmdBilling must call /v1/billing/usage');
  assert.ok(rtr.includes("r.get('/v1/billing/usage'"), 'router must declare GET /v1/billing/usage');
});

// =============================================================================
// W450 #3 — GET /v1/account/settings returns the defaults envelope
// =============================================================================

test('W450 #3 — GET /v1/account/settings returns settings + defaults envelope', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/account/settings', {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(typeof j.settings, 'object', 'envelope must include settings object');
    assert.equal(typeof j.defaults, 'object', 'envelope must include defaults object');
    // Documented fields must all be present (defaults merged for new tenants).
    const required = [
      'default_namespace', 'notifications_email', 'notifications_webpush',
      'redaction_strictness', 'sync_push_enabled', 'key_rotation_warning_days',
      'locale', 'timezone', 'capture_default_durable',
    ];
    for (const k of required) {
      assert.ok(k in j.settings,
        'settings envelope must include field "' + k + '"');
    }
  });
});

// =============================================================================
// W450 #4 — PUT /v1/account/settings round-trips a whitelist update
// =============================================================================

test('W450 #4 — PUT /v1/account/settings round-trips through GET', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const put = await fetch(base + '/v1/account/settings', {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        default_namespace: 'prod-ns',
        notifications_email: false,
        redaction_strictness: 'balanced',
      }),
    });
    assert.equal(put.status, 200);
    const pj = await put.json();
    assert.equal(pj.ok, true);
    assert.deepEqual(pj.updated_fields.sort(),
      ['default_namespace', 'notifications_email', 'redaction_strictness']);

    // Re-read to confirm persistence.
    const get = await fetch(base + '/v1/account/settings', {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    const gj = await get.json();
    assert.equal(gj.settings.default_namespace, 'prod-ns');
    assert.equal(gj.settings.notifications_email, false);
    assert.equal(gj.settings.redaction_strictness, 'balanced');
    // Untouched fields keep their defaults.
    assert.equal(gj.settings.locale, 'en-US');
  });
});

// =============================================================================
// W450 #5 — invalid enum values are refused 400 (defense-in-depth)
// =============================================================================

test('W450 #5 — PUT with invalid enum value returns 400', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/account/settings', {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ redaction_strictness: 'paranoid' }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'invalid_value');
    assert.equal(j.field, 'redaction_strictness');
    assert.ok(Array.isArray(j.allowed));
    assert.deepEqual(j.allowed.sort(), ['balanced', 'minimal', 'strict']);
  });
});

// =============================================================================
// W450 #6 — unauthenticated GET returns 401, not 500
// =============================================================================

test('W450 #6 — unauth GET returns 401', async () => {
  _mkHome();
  const { app } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/account/settings');
    assert.equal(r.status, 401);
  });
});

// =============================================================================
// W450 #7 — arbitrary keys outside the whitelist are silently dropped
// =============================================================================

test('W450 #7 — PUT with unknown field is a no-op (whitelist enforced)', async () => {
  _mkHome();
  const { app, apiKey } = await _makeAppAndTenant();
  await _withServer(app, async (base) => {
    const r = await fetch(base + '/v1/account/settings', {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ admin_god_mode: true, eval_threshold: 0.5 }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.updated_fields, []);
    // Whitelist must drop the rogue keys — settings echo must not contain them.
    assert.ok(!('admin_god_mode' in j.settings));
    assert.ok(!('eval_threshold' in j.settings));
  });
});

// =============================================================================
// W450 #8 — CLI: kolm settings registered as a top-level verb
// =============================================================================

test('W450 #8 — cli/kolm.js registers `settings` as a top-level verb', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.ok(/case 'settings':\s*await\s+withErrorContext\('settings'/.test(cli),
    'cli/kolm.js must register `case \'settings\':` in the top-level dispatch');
  assert.ok(/COMPLETION_VERBS\s*=[\s\S]*?'settings'[\s\S]*?\]/.test(cli),
    'COMPLETION_VERBS must include `settings`');
  assert.ok(/settings:\s*`kolm settings/.test(cli),
    'HELP table must include a `settings` entry');
  assert.ok(/async function cmdSettings\(/.test(cli),
    'cli/kolm.js must define async function cmdSettings(args)');
});

// =============================================================================
// W450 #9 — cmdSettings hits the documented route + supports show/set
// =============================================================================

test('W450 #9 — cmdSettings hits GET + PUT /v1/account/settings with sub-actions', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  const m = cli.match(/async function cmdSettings\(args\) \{([\s\S]*?)\n\}/);
  assert.ok(m, 'cmdSettings function body must be locatable');
  const body = m[1];
  assert.ok(body.includes('/v1/account/settings'),
    'cmdSettings must hit /v1/account/settings (mirror of the web page)');
  assert.ok(/'GET'/.test(body), 'cmdSettings must issue GET for `show`');
  assert.ok(/'PUT'/.test(body), 'cmdSettings must issue PUT for `set`');
  assert.ok(/'show'|'list'|'get'/.test(body),
    'cmdSettings must accept a show/list/get sub-action');
  assert.ok(/'set'|'put'|'update'/.test(body),
    'cmdSettings must accept a set/put/update sub-action');
  assert.ok(/--json/.test(body), 'cmdSettings must support --json');
});

// =============================================================================
// W450 #10 — TUI registers a settings view hitting the same route
// =============================================================================

test('W450 #10 — TUI registers a settings view hitting /v1/account/settings', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.ok(/id:\s*'settings',[^\n]*endpoint:\s*'\/v1\/account\/settings'/.test(cli),
    'TUI_VIEWS must include a settings row hitting /v1/account/settings');
  // VIEW_ALIAS for command mode `:settings`, `:preferences`, `:prefs`.
  assert.ok(/'settings':\s*'settings'/.test(cli),
    'VIEW_ALIAS must route `:settings` to the settings view');
});

// =============================================================================
// W450 #11 — Web page exists and calls the same /v1/account/settings route
// =============================================================================

test('W450 #11 — /account/settings.html fetches /v1/account/settings (GET + PUT)', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'public', 'account', 'settings.html'), 'utf8');
  assert.ok(html.includes('/v1/account/settings'),
    'page must call /v1/account/settings (same route as CLI + TUI)');
  // The page must POST/PUT to the same route to save settings.
  assert.ok(/method:\s*['"]PUT['"]/.test(html),
    'page must PUT to /v1/account/settings on save');
});

// =============================================================================
// W450 #12 — vercel.json registers the /account/settings rewrite
// =============================================================================

test('W450 #12 — vercel.json rewrites /account/settings → /account/settings.html', () => {
  const v = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8'));
  const r = (v.rewrites || []).find(x => x.source === '/account/settings');
  assert.ok(r, 'vercel.json must include a rewrite for /account/settings');
  assert.equal(r.destination, '/account/settings.html');
});
