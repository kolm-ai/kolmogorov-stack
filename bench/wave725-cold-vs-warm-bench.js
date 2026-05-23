// W725-3 — cold vs warm preloading bench.
//
// Synthesizes a stream of 100 (or --queries N) query timestamps across
// a primary 3-namespace set (`coding`, `writing`, `analytics`) with a
// temporal bias plus a tail of 3 secondary namespaces to model GPU
// memory pressure:
//
//   - mornings (UTC hour 7-11)  -> `coding` heavy
//   - afternoons (UTC hour 13-17) -> `writing` heavy
//   - other hours -> `analytics` baseline
//   - all hours: small share of `chat`, `search`, `agent` (tail namespaces)
//
// Then runs two passes over the SAME query stream:
//
//   cold_run: each query is processed in arrival order with NO preload.
//             The first query against a namespace pays the cold-load cost
//             (COLD_LOAD_MS). Subsequent queries against the same namespace
//             pay the cached cost (WARM_QUERY_MS).
//
//   warm_run: BEFORE each query, we ask schedulePreload() what to preload
//             based on the history-so-far. Any predicted namespace that is
//             not yet warm pays the cold load in the BACKGROUND (modeled
//             as zero added latency — the preload happens off the critical
//             path). Then the actual query arrives; if its namespace is
//             now warm (either via preload or via a previous query), it
//             pays WARM_QUERY_MS; otherwise it pays COLD_LOAD_MS.
//
// Reports:
//   {
//     queries, namespaces, scheduler_version,
//     cold_total_ms, warm_total_ms,
//     savings_ms, savings_pct,
//     namespace_hit_rate, // fraction of queries whose namespace was preloaded
//                         // by the scheduler within the most recent prediction
//     per_namespace: { ns: {queries, cold_ms, warm_ms}, ... }
//   }
//
// CLI:
//   node bench/wave725-cold-vs-warm-bench.js --json [--queries N] [--seed S]
//
// --json prints machine-parseable JSON on stdout (and ONLY JSON). Otherwise
// a brief human-readable summary is printed.
//
// HONESTY: this is a SYNTHETIC bench, not a real GPU/load measurement.
// "Cold" and "warm" costs are constants (COLD_LOAD_MS, WARM_QUERY_MS). The
// purpose is to validate the SCHEDULER'S HIT RATE — not to claim a real-
// world latency number. The numbers it prints are useful for regression
// detection on the predictor's quality, not as a marketing benchmark.

import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  PRELOAD_SCHEDULER_VERSION,
  schedulePreload,
} from '../src/preload-scheduler.js';

// Synthetic latencies. Tuned so warm queries are an order of magnitude
// cheaper than cold loads (typical for transformer weight materialization
// off NVMe). Cold is 8000ms (8s — realistic 32B-class model load); warm
// is 50ms (token-budget-limited inference round-trip).
const COLD_LOAD_MS = 8000;
const WARM_QUERY_MS = 50;

// Primary set — the temporally-biased namespaces that the time-bucket
// predictor learns to anticipate.
const PRIMARY_NAMESPACES = Object.freeze(['coding', 'writing', 'analytics']);
// Tail — small share so the namespace universe exceeds the cache slot
// count, producing eviction pressure on cold_run. Without this tail, an
// LRU of size SLOT_COUNT would never evict and predictive preloading
// would have nothing to save against.
const TAIL_NAMESPACES = Object.freeze(['chat', 'search', 'agent']);
const NAMESPACES = Object.freeze([...PRIMARY_NAMESPACES, ...TAIL_NAMESPACES]);

// Bounded slot count for warmth. Models GPU memory pressure — only this
// many namespaces can be resident at once. When a (SLOT_COUNT+1)-th
// namespace would load, the least-recently-used one is evicted (and its
// next query then pays COLD_LOAD_MS again). With 6 candidate namespaces
// and SLOT_COUNT=2, cold_run incurs eviction-induced thrash that the
// scheduler's preloads can avert by keeping the predicted-next namespace
// pre-resident.
const SLOT_COUNT = 2;

// Tiny LRU helper for the cache model. Keeps insertion-order Map and bumps
// keys on access to maintain LRU ordering.
function _lruTouch(lru, key) {
  if (lru.has(key)) lru.delete(key);
  lru.set(key, true);
}
function _lruEnsure(lru, key, capacity) {
  // Returns true if `key` was already resident (warm), false if it had to
  // be loaded (cold). On a cold load, may evict the LRU key.
  if (lru.has(key)) {
    _lruTouch(lru, key);
    return true;
  }
  lru.set(key, true);
  while (lru.size > capacity) {
    // Evict the least-recently-used (first inserted) entry.
    const oldest = lru.keys().next().value;
    lru.delete(oldest);
  }
  return false;
}

