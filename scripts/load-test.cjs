#!/usr/bin/env node
// scripts/load-test.cjs
//
// Gateway load-test driver. Dispatches one of three scenarios against the
// public kolm.ai gateway (or any --base URL) and prints aggregated metrics.
//
// Default mode is --dry-run: the driver prints what it WOULD do and exits
// without sending traffic. The operator passes --no-dry-run to actually fire
// requests at the target. This protects the production budget against an
// accidental `node scripts/load-test.cjs` invocation.
//
// Pure Node 20 stdlib (node:http, node:https, Promise.all). No autocannon,
// k6, or wrk. The operator may swap in k6 later for higher-fanout tests; this
// scaffold exists so a launch-day load test does not require a new tool
// install on the operator workstation.
//
// Scenarios:
//   concurrent-100        100 parallel POSTs to /v1/gateway/dispatch
//   long-context-128k     one 128K-token-equivalent prompt (graceful 413/422 ok)
//   all-providers-down    asserts gateway returns queued-receipt OR clean 503
//
// Usage:
//   node scripts/load-test.cjs --scenario concurrent-100             (dry-run)
//   node scripts/load-test.cjs --scenario all --no-dry-run --json
//
// Exit codes:
//   0  all scenarios met their acceptance thresholds (or dry-run completed)
//   1  one or more scenarios failed acceptance
//   2  driver error (bad args, scenario module missing, etc.)

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const SCENARIO_DIR = path.join(__dirname, 'load-test-scenarios');
const KNOWN_SCENARIOS = ['concurrent-100', 'long-context-128k', 'all-providers-down'];

function parseArgs(argv) {
  const out = {
    scenario: 'concurrent-100',
    base: 'https://kolm.ai',
    bearer: process.env.KOLM_API_KEY || '',
    rpm: 60,
    duration_s: 60,
    dry_run: true,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = argv[i + 1];
    switch (k) {
      case '--scenario': out.scenario = next; i++; break;
      case '--base': out.base = next; i++; break;
      case '--bearer': out.bearer = next; i++; break;
      case '--rpm': out.rpm = parseInt(next, 10); i++; break;
      case '--duration-s': out.duration_s = parseInt(next, 10); i++; break;
      case '--dry-run': out.dry_run = true; break;
      case '--no-dry-run': out.dry_run = false; break;
      case '--json': out.json = true; break;
      case '--help':
      case '-h':
        out.help = true; break;
      default:
        if (k && k.startsWith('--')) {
          // Tolerate unknown flags; surface them in help context.
          out._unknown = (out._unknown || []).concat([k]);
        }
    }
  }
  return out;
}

function printHelp() {
  const lines = [
    'kolm gateway load-test driver',
    '',
    'Usage:',
    '  node scripts/load-test.cjs --scenario <name> [options]',
    '',
    'Scenarios:',
    '  concurrent-100        100 parallel /v1/gateway/dispatch requests',
    '  long-context-128k     one ~500KB prompt; graceful 413/422 acceptable',
    '  all-providers-down    expects queued-receipt OR 503 all_providers_down',
    '  all                   runs all three in sequence',
    '',
    'Options:',
    '  --base <url>          target gateway base (default https://kolm.ai)',
    '  --bearer <token>      API key (default $KOLM_API_KEY)',
    '  --rpm <int>           rate-limit ceiling (default 60)',
    '  --duration-s <int>    scenario time budget (default 60)',
    '  --dry-run             print plan, send no traffic (DEFAULT)',
    '  --no-dry-run          actually fire requests',
    '  --json                machine envelope on stdout',
    '  --help, -h            this message',
    '',
    'Default is --dry-run. Pass --no-dry-run to fire real traffic.',
    'See docs/operations/load-testing.md for the runbook.',
  ];
  console.log(lines.join('\n'));
}

function envelope(args, results, ok) {
  return {
    driver: 'scripts/load-test.cjs',
    base: args.base,
    dry_run: args.dry_run,
    bearer_present: !!args.bearer,
    rpm: args.rpm,
    duration_s: args.duration_s,
    scenarios: results,
    ok,
    generated_at: new Date().toISOString(),
  };
}

