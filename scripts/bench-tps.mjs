#!/usr/bin/env node
/**
 * scripts/bench-tps.mjs
 *
 * Tokens-per-second + pattern-match latency benchmark.
 *
 * Two modes:
 *
 *   1. pattern  (default)  — exercises the .kolm artifact's JS recipe directly,
 *                            no model load. Reports p50/p95/p99 in microseconds
 *                            and a calls/sec figure. This is what the runtime
 *                            actually does for most artifacts.
 *
 *   2. generative          — POSTs /v1/chat/completions to an HTTP serve URL
 *                            (e.g. spawned by `kolm serve --http foo.kolm`),
 *                            measures wall time + decoded tokens, reports
 *                            tokens/sec including first-token latency.
 *
 * Usage:
 *
 *   node scripts/bench-tps.mjs --spec examples/demo-phi-redactor.spec.json
 *   node scripts/bench-tps.mjs --artifact ./artifacts/job_phi_redactor_v1.kolm
 *   node scripts/bench-tps.mjs --generative --url http://localhost:8765 --n 32
 *
 * Output is a JSON record on stdout suitable for committing to the registry
 * or publishing on /compute as a reference number.
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const ARGS = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { mode: 'pattern', n: 200, warmup: 20, max_new_tokens: 128 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = argv[i + 1];
    switch (k) {
      case '--spec': out.spec = next; i++; break;
      case '--artifact': out.artifact = next; i++; break;
      case '--generative': out.mode = 'generative'; break;
      case '--url': out.url = next; i++; break;
      case '--n': out.n = parseInt(next, 10); i++; break;
      case '--warmup': out.warmup = parseInt(next, 10); i++; break;
      case '--max-new-tokens': out.max_new_tokens = parseInt(next, 10); i++; break;
      case '--prompt': out.prompt = next; i++; break;
      case '--out': out.out_path = next; i++; break;
      case '--quiet': out.quiet = true; break;
      default:
        if (k.startsWith('--')) {
          throw new Error(`unknown flag: ${k}`);
        }
    }
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function summary(samples_us) {
  const sorted = [...samples_us].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min_us: Math.round(sorted[0]),
    p50_us: Math.round(percentile(sorted, 0.50)),
    p95_us: Math.round(percentile(sorted, 0.95)),
    p99_us: Math.round(percentile(sorted, 0.99)),
    max_us: Math.round(sorted[sorted.length - 1]),
    mean_us: Math.round(sum / sorted.length),
    calls_per_sec: Math.round(1_000_000 / (sum / sorted.length)),
  };
}

// --------------------------------------------------------------------------
// Pattern mode: compile a spec / load an artifact, exercise the JS recipe
// against each eval case, measure microseconds per call.
// --------------------------------------------------------------------------

async function benchPattern() {
  let spec;
  let recipe_source;
  let cases;
  let job_id;

  if (ARGS.spec) {
    spec = JSON.parse(fs.readFileSync(ARGS.spec, 'utf8'));
    job_id = spec.job_id;
    recipe_source = spec.recipes?.[0]?.source;
    cases = spec.evals?.cases || [];
  } else if (ARGS.artifact) {
    const { execSync } = await import('node:child_process');
    const tmp = path.join(process.cwd(), '.bench-tmp');
    fs.mkdirSync(tmp, { recursive: true });
    try {
      execSync(`tar -xf "${ARGS.artifact}" -C "${tmp}" 2>nul || powershell -Command "Expand-Archive -Path '${ARGS.artifact}' -DestinationPath '${tmp}' -Force"`, { stdio: 'pipe' });
    } catch {
      // try zip via node
      const zip = await import('node:zlib');
      const buf = fs.readFileSync(ARGS.artifact);
      throw new Error('artifact unzip not supported in pure node; install unzip or use --spec');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
    job_id = manifest.job_id;
    recipe_source = fs.readFileSync(path.join(tmp, 'recipes', `${manifest.recipes[0].id}.js`), 'utf8');
    cases = JSON.parse(fs.readFileSync(path.join(tmp, 'evals.json'), 'utf8'))?.cases || [];
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    throw new Error('pattern mode requires --spec PATH or --artifact PATH');
  }

  if (!recipe_source) throw new Error('no recipe source found');
  if (cases.length === 0) throw new Error('no eval cases found — benchmark needs inputs');

  // Compile the recipe to a callable.
  const factoryBody = `${recipe_source}\nreturn generate;`;
  const generate = new Function(factoryBody)();

  // Warm up.
  for (let i = 0; i < ARGS.warmup; i++) {
    const c = cases[i % cases.length];
    try { generate(c.input, {}); } catch { /* warmup absorbs errors */ }
  }

  // Measure.
  const samples = [];
  for (let i = 0; i < ARGS.n; i++) {
    const c = cases[i % cases.length];
    const t0 = performance.now();
    try { generate(c.input, {}); } catch { /* measurement absorbs errors */ }
    const dt = (performance.now() - t0) * 1000; // us
    samples.push(dt);
  }

  const s = summary(samples);
  return {
    mode: 'pattern',
    job_id,
    n: ARGS.n,
    warmup: ARGS.warmup,
    latency: s,
    note: 'Pattern-match recipes run as compiled JS in V8. Numbers are end-to-end (input parse + match + output).',
    box: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: (await import('node:os')).cpus().length,
    },
    timestamp: new Date().toISOString(),
  };
}

