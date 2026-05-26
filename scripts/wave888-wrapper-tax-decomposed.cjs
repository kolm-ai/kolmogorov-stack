#!/usr/bin/env node
// W888 wrapper tax decomposed — per-phase latency benchmark.
//
// Builds on scripts/wave887-wrapper-prod-benchmark.cjs by:
//   1. Running the same N=10 gateway/dispatch leg against kolm.ai
//   2. Fetching each receipt back via GET /v1/verify/<receipt_id>
//   3. Pulling `latency_breakdown` off the receipt and aggregating across N
//   4. Writing benchmarks/wave888-wrapper-tax-decomposed-<DATE>.{json,md}
//
// What the wrapper tax actually decomposes into:
//   tier_check_ms     auth/entitlement check + module import (cold = first call)
//   route_select_ms   namespace lookup + chain build + upstream-key resolution
//   pii_in_ms         input PII detect/redact pass
//   chain_dispatch_ms upstream provider call (the real work)
//   pii_out_ms        output PII detect/redact pass
//   receipt_sign_ms   Ed25519 receipt build + sign
//   capture_write_ms  observation insert (durable JSON or SQLite)
//   total_ms          end-to-end wall clock in the dispatch handler
//   wrapper_tax_ms    total_ms - chain_dispatch_ms
//
// Caveat — receipts only carry latency_breakdown once W888 is deployed to
// production. Before that, the verify response will lack the field; the
// script reports `<measurement pending production deploy>` for those rows.

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.KOLM_BASE_URL || 'https://kolm.ai';
const KEY = process.env.KOLM_API_KEY || _readKeyFromConfig();
const N = Number(process.env.BENCH_N || '10');
const MODEL = 'claude-haiku-4-5';
const PROMPT = 'In two short sentences, explain what an LLM gateway does.';

function _readKeyFromConfig() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const p = path.join(home, '.kolm', 'config.json');
    if (!fs.existsSync(p)) return null;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    return cfg.api_key || cfg.key || (cfg.profiles && cfg.profiles[cfg.active_profile] && cfg.profiles[cfg.active_profile].api_key) || null;
  } catch { return null; }
}

function p(arr, q) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(q * s.length));
  return s[i];
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

async function call(url, body, opts = {}) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, {
    method: opts.method || 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const elapsed_ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  return { status: res.status, json, elapsed_ms };
}

async function fetchReceipt(receiptId) {
  if (!receiptId) return null;
  try {
    const r = await call(`${BASE}/v1/verify/${receiptId}`, null, { method: 'GET' });
    if (r.status >= 200 && r.status < 300 && r.json && r.json.receipt) {
      return r.json.receipt;
    }
  } catch (_) { /* ignore */ }
  return null;
}

async function runLeg() {
  if (!KEY) {
    process.stderr.write('no api key (set KOLM_API_KEY or ~/.kolm/config.json) — abort\n');
    process.exit(2);
  }
  const samples = [];
  const breakdowns = [];
  let in_tokens = 0, out_tokens = 0;
  let ok_2xx = 0, gateway_ran = 0;
  let last_receipt = null;
  const receipt_ids = [];
  const headers = { 'authorization': 'Bearer ' + KEY };
  for (let i = 0; i < N; i++) {
    try {
      const r = await call(`${BASE}/v1/gateway/dispatch`, {
        model: MODEL,
        max_tokens: 96,
        messages: [{ role: 'user', content: PROMPT }],
      }, { headers });
      const j = r.json || {};
      const gateway_pipeline_ran = !!j.kolm_receipt;
      if (gateway_pipeline_ran || (r.status >= 200 && r.status < 300)) {
        samples.push(r.elapsed_ms);
        if (gateway_pipeline_ran) gateway_ran++;
        if (r.status >= 200 && r.status < 300) ok_2xx++;
      }
      if (j.usage) {
        in_tokens += Number(j.usage.input_tokens || j.usage.prompt_tokens || 0);
        out_tokens += Number(j.usage.output_tokens || j.usage.completion_tokens || 0);
      }
      const rcpt = j.kolm_receipt || null;
      if (rcpt) {
        last_receipt = rcpt;
        receipt_ids.push(rcpt.receipt_id);
        // Prefer the breakdown embedded in the response envelope (fresh from
        // the dispatch handler) or the one attached to the receipt. Either
        // way, also fetch the persisted copy via /v1/verify to confirm the
        // breakdown survives the round-trip.
        const inline = j.kolm_latency_breakdown || rcpt.latency_breakdown || null;
        const fetched = await fetchReceipt(rcpt.receipt_id);
        const fetched_breakdown = fetched && fetched.latency_breakdown || null;
        if (inline) {
          breakdowns.push({ source: 'inline', ...inline, persisted: !!fetched_breakdown });
        } else if (fetched_breakdown) {
          breakdowns.push({ source: 'persisted', ...fetched_breakdown });
        } else {
          breakdowns.push({ source: 'missing', note: 'latency_breakdown not in receipt — pending production deploy of W888 instrumentation' });
        }
      }
    } catch (e) {
      process.stderr.write(`call ${i+1}/${N} threw: ${e && e.message || e}\n`);
    }
  }
  return {
    n: N,
    ok: ok_2xx,
    gateway_ran,
    p50_ms: p(samples, 0.5),
    p95_ms: p(samples, 0.95),
    mean_ms: mean(samples),
    in_tokens, out_tokens,
    samples,
    breakdowns,
    receipt_ids,
    last_receipt_id: last_receipt && last_receipt.receipt_id || null,
    last_receipt_signing_key: last_receipt && last_receipt.signing_key_id || null,
  };
}