// Deterministic pseudo-random with a seed; we don't want flake from real
// Math.random under CI. Mulberry32 — small + fast + good distribution for
// non-cryptographic synthesis.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bias the namespace pick by the UTC hour of `ts`. Primary 3 namespaces
// get a temporal bias; tail 3 share the remaining 10% uniformly to model
// "uncommon but real" workloads (chat sidebar, search, agent runs).
function biasedNamespace(ts, rand) {
  const hour = new Date(ts).getUTCHours();
  // Primary share = 0.9; tail share = 0.1 (split evenly across TAIL_NAMESPACES).
  let pCoding;
  let pWriting;
  let pAnalytics;
  if (hour >= 7 && hour <= 11) {
    // Morning -> coding heavy.
    pCoding = 0.63; pWriting = 0.18; pAnalytics = 0.09;
  } else if (hour >= 13 && hour <= 17) {
    // Afternoon -> writing heavy.
    pCoding = 0.135; pWriting = 0.63; pAnalytics = 0.135;
  } else {
    // Off-peak hours -> analytics baseline.
    pCoding = 0.27; pWriting = 0.18; pAnalytics = 0.45;
  }
  const r = rand();
  if (r < pCoding) return 'coding';
  if (r < pCoding + pWriting) return 'writing';
  if (r < pCoding + pWriting + pAnalytics) return 'analytics';
  // Tail bucket — pick uniformly across TAIL_NAMESPACES.
  const idx = Math.floor((r - (pCoding + pWriting + pAnalytics)) /
    ((1 - pCoding - pWriting - pAnalytics) / TAIL_NAMESPACES.length));
  return TAIL_NAMESPACES[Math.min(idx, TAIL_NAMESPACES.length - 1)];
}

// Build the synthetic query stream of length N. Timestamps span 2 weeks
// (across 14 days) so each hour bucket gets multiple samples, producing
// statistically-meaningful time-bucket predictions.
function synthesizeQueryStream(N, seed) {
  const rand = mulberry32(seed >>> 0);
  // Anchor to a deterministic UTC midnight to avoid timezone flake.
  const t0 = Date.UTC(2026, 4, 1, 0, 0, 0); // 2026-05-01 00:00 UTC
  const queries = [];
  for (let i = 0; i < N; i += 1) {
    // Spread queries across 14 days. Position within day weighted toward
    // working hours so we get plenty of morning/afternoon samples.
    const day = Math.floor((i / N) * 14);
    // Hour pick: 60% inside [7..17] (working hours), 40% across other hours.
    let hour;
    if (rand() < 0.6) {
      hour = 7 + Math.floor(rand() * 11); // 7..17
    } else {
      hour = Math.floor(rand() * 24);
    }
    const minute = Math.floor(rand() * 60);
    const second = Math.floor(rand() * 60);
    const ts = t0 + day * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000;
    const ns = biasedNamespace(ts, rand);
    queries.push({ namespace: ns, timestamp: ts });
  }
  // Sort chronologically so the Markov chain sees real order. Stable enough
  // because the bench is single-pass.
  queries.sort((a, b) => a.timestamp - b.timestamp);
  return queries;
}

// ---------------------------------------------------------------------------
// cold_run — no preload, costs accrued in arrival order.
// ---------------------------------------------------------------------------

function runCold(queries) {
  // Bounded LRU cache (SLOT_COUNT slots). With more namespaces than slots,
  // we deliberately incur thrash — that's the failure mode predictive
  // preloading is supposed to mitigate.
  const lru = new Map();
  let totalMs = 0;
  let coldMisses = 0;
  const perNs = {};
  for (const q of queries) {
    if (!perNs[q.namespace]) perNs[q.namespace] = { queries: 0, ms: 0 };
    perNs[q.namespace].queries += 1;
    const wasWarm = _lruEnsure(lru, q.namespace, SLOT_COUNT);
    const cost = wasWarm ? WARM_QUERY_MS : COLD_LOAD_MS;
    if (!wasWarm) coldMisses += 1;
    perNs[q.namespace].ms += cost;
    totalMs += cost;
  }
  return { totalMs, perNs, coldMisses };
}

// ---------------------------------------------------------------------------
// warm_run — schedulePreload() consulted before each query.
// ---------------------------------------------------------------------------

