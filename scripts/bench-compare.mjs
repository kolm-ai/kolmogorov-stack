#!/usr/bin/env node
// scripts/bench-compare.mjs
//
// Run a head-to-head comparison: compiled Kolm artifact vs. remote LLM API
// and local LLM. It also validates published provider-matrix evidence used by
// the public benchmark readiness gate.
//
// Usage:
//   node scripts/bench-compare.mjs <artifact.kolm> [--runs N] [--json out.json]
//   node scripts/bench-compare.mjs --matrix reports/benchmarks/provider-matrix.json [--public] [--json]
//
// Env:
//   ANTHROPIC_API_KEY            enables llm-api path (skipped if unset)
//   KOLM_BENCH_LLM_MODEL         override (default: claude-haiku-4-5)
//   KOLM_BENCH_LLM_INPUT_RATE    USD per 1M input tokens (override estimate)
//   KOLM_BENCH_LLM_OUTPUT_RATE   USD per 1M output tokens
//   KOLM_BENCH_LOCAL_LLM_URL     ollama endpoint (default: http://127.0.0.1:11434)
//   KOLM_BENCH_LOCAL_LLM_MODEL   ollama model tag (default: llama3.2:1b)

import fs from 'node:fs';
import path from 'node:path';
import {
  auditBenchmarkEvidence,
  validateBenchmarkProviderMatrix,
} from '../src/benchmark-evidence.js';
import { compareArtifact } from '../src/benchmark-compare.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  usage(process.stdout);
  process.exit(0);
}

if (args.length === 0) {
  usage(process.stderr);
  process.exit(1);
}

const matrixPath = parseFlag('--matrix', null, String);
if (matrixPath) {
  const validation = validateMatrixFile(matrixPath);
  const requirePublic = args.includes('--public');
  const asJson = args.includes('--json');
  const publicAudit = requirePublic ? auditBenchmarkEvidence({ root: process.cwd() }) : null;
  const ok = validation.ok && (!requirePublic || publicAudit.public_claim_ready);
  if (asJson) {
    console.log(JSON.stringify({
      ok,
      provider_matrix_validation: validation,
      public_claim_ready: publicAudit ? publicAudit.public_claim_ready : null,
      public_claim_blockers: publicAudit ? publicAudit.blockers : [],
    }, null, 2));
  } else {
    console.log(`ok=${ok} lanes=${validation.counts.complete_lanes}/${validation.counts.required_lanes} failures=${validation.counts.failures}`);
    for (const failure of validation.failures) console.log(failure);
    if (publicAudit) {
      console.log(`public_claim_ready=${publicAudit.public_claim_ready} blockers=${publicAudit.blockers.length}`);
      for (const blocker of publicAudit.blockers) console.log(blocker);
    }
  }
  process.exit(ok ? 0 : 1);
}

const artifactArg = args.find((arg) => !arg.startsWith('--'));
if (!artifactArg) {
  usage(process.stderr);
  process.exit(1);
}

const artifactPath = path.resolve(artifactArg);
if (!fs.existsSync(artifactPath)) {
  console.error(`artifact not found: ${artifactPath}`);
  process.exit(1);
}

const runs = parseFlag('--runs', 5, Number);
const outJson = parseFlag('--json', null, String);

const report = await compareArtifact(artifactPath, { runs, outPath: outJson });
printReport(report);

function usage(stream) {
  stream.write(`kolm benchmark comparison

USAGE
  node scripts/bench-compare.mjs <artifact.kolm> [--runs N] [--json out.json]
  node scripts/bench-compare.mjs --matrix reports/benchmarks/provider-matrix.json [--public] [--json]

FLAGS
  --runs N      number of repeated calls per eval case for artifact comparison
  --json PATH   write artifact comparison JSON to PATH, or emit matrix validation JSON
  --matrix PATH validate a provider benchmark matrix without calling model providers
  --public      with --matrix, also require the repo public-claim packet to be complete

SCOPE
  Artifact comparison may call configured model providers. Matrix validation is local only.
`);
}

function parseFlag(name, fallback, coerce) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined) return fallback;
  return coerce(v);
}

