// W921 — `kolm namespace set <slug>` lock-in.
//
// The explicit, server-authoritative CLI front door to PUT /v1/namespaces/:slug.
// Distinct from `kolm namespace config` (local-first, swallows server errors):
// `set` talks to the server, treats it as the source of truth, and surfaces the
// server's enum-validation error (HTTP 400 invalid_value {field, allowed})
// cleanly instead of hiding it.
//
// The live PUT path needs an authenticated server, so the behavioral cases here
// exercise the OFFLINE branches that do NOT require a server (arg-parse, sparse
// patch, enum pre-validation, missing-slug, no-fields, auth-missing) plus a
// source-level lock-in that the verb is wired, PUTs to the right path, mirrors
// the server enum domains, and handles invalid_value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const KOLM_JS = path.join(REPO, 'cli', 'kolm.js');
const SRC = fs.readFileSync(KOLM_JS, 'utf8');

// Run with an isolated empty HOME so there is never a real api_key on disk —
// the auth-missing branch must fire deterministically.
function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-ns-set-'));
  fs.mkdirSync(path.join(dir, '.kolm'), { recursive: true });
  return dir;
}

function runKolm(args, extraEnv = {}) {
  const home = extraEnv.HOME || freshHome();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    KOLM_HOME: home,
    KOLM_ASSISTANT: '0',
    KOLM_NO_INTERACTIVE: '1',
    KOLM_NO_PROGRESS: '1',
    NO_COLOR: '1',
    ...extraEnv,
  };
  delete env.KOLM_API_KEY; // ensure no ambient key
  const r = spawnSync(process.execPath, [KOLM_JS, ...args], { env, encoding: 'utf8', timeout: 30_000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) {}
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

// ─────────────────────────── source lock-in ────────────────────────────────

test('W921-NS.1 namespace set verb is wired into cmdNamespace', () => {
  assert.match(SRC, /if \(sub === 'set'\) \{\s*\n\s*await cmdNamespaceSet\(rest\);/,
    'cmdNamespace routes sub==="set" to cmdNamespaceSet');
  assert.match(SRC, /async function cmdNamespaceSet\(args\)/,
    'cmdNamespaceSet is defined');
});

test('W921-NS.2 cmdNamespaceSet PUTs to /v1/namespaces/:slug', () => {
  const start = SRC.indexOf('async function cmdNamespaceSet(args)');
  const body = SRC.slice(start, start + 6000);
  assert.match(body, /api\(c, 'PUT', '\/v1\/namespaces\/' \+ encodeURIComponent\(slug\)/,
    'issues a PUT to the canonical namespaces route via api()');
});

test('W921-NS.3 the five policy flags are parsed into the PUT patch', () => {
  const start = SRC.indexOf('async function cmdNamespaceSet(args)');
  const body = SRC.slice(start, start + 6000);
  assert.match(body, /val\('route-mode'\)/, 'parses --route-mode');
  assert.match(body, /val\('cache-mode'\)/, 'parses --cache-mode');
  assert.match(body, /val\('guardrail-mode'\)/, 'parses --guardrail-mode');
  assert.match(body, /val\('route-chain'\)/, 'parses --route-chain');
  assert.match(body, /val\('confidence-threshold'\)/, 'parses --confidence-threshold');
  assert.match(body, /patch\.route_mode/, 'maps to route_mode patch field');
  assert.match(body, /patch\.cache_mode/, 'maps to cache_mode patch field');
  assert.match(body, /patch\.guardrail_mode/, 'maps to guardrail_mode patch field');
  assert.match(body, /patch\.route_chain/, 'maps to route_chain patch field');
  assert.match(body, /patch\.confidence_threshold/, 'maps to confidence_threshold patch field');
});

test('W921-NS.4 enum domains mirror the server PUT handler', () => {
  // src/router.js PUT /v1/namespaces/:slug ENUMS for the gateway opt-ins.
  assert.match(SRC, /route_mode:\s*\['static', 'cost_quality', 'semantic'\]/);
  assert.match(SRC, /cache_mode:\s*\['off', 'exact', 'semantic', 'verified'\]/);
  assert.match(SRC, /guardrail_mode:\s*\['off', 'detect_only', 'flag', 'block'\]/);
});

test('W921-NS.5 the server invalid_value error is surfaced (not swallowed)', () => {
  const start = SRC.indexOf('async function cmdNamespaceSet(args)');
  const body = SRC.slice(start, start + 6000);
  // The catch branch must recognise the server's 400 invalid_value shape and
  // re-emit field + allowed rather than a bare "http 400".
  assert.match(body, /sb\.error === 'invalid_value'/, 'detects server invalid_value');
  assert.match(body, /field: sb\.field, allowed: sb\.allowed/, 'forwards server field + allowed');
});

test('W921-NS.6 verb appears in help + completion subs', () => {
  assert.match(SRC, /kolm namespace set <slug>/, 'documented in namespace help');
  assert.match(SRC, /namespace: \['create', 'config', 'set'/, 'set in COMPLETION_SUBS.namespace');
  assert.match(SRC, /ns: \['create', 'config', 'set'/, 'set in COMPLETION_SUBS.ns');
});

// ─────────────────────────── behavioral (offline) ───────────────────────────

test('W921-NS.7 missing slug -> error, exit 1', () => {
  const r = runKolm(['namespace', 'set', '--route-mode', 'cost_quality', '--json']);
  assert.equal(r.json && r.json.error, 'missing_slug');
  assert.equal(r.status, 1);
});

test('W921-NS.8 no policy fields -> no_fields error, exit 1', () => {
  const r = runKolm(['namespace', 'set', 'support', '--json']);
  assert.equal(r.json && r.json.error, 'no_fields');
  assert.equal(r.status, 1);
});

test('W921-NS.9 invalid enum is rejected client-side with allowed list', () => {
  const r = runKolm(['namespace', 'set', 'support', '--route-mode', 'bogus', '--json']);
  assert.equal(r.json && r.json.error, 'invalid_value');
  assert.equal(r.json.field, 'route_mode');
  assert.deepEqual(r.json.allowed, ['static', 'cost_quality', 'semantic']);
  assert.equal(r.status, 1);
});

test('W921-NS.10 invalid cache-mode + guardrail-mode rejected', () => {
  const a = runKolm(['namespace', 'set', 'support', '--cache-mode', 'nope', '--json']);
  assert.equal(a.json.field, 'cache_mode');
  const b = runKolm(['namespace', 'set', 'support', '--guardrail-mode', 'nope', '--json']);
  assert.equal(b.json.field, 'guardrail_mode');
});

test('W921-NS.11 non-numeric confidence-threshold rejected', () => {
  const r = runKolm(['namespace', 'set', 'support', '--confidence-threshold', 'abc', '--json']);
  assert.equal(r.json && r.json.error, 'invalid_value');
  assert.equal(r.json.field, 'confidence_threshold');
});

test('W921-NS.12 flag-value is never mistaken for the slug', () => {
  // `set --route-mode cost_quality` (no slug) must report missing_slug, NOT
  // treat cost_quality (the flag value) as the slug.
  const r = runKolm(['namespace', 'set', '--route-mode', 'cost_quality', '--json']);
  assert.equal(r.json && r.json.error, 'missing_slug');
});

test('W921-NS.13 valid flags + no auth -> auth_required, exit 3', () => {
  // All flags valid, so it passes client validation and reaches the auth gate.
  const r = runKolm(['namespace', 'set', 'support',
    '--route-mode', 'cost_quality', '--cache-mode', 'exact',
    '--guardrail-mode', 'block', '--route-chain', 'gpt-4o-mini,claude-haiku',
    '--confidence-threshold', '0.8', '--json']);
  assert.equal(r.json && r.json.error, 'auth_required');
  assert.equal(r.status, 3);
});

test('W921-NS.14 human (non-json) invalid enum prints allowed values', () => {
  const r = runKolm(['namespace', 'set', 'support', '--cache-mode', 'wrongmode']);
  assert.match(r.stderr, /invalid_value/);
  assert.match(r.stderr, /off \| exact \| semantic \| verified/);
  assert.equal(r.status, 1);
});