// --------------------------------------------------------------------------
// Generative mode: POST to a serve.py endpoint, measure wall time.
// --------------------------------------------------------------------------

async function benchGenerative() {
  const url = ARGS.url || 'http://localhost:8765';
  const prompt = ARGS.prompt || 'Write a one-sentence summary of: the quick brown fox jumps over the lazy dog.';
  const n = ARGS.n;
  const maxNew = ARGS.max_new_tokens;

  // Probe /info to record what we're talking to.
  let info = null;
  try {
    const r = await fetch(`${url}/info`);
    if (r.ok) info = await r.json();
  } catch (exc) {
    throw new Error(`cannot reach ${url}/info — start the server with \`kolm serve --http <artifact.kolm>\` first`);
  }

  // Warmup
  for (let i = 0; i < Math.min(3, ARGS.warmup); i++) {
    await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 32, temperature: 0.0,
      }),
    });
  }

  // Measure.
  const latencies = [];
  let totalTokens = 0;
  let totalElapsed = 0;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxNew, temperature: 0.2, top_p: 0.9,
      }),
    });
    const dt = performance.now() - t0;
    const j = await r.json();
    const toks = j?.usage?.completion_tokens || j?.choices?.[0]?.tokens || maxNew;
    latencies.push(dt);
    totalTokens += toks;
    totalElapsed += dt;
  }

  const sortedLat = [...latencies].sort((a, b) => a - b);
  const tps = totalTokens / (totalElapsed / 1000);
  return {
    mode: 'generative',
    url,
    info,
    n,
    max_new_tokens: maxNew,
    tokens_total: totalTokens,
    elapsed_seconds: +(totalElapsed / 1000).toFixed(3),
    tokens_per_second: +tps.toFixed(2),
    latency_ms: {
      min: +sortedLat[0].toFixed(2),
      p50: +percentile(sortedLat, 0.5).toFixed(2),
      p95: +percentile(sortedLat, 0.95).toFixed(2),
      p99: +percentile(sortedLat, 0.99).toFixed(2),
      max: +sortedLat[sortedLat.length - 1].toFixed(2),
    },
    note: 'tokens/sec is end-to-end wall-clock including TCP, JSON, and decode. Subtract first-token latency for sustained-decode estimates.',
    timestamp: new Date().toISOString(),
  };
}

// --------------------------------------------------------------------------

async function main() {
  const result = ARGS.mode === 'generative' ? await benchGenerative() : await benchPattern();
  const json = JSON.stringify(result, null, 2);

  if (ARGS.out_path) {
    fs.writeFileSync(ARGS.out_path, json);
    if (!ARGS.quiet) console.log(`wrote ${ARGS.out_path}`);
  } else {
    console.log(json);
  }
}

main().catch((exc) => {
  console.error(`bench-tps failed: ${exc.message}`);
  process.exit(1);
});