function validateMatrixFile(relOrAbs) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(relOrAbs), 'utf8'));
  } catch (e) {
    return {
      ok: false,
      counts: { lanes: 0, required_lanes: 0, complete_lanes: 0, failures: 1 },
      failures: [`matrix_read_failed:${String(e.message || e)}`],
    };
  }
  return validateBenchmarkProviderMatrix(parsed);
}

function printReport(r) {
  const w = process.stdout.columns || 80;
  hr(w);
  console.log('kolm benchmark - head-to-head comparison');
  hr(w);
  console.log(`artifact: ${shortPath(r.artifact)}`);
  console.log(`task    : ${truncate(r.task, w - 12)}`);
  console.log(`cases   : ${r.cases} * ${r.runs_per_case} runs = ${r.cases * r.runs_per_case} calls per path`);
  console.log(`host    : ${r.host.platform}-${r.host.arch}, node ${r.host.node}`);
  console.log('');

  for (const name of ['kolm-js', 'kolm-native', 'llm-api', 'local-llm']) {
    const p = r.paths[name];
    console.log(label(name, w));
    if (p.skipped) {
      console.log(`  SKIPPED: ${p.reason}`);
      console.log('');
      continue;
    }
    if (p.latency_us) {
      const l = p.latency_us;
      console.log(`  latency  n=${l.n}  min=${us(l.min)}  p50=${us(l.p50)}  p95=${us(l.p95)}  p99=${us(l.p99)}  max=${us(l.max)}`);
    }
    if (p.correctness) {
      const c = p.correctness;
      const acc = c.accuracy != null ? `${(c.accuracy * 100).toFixed(1)}%` : 'n/a';
      console.log(`  accuracy ${c.passed}/${c.graded}  (${acc})  [${c.comparator || 'exact-match'}]`);
    }
    if (p.tokens && (p.tokens.avg_input != null || p.tokens.avg_output != null)) {
      console.log(`  tokens   in=${p.tokens.avg_input}  out=${p.tokens.avg_output}`);
    }
    if (p.cost) {
      const cpc = p.cost.per_call_usd;
      const cpm = p.cost.per_million_calls_usd;
      if (cpc != null) console.log(`  cost     $${cpc}/call  ($${cpm}/1M calls)`);
      else if (p.cost.model) console.log(`  cost     ${p.cost.model}`);
    }
    if (p.model) console.log(`  model    ${p.model}`);
    if (p.endpoint) console.log(`  endpoint ${p.endpoint}`);
    if (p.bin_path) console.log(`  binary   ${shortPath(p.bin_path)}`);
    if (p.notes) console.log(`  notes    ${p.notes}`);
    console.log('');
  }

  hr(w);
  console.log('head-to-head (vs. kolm-js baseline):');
  hr(w);
  for (const [name, h] of Object.entries(r.head_to_head || {})) {
    if (h.skipped) {
      console.log(`  ${name.padEnd(12)}  SKIPPED: ${h.skipped}`);
      continue;
    }
    console.log(`  ${name.padEnd(12)}  ${h.summary}`);
    if (h.cost_per_million_usd_other != null) {
      console.log(`               cost: kolm-js $0  vs  ${name} $${h.cost_per_million_usd_other} per 1M calls`);
    }
  }
  hr(w);
}

function hr(w) {
  console.log('-'.repeat(Math.min(w, 100)));
}

function label(name, w) {
  const width = Math.min(w, 100);
  return ` ${name.toUpperCase()} `.padEnd(width, '-');
}

function us(v) {
  if (v == null) return 'n/a';
  if (v < 1000) return `${v.toFixed(0)}us`;
  if (v < 1e6) return `${(v / 1e3).toFixed(2)}ms`;
  return `${(v / 1e6).toFixed(2)}s`;
}

function shortPath(p) {
  try {
    return path.relative(process.cwd(), p);
  } catch {
    return p;
  }
}

function truncate(value, n) {
  const s = String(value || '');
  return s.length > n ? `${s.slice(0, Math.max(0, n - 3))}...` : s;
}