function runWarm(queries, tenant) {
  // We never actually call recordQuery here — the bench is in-memory only
  // (we don't want to pollute the user's KOLM_DATA_DIR with bench rows). The
  // history-so-far is a slice of the queries array, which is precisely the
  // shape schedulePreload expects (`{namespace, timestamp}` rows).
  void tenant; // tenant fence is not required for in-memory predictions.

  // Same bounded cache model as cold_run — fair comparison.
  const lru = new Map();
  let totalMs = 0;
  let preloadHits = 0; // queries whose namespace was in the most-recent prediction
  let coldMisses = 0;
  let preloadEvents = 0;
  const perNs = {};

  for (let i = 0; i < queries.length; i += 1) {
    const q = queries[i];
    const historySoFar = queries.slice(0, i);
    const preds = schedulePreload({
      now_ts: q.timestamp,
      recent_history: historySoFar,
      // current_namespace = the most recent query namespace, if any.
      // This is the input to the Markov side of the composed predictor.
      current_namespace: i > 0 ? queries[i - 1].namespace : undefined,
    });

    // BEFORE the query arrives: pre-warm the top predicted namespace if
    // it's not already resident. Off the critical path -> zero added
    // latency to the bench's tracked total. We pre-warm only the TOP-1
    // (the runtime decides how many slots to allocate to speculation;
    // top-1 keeps the demo conservative against single-slot eviction).
    if (preds.length > 0) {
      const top = preds[0].namespace;
      const wasResident = lru.has(top);
      _lruEnsure(lru, top, SLOT_COUNT);
      if (!wasResident) preloadEvents += 1;
    }

    // Did the scheduler predict the actual namespace of the incoming query?
    const predicted = preds.some((p) => p.namespace === q.namespace);
    if (predicted) preloadHits += 1;

    if (!perNs[q.namespace]) perNs[q.namespace] = { queries: 0, ms: 0 };
    perNs[q.namespace].queries += 1;

    const wasWarm = _lruEnsure(lru, q.namespace, SLOT_COUNT);
    const cost = wasWarm ? WARM_QUERY_MS : COLD_LOAD_MS;
    if (!wasWarm) coldMisses += 1;
    perNs[q.namespace].ms += cost;
    totalMs += cost;
  }
  const hitRate = queries.length > 0 ? preloadHits / queries.length : 0;
  return { totalMs, perNs, preloadHits, hitRate, coldMisses, preloadEvents };
}

// ---------------------------------------------------------------------------
// Glue: report assembly
// ---------------------------------------------------------------------------

function runBench({ queries, seed }) {
  const stream = synthesizeQueryStream(queries, seed);
  const cold = runCold(stream);
  // Synthetic tenant id used for the warm-run hook; never touched on disk.
  const benchTenant = 'bench_' + crypto.randomBytes(4).toString('hex');
  const warm = runWarm(stream, benchTenant);
  const savings_ms = cold.totalMs - warm.totalMs;
  const savings_pct = cold.totalMs > 0 ? (savings_ms / cold.totalMs) * 100 : 0;
  const perNamespace = {};
  for (const ns of NAMESPACES) {
    const c = cold.perNs[ns] || { queries: 0, ms: 0 };
    const w = warm.perNs[ns] || { queries: 0, ms: 0 };
    perNamespace[ns] = {
      queries: c.queries,
      cold_ms: c.ms,
      warm_ms: w.ms,
    };
  }
  return {
    ok: true,
    scheduler_version: PRELOAD_SCHEDULER_VERSION,
    queries,
    namespaces: NAMESPACES.length,
    seed,
    cold_total_ms: cold.totalMs,
    warm_total_ms: warm.totalMs,
    savings_ms,
    savings_pct: Number(savings_pct.toFixed(2)),
    namespace_hit_rate: Number(warm.hitRate.toFixed(4)),
    preload_hits: warm.preloadHits,
    per_namespace: perNamespace,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function _parseArgs(argv) {
  const out = { json: false, queries: 100, seed: 42 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--queries' && i + 1 < argv.length) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.queries = Math.floor(n);
      i += 1;
    } else if (a === '--seed' && i + 1 < argv.length) {
      const s = Number(argv[i + 1]);
      if (Number.isFinite(s)) out.seed = Math.floor(s);
      i += 1;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function _printHelp() {
  // eslint-disable-next-line no-console
  console.log([
    'wave725-cold-vs-warm-bench.js — predict-and-preload latency bench',
    '',
    'Usage: node bench/wave725-cold-vs-warm-bench.js [--json] [--queries N] [--seed S]',
    '',
    '  --json       Print JSON only (machine-parseable).',
    '  --queries N  Number of synthetic queries to replay (default 100).',
    '  --seed S     PRNG seed for stream synthesis (default 42).',
    '  --help, -h   This help.',
  ].join('\n'));
}

function _humanReport(report) {
  const lines = [
    'W725 cold-vs-warm preload bench',
    '  scheduler:      ' + report.scheduler_version,
    '  queries:        ' + report.queries,
    '  namespaces:     ' + report.namespaces,
    '  cold_total_ms:  ' + report.cold_total_ms,
    '  warm_total_ms:  ' + report.warm_total_ms,
    '  savings_ms:     ' + report.savings_ms,
    '  savings_pct:    ' + report.savings_pct.toFixed(2) + '%',
    '  hit_rate:       ' + (report.namespace_hit_rate * 100).toFixed(2) + '%',
  ];
  return lines.join('\n');
}

function _main() {
  const args = _parseArgs(process.argv.slice(2));
  if (args.help) {
    _printHelp();
    process.exit(0);
  }
  const report = runBench({ queries: args.queries, seed: args.seed });
  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report));
  } else {
    // eslint-disable-next-line no-console
    console.log(_humanReport(report));
  }
  process.exit(0);
}

// Only run the CLI when invoked directly (`node bench/wave725-...js`),
// not when imported as a module.
const __filename = fileURLToPath(import.meta.url);
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invokedDirectly) _main();

export { runBench, synthesizeQueryStream, COLD_LOAD_MS, WARM_QUERY_MS, NAMESPACES };