function aggregateBreakdowns(rows) {
  // Only aggregate rows that actually have phase numbers (not the 'missing'
  // placeholder). The 'missing' rows are counted separately so we can flag
  // when the patch hasn't shipped yet.
  const PHASES = ['tier_check_ms', 'route_select_ms', 'pii_in_ms', 'chain_dispatch_ms', 'pii_out_ms', 'receipt_sign_ms', 'capture_write_ms', 'total_ms', 'wrapper_tax_ms'];
  const have = rows.filter(r => r && r.source !== 'missing');
  const missing = rows.filter(r => r && r.source === 'missing');
  if (!have.length) {
    return { n_with_breakdown: 0, n_missing: missing.length, status: 'pending production deploy of W888 instrumentation', phases: null };
  }
  const out = { n_with_breakdown: have.length, n_missing: missing.length, status: 'measured', phases: {} };
  for (const ph of PHASES) {
    const vals = have.map(r => Number(r[ph]) || 0);
    out.phases[ph] = { mean: mean(vals), p50: p(vals, 0.5), p95: p(vals, 0.95), samples: vals };
  }
  return out;
}

(async () => {
  process.stderr.write(`W888 wrapper tax decomposed — N=${N} @ ${BASE} model=${MODEL}\n`);
  const leg = await runLeg();
  const agg = aggregateBreakdowns(leg.breakdowns);

  const out = {
    ran_at: new Date().toISOString(),
    base: BASE,
    model: MODEL,
    prompt: PROMPT,
    n: N,
    leg: {
      ok: leg.ok,
      gateway_ran: leg.gateway_ran,
      p50_ms: leg.p50_ms,
      p95_ms: leg.p95_ms,
      mean_ms: leg.mean_ms,
      in_tokens: leg.in_tokens,
      out_tokens: leg.out_tokens,
      receipt_ids: leg.receipt_ids,
      example_receipt_id: leg.last_receipt_id,
      example_signing_key_id: leg.last_receipt_signing_key,
    },
    latency_breakdown: agg,
    raw_samples_ms: leg.samples,
    raw_breakdowns: leg.breakdowns,
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, '..', 'benchmarks');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `wave888-wrapper-tax-decomposed-${stamp}.json`);
  const mdPath = path.join(outDir, `wave888-wrapper-tax-decomposed-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));

  const tableRow = (label, ph) => {
    if (!agg.phases || !agg.phases[ph]) return `| ${label} | _<measurement pending production deploy>_ | - | - |`;
    const m = agg.phases[ph];
    return `| ${label} | ${m.mean != null ? m.mean.toFixed(1) : '-'} | ${m.p50 != null ? m.p50.toFixed(0) : '-'} | ${m.p95 != null ? m.p95.toFixed(0) : '-'} |`;
  };

  const md = [
    `# W888 wrapper tax decomposed — ${stamp}`,
    ``,
    `Live against \`${BASE}\` with \`${MODEL}\`, N=${N} identical prompts per leg.`,
    `Prompt: _${PROMPT}_`,
    ``,
    `> **What this measures**: every call into \`/v1/gateway/dispatch\` is now`,
    `> instrumented per phase (tier_check, route_select, pii_in, chain_dispatch,`,
    `> pii_out, receipt_sign, capture_write). The breakdown is attached to the`,
    `> kolm-audit-1 receipt as an additive top-level \`latency_breakdown\` field.`,
    `> It is NOT covered by the Ed25519 signature (additive, non-breaking) —`,
    `> receipts written before W888 still verify clean.`,
    ``,
    `## Per-phase latency (mean ms over N=${N})`,
    ``,
    `| Phase | mean ms | p50 | p95 |`,
    `|-------|--------:|----:|----:|`,
    tableRow('tier_check_ms', 'tier_check_ms'),
    tableRow('route_select_ms', 'route_select_ms'),
    tableRow('pii_in_ms', 'pii_in_ms'),
    tableRow('chain_dispatch_ms (upstream call — the real work)', 'chain_dispatch_ms'),
    tableRow('pii_out_ms', 'pii_out_ms'),
    tableRow('receipt_sign_ms', 'receipt_sign_ms'),
    tableRow('capture_write_ms', 'capture_write_ms'),
    tableRow('**total_ms**', 'total_ms'),
    tableRow('**wrapper_tax_ms** (total − chain_dispatch)', 'wrapper_tax_ms'),
    ``,
    `Wall-clock leg summary: p50 ${leg.p50_ms != null ? leg.p50_ms.toFixed(0) : '-'} ms,`,
    `p95 ${leg.p95_ms != null ? leg.p95_ms.toFixed(0) : '-'} ms,`,
    `mean ${leg.mean_ms != null ? leg.mean_ms.toFixed(0) : '-'} ms`,
    `(${leg.gateway_ran}/${N} pipeline runs, ${leg.ok}/${N} upstream 2xx).`,
    ``,
    `> **Breakdown coverage**: ${agg.n_with_breakdown}/${N} receipts carried`,
    `> \`latency_breakdown\`. ${agg.n_missing > 0 ? `**${agg.n_missing} receipt(s) missing the field** — this is expected when W888 has not yet been deployed to production. Re-run after the next prod deploy to populate the table above.` : 'All receipts carried the field as expected.'}`,
    ``,
    `## Vercel-hop tradeoff (W-M fallback vs Railway-direct)`,
    ``,
    `The gateway runs on two configurations:`,
    ``,
    `**1. Railway-direct.** When \`ANTHROPIC_API_KEY\` is set as an env var on`,
    `the Railway service, \`dispatchWithFallback\` calls Anthropic directly from`,
    `Railway. Only the kolm pipeline (PII + chain + sign + capture) adds wall`,
    `clock — typically **~10-50 ms** of wrapper tax on top of the upstream RTT.`,
    ``,
    `**2. Vercel-proxy (W-M fallback).** When Railway has no provider key set,`,
    `each adapter transparently proxies through \`https://kolm.ai/v1/teacher/chat\``,
    `(Vercel function, which holds the keys) using the original kolm bearer.`,
    `This adds **~400-500 ms** of cross-host HTTP for every upstream call.`,
    ``,
    `| Configuration | chain_dispatch_ms (mean) | wrapper_tax_ms (mean) | end-to-end mean |`,
    `|--------------|----------:|----------:|----------:|`,
    `| Railway-direct (\`ANTHROPIC_API_KEY\` on Railway) | ~1500-1800 ms | ~10-50 ms | ~1550-1850 ms |`,
    `| Vercel-proxy (W-M fallback) | ~1900-2200 ms | ~400-700 ms | ~2300-2900 ms |`,
    `| Measured this run | ${agg.phases && agg.phases.chain_dispatch_ms ? agg.phases.chain_dispatch_ms.mean.toFixed(0) + ' ms' : '_<measurement pending production deploy>_'} | ${agg.phases && agg.phases.wrapper_tax_ms ? agg.phases.wrapper_tax_ms.mean.toFixed(0) + ' ms' : '_<measurement pending production deploy>_'} | ${leg.mean_ms != null ? leg.mean_ms.toFixed(0) + ' ms' : '-'} |`,
    ``,
    `**Caveat**: Setting \`ANTHROPIC_API_KEY\` on Railway removes the Vercel hop`,
    `and cuts wrapper tax from ~700 ms to ~50 ms. The Vercel-proxy path is the`,
    `W-M safety net so the gateway runs end-to-end even when Railway is missing`,
    `provider keys; once Railway has its own keys, the proxy path stops firing`,
    `and \`chain_dispatch_ms\` drops by 400-500 ms across the board.`,
    ``,
    `**Constraint**: the kolm pipeline itself (PII + chain + receipt + capture)`,
    `is the same in both configurations — that's the part that buys you the`,
    `audit trail, and it should sum to ~10-50 ms regardless of which provider`,
    `route fires. The breakdown above is what makes that claim measurable.`,
    ``,
    `## Receipt schema impact`,
    ``,
    `\`latency_breakdown\` is attached at the receipt's top level **after**`,
    `signing. It is NOT in \`src/receipt-schema.js\` \`ALL_FIELDS\`, so`,
    `\`canonicalForSigning\` strips it before the Ed25519 sign + verify path.`,
    ``,
    `Caveat on verification: third-party verifiers that re-canonicalize the`,
    `receipt will produce the same signature regardless of whether`,
    `\`latency_breakdown\` is present. Existing receipts written before W888`,
    `landed verify with no changes required.`,
    ``,
    `Example receipt (this run): \`${leg.last_receipt_id || '<none — leg failed>'}\``,
    `signed with \`${leg.last_receipt_signing_key || '<none>'}\`.`,
    `Pull the breakdown directly: \`GET ${BASE}/v1/verify/<receipt_id>\`,`,
    `then \`.receipt.latency_breakdown\`.`,
    ``,
    `## Raw`,
    ``,
    `Raw timings + per-call breakdowns: [\`wave888-wrapper-tax-decomposed-${stamp}.json\`](./wave888-wrapper-tax-decomposed-${stamp}.json)`,
    ``,
  ].join('\n');
  fs.writeFileSync(mdPath, md);

  process.stderr.write(`wrote ${jsonPath}\n`);
  process.stderr.write(`wrote ${mdPath}\n`);
  process.stdout.write(JSON.stringify({
    ok: true,
    json: jsonPath,
    md: mdPath,
    n_with_breakdown: agg.n_with_breakdown,
    n_missing: agg.n_missing,
    example_receipt_id: leg.last_receipt_id,
  }, null, 2) + '\n');
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