function fmt(n) {
  if (n === null || n === undefined) return '-';
  if (typeof n !== 'number') return String(n);
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

function prettyPrint(env) {
  console.log('');
  console.log('=== kolm gateway load-test ===');
  console.log('base:        ' + env.base);
  console.log('dry-run:     ' + env.dry_run);
  console.log('bearer:      ' + (env.bearer_present ? 'present' : 'MISSING'));
  console.log('rpm ceiling: ' + env.rpm);
  console.log('duration:    ' + env.duration_s + 's');
  console.log('');
  for (const s of env.scenarios) {
    console.log('--- ' + s.name + ' ---');
    console.log('  status:           ' + (s.skipped ? 'SKIPPED' : (s.ok ? 'PASS' : 'FAIL')));
    if (s.reason) console.log('  reason:           ' + s.reason);
    const m = s.metrics || {};
    console.log('  requests_sent:    ' + fmt(m.requests_sent));
    console.log('  requests_success: ' + fmt(m.requests_success));
    console.log('  requests_429:     ' + fmt(m.requests_429));
    console.log('  requests_5xx:     ' + fmt(m.requests_5xx));
    console.log('  latency_p50_ms:   ' + fmt(m.latency_p50_ms));
    console.log('  latency_p95_ms:   ' + fmt(m.latency_p95_ms));
    console.log('  latency_max_ms:   ' + fmt(m.latency_max_ms));
    if (s.assertions && s.assertions.length) {
      console.log('  assertions:');
      for (const a of s.assertions) {
        console.log('    [' + (a.pass ? 'pass' : 'FAIL') + '] ' + a.label);
      }
    }
    if (s.errors && s.errors.length) {
      console.log('  errors (first 5):');
      for (const e of s.errors.slice(0, 5)) console.log('    - ' + e);
    }
    console.log('');
  }
  console.log('overall:     ' + (env.ok ? 'PASS' : 'FAIL'));
}

async function loadScenario(name) {
  const p = path.join(SCENARIO_DIR, name + '.js');
  if (!fs.existsSync(p)) {
    throw new Error('scenario not found: ' + name + ' (' + p + ')');
  }
  // Scenarios are ESM (`type: module` in package.json). Use dynamic import
  // from the CJS driver. They export `export default async function` AND a
  // named `export { run }` so tests can verify either binding.
  const fileUrl = 'file://' + p.replace(/\\/g, '/');
  const mod = await import(fileUrl);
  const fn = (typeof mod === 'function') ? mod : (mod && (mod.default || mod.run));
  if (typeof fn !== 'function') {
    throw new Error('scenario ' + name + ' did not export a default async function');
  }
  return fn;
}

async function runScenario(name, args) {
  const fn = await loadScenario(name);
  const ctx = {
    base: args.base,
    bearer: args.bearer,
    rpm: args.rpm,
    duration_s: args.duration_s,
    dry_run: args.dry_run,
  };
  try {
    const result = await fn(ctx);
    return Object.assign({ name }, result);
  } catch (err) {
    return {
      name,
      ok: false,
      reason: 'scenario threw: ' + (err && err.message ? err.message : String(err)),
      metrics: {},
      errors: [String(err && err.stack || err)],
      assertions: [],
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  const targets = (args.scenario === 'all')
    ? KNOWN_SCENARIOS.slice()
    : [args.scenario];

  for (const t of targets) {
    if (!KNOWN_SCENARIOS.includes(t)) {
      console.error('unknown scenario: ' + t);
      console.error('known: ' + KNOWN_SCENARIOS.join(', ') + ', all');
      process.exit(2);
    }
  }

  const results = [];
  for (const t of targets) {
    results.push(await runScenario(t, args));
  }

  const ok = results.every((r) => r.ok === true || r.skipped === true);
  const env = envelope(args, results, ok);

  if (args.json) {
    console.log(JSON.stringify(env, null, 2));
  } else {
    prettyPrint(env);
  }
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('driver error: ' + (err && err.stack || err));
    process.exit(2);
  });
}

module.exports = { parseArgs, loadScenario, KNOWN_SCENARIOS };
