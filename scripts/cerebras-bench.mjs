#!/usr/bin/env node
// W918 P1.16 - Cerebras teacher bench.
//
// Runs a small, repeatable matrix against the Cerebras Cloud Chat Completions
// API to characterize latency + throughput + cost for the three teacher
// models the W918 land-grab plan whitelists.
//
// Shape:
//   10 prompts x 3 models = 30 calls.
//   For each (model, prompt) we record latency_ms, completion_tokens, tok/s.
//   For each model we summarize p50 / p99 latency, mean tok/s, est $/1k tokens.
//
// Output:
//   - markdown table on stdout.
//   - JSON snapshot at data/eval-fixtures/cerebras-bench.json.
//
// Usage:
//   CEREBRAS_API_KEY=csk-... node scripts/cerebras-bench.mjs
//
// Exit codes:
//   0  bench completed (even if some calls failed; failures are recorded
//      in the JSON output but do not abort the run).
//   2  CEREBRAS_API_KEY not set.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chat, CEREBRAS_MODELS } from '../src/teachers/cerebras.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'data', 'eval-fixtures', 'cerebras-bench.json');

// Ten short, diverse reasoning / generation prompts. Chosen to exercise
// arithmetic, code, definition, summarization, classification, planning,
// translation, comparison, edge cases, and creative generation.
const PROMPTS = Object.freeze([
  'What is 17 times 23? Reply with only the number.',
  'Explain the quicksort algorithm in three sentences.',
  'Define the word "epistemology" in one sentence suitable for a high-school student.',
  'Summarize the plot of Hamlet in two sentences.',
  'Classify this sentence as positive, negative, or neutral: "The coffee was lukewarm and the service was slow."',
  'List three concrete steps a small team can take this week to reduce on-call fatigue.',
  'Translate "Where is the nearest pharmacy?" into Spanish, French, and Japanese.',
  'Compare REST and gRPC in three short bullet points.',
  'If a snail climbs 3 feet up a wall each day and slips back 2 feet each night, on what day does it reach the top of a 10-foot wall?',
  'Write a two-sentence product tagline for an open-source distillation toolkit aimed at developers migrating off OpenAI fine-tuning.',
]);

// Published Cerebras Cloud per-million-token pricing as of 2026-05.
// Source: https://cloud.cerebras.ai/pricing
// Values are USD per 1M tokens. We expose per-1k-tokens in the report
// because that is the operational unit teams use to estimate distill cost.
// If pricing for a model is unknown we leave it null and the report shows
// "n/a" rather than guess.
const PRICING_USD_PER_MTOK = Object.freeze({
  'llama3.1-8b':   { input: 0.10, output: 0.10 },
  'llama-3.3-70b': { input: 0.85, output: 1.20 },
  'qwen-3-32b':    { input: 0.40, output: 0.80 },
});

function quantile(sortedNumbers, q) {
  if (sortedNumbers.length === 0) return null;
  if (sortedNumbers.length === 1) return sortedNumbers[0];
  const pos = (sortedNumbers.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedNumbers[lo];
  const frac = pos - lo;
  return sortedNumbers[lo] + (sortedNumbers[hi] - sortedNumbers[lo]) * frac;
}

function mean(numbers) {
  if (numbers.length === 0) return null;
  let s = 0;
  for (const n of numbers) s += n;
  return s / numbers.length;
}

function fmtMs(n) {
  if (n == null) return 'n/a';
  return `${Math.round(n)}ms`;
}

function fmtTokS(n) {
  if (n == null) return 'n/a';
  return n.toFixed(1);
}

function fmtUsd(n) {
  if (n == null) return 'n/a';
  return `$${n.toFixed(4)}`;
}

function estCostPer1kTokens(model, samples) {
  const px = PRICING_USD_PER_MTOK[model];
  if (!px) return null;
  // Pro-rate the published per-MTok price by the observed input:output ratio
  // for this model so the headline number reflects real distill mix, not a
  // pure-input or pure-output corner case. Falls back to a 1:1 blend when
  // we collected no usage data (e.g., all calls failed).
  let totalIn = 0;
  let totalOut = 0;
  for (const r of samples) {
    if (!r.ok) continue;
    totalIn += r.usage.prompt_tokens || 0;
    totalOut += r.usage.completion_tokens || 0;
  }
  const total = totalIn + totalOut;
  if (total === 0) {
    return (px.input + px.output) / 2 / 1000; // $/1k blended fallback
  }
  const blendedPerMtok = (px.input * totalIn + px.output * totalOut) / total;
  return blendedPerMtok / 1000;
}

function buildModelSummary(model, samples) {
  const ok = samples.filter((s) => s.ok);
  const latencies = ok.map((s) => s.latency_ms).sort((a, b) => a - b);
  const tokS = ok
    .map((s) => (s.usage.completion_tokens && s.latency_ms
      ? s.usage.completion_tokens / (s.latency_ms / 1000)
      : null))
    .filter((n) => n != null);
  return {
    model,
    calls: samples.length,
    successes: ok.length,
    failures: samples.length - ok.length,
    latency_p50_ms: quantile(latencies, 0.5),
    latency_p99_ms: quantile(latencies, 0.99),
    mean_tok_s: mean(tokS),
    est_cost_per_1k: estCostPer1kTokens(model, samples),
  };
}

function renderMarkdownTable(rows) {
  const headers = [
    'model', 'ok/total', 'p50', 'p99', 'mean tok/s', '$/1k tok',
  ];
  const lines = [];
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('|' + headers.map(() => '---').join('|') + '|');
  for (const r of rows) {
    lines.push('| ' + [
      r.model,
      `${r.successes}/${r.calls}`,
      fmtMs(r.latency_p50_ms),
      fmtMs(r.latency_p99_ms),
      fmtTokS(r.mean_tok_s),
      fmtUsd(r.est_cost_per_1k),
    ].join(' | ') + ' |');
  }
  return lines.join('\n');
}

async function runOne(model, prompt) {
  const messages = [{ role: 'user', content: prompt }];
  try {
    const r = await chat(model, messages, { max_tokens: 256 });
    return {
      ok: true,
      model,
      prompt,
      latency_ms: r.latency_ms,
      usage: r.usage,
      content_chars: r.content.length,
    };
  } catch (err) {
    return {
      ok: false,
      model,
      prompt,
      latency_ms: null,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      error: String(err && err.message ? err.message : err).slice(0, 400),
    };
  }
}

async function main() {
  if (!process.env.CEREBRAS_API_KEY && !process.env.KOLM_CEREBRAS_TOKEN) {
    process.stderr.write('CEREBRAS_API_KEY not set\n');
    process.exit(2);
  }

  const models = CEREBRAS_MODELS;
  const raw = [];
  for (const model of models) {
    for (const prompt of PROMPTS) {
      const sample = await runOne(model, prompt);
      raw.push(sample);
    }
  }

  const results = models.map((m) => buildModelSummary(m, raw.filter((r) => r.model === m)));
  const out = {
    ts: new Date().toISOString(),
    prompts: PROMPTS,
    results,
    raw,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

  const md = renderMarkdownTable(results);
  process.stdout.write(md + '\n');
  process.stdout.write(`\nWrote ${path.relative(REPO_ROOT, OUT_PATH)}\n`);
}

main().catch((err) => {
  process.stderr.write(`cerebras-bench: fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
