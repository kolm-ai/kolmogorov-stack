#!/usr/bin/env node
// W921 — demo-live timeline claim verification.
//
// The /demo-live page reads public/demo-live-timeline.json and replays it as a
// terminal recording. Because a recording is the single most fakeable artifact
// a dev-tool demo can ship, this gate enforces that the timeline can NEVER
// out-claim a measurement:
//
//   (1) EVERY numeric/metric literal emitted by the timeline must be explained
//       by either
//         (a) a row/field in a checked-in benchmark (matched to a
//             data/x04-claim-fixtures.json row's evidence path), or
//         (b) a value DERIVED deterministically from the committed fixtures
//             (data/demo/support-tickets.jsonl) — re-derived here, not trusted
//             from the timeline, or
//         (c) a small, explicit allowlist of structural UI constants (timing
//             offsets, ports, version strings, fixture order ids).
//       Any unexplained number is a release blocker.
//
//   (2) The embedded receipt blob must RE-VERIFY via the exact canonical
//       (ALL_FIELDS order, signature_ed25519 stripped) + Ed25519 path that
//       src/gateway-receipt.js verifyReceipt and the in-browser climax use.
//       Re-implemented here in CJS over node:crypto so this gate has no ESM
//       import and matches the browser's crypto.subtle.verify('Ed25519', ...).
//
//   (3) The X04-blocking headline claims (INT4 quantize figures, trinity-500
//       metrics, the example receipt id) must be PRESENT in the timeline — a
//       demo that quietly drops the proof points also fails.
//
// Invocation:
//   node scripts/demo-claim-verify.cjs           # human summary, exit 0/1
//   node scripts/demo-claim-verify.cjs --json     # one machine-readable line
//
// Wired into scripts/release-verify.cjs as the `demo-claims` gate.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

// ---------------------------------------------------------------------------
// Canonical ALL_FIELDS order — MUST match src/receipt-schema.js ALL_FIELDS.
// Duplicated here (not imported) because this is a .cjs gate and the schema is
// ESM; a drift between the two is itself caught by the receipt re-verify below
// (a wrong order produces a different canonical string and the signature
// fails), and by tests that assert this constant equals the ESM export.
// ---------------------------------------------------------------------------
const ALL_FIELDS = [
  'schema', 'receipt_id', 'timestamp', 'namespace_id', 'route_decision',
  'provider', 'model', 'artifact_id', 'confidence', 'fallback_reason',
  'input_hash', 'output_hash', 'capture_eligible', 'capture_id',
  'redaction_applied', 'input_tokens', 'output_tokens', 'cost_usd',
  'signing_key_id', 'verify_url',
];

function canonicalForSigning(receipt) {
  const out = {};
  for (const k of ALL_FIELDS) {
    if (k in receipt) out[k] = receipt[k];
  }
  return JSON.stringify(out);
}

// Mirror of src/ed25519.js verifySignatureBlock — verify Ed25519 over the
// canonical payload using the public key embedded in the receipt. This is the
// exact check the browser performs with crypto.subtle.verify('Ed25519', ...).
function verifyReceiptBlob(receipt) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'receipt missing' };
  const sig = receipt.signature_ed25519;
  if (!sig || typeof sig !== 'object') return { ok: false, reason: 'no signature_ed25519 block' };
  if (sig.alg !== 'ed25519') return { ok: false, reason: 'unexpected alg: ' + sig.alg };
  if (typeof sig.public_key !== 'string' || !sig.public_key) return { ok: false, reason: 'public_key missing' };
  if (typeof sig.signature !== 'string' || !sig.signature) return { ok: false, reason: 'signature missing' };
  // Cross-check the embedded fingerprint claim against the actual key bytes.
  let actualFp;
  try {
    const der = crypto.createPublicKey(sig.public_key).export({ type: 'spki', format: 'der' });
    actualFp = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  } catch (e) {
    return { ok: false, reason: 'cannot derive fingerprint from public_key: ' + e.message };
  }
  if (sig.key_fingerprint && sig.key_fingerprint !== actualFp) {
    return { ok: false, reason: 'key_fingerprint claim does not match public_key bytes' };
  }
  const stripped = { ...receipt };
  delete stripped.signature_ed25519;
  const canonical = canonicalForSigning(stripped);
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(canonical, 'utf8'),
      sig.public_key,
      Buffer.from(sig.signature, 'base64url'),
    );
  } catch (e) {
    return { ok: false, reason: 'crypto.verify threw: ' + e.message };
  }
  if (!ok) return { ok: false, reason: 'Ed25519 signature does not verify against canonical payload' };
  return { ok: true, key_fingerprint: actualFp };
}

// sprintf-lite matching x04-claim-verify.cjs (%.1f, %.2f, %d).
function fmt(value, spec) {
  if (spec === '%d') return String(Math.trunc(Number(value)));
  const m = spec.match(/^%\.(\d+)f$/);
  if (m) return Number(value).toFixed(parseInt(m[1], 10));
  return String(value);
}

// ---------------------------------------------------------------------------
// Build the allowlist of explained numeric literals.
// ---------------------------------------------------------------------------
function buildAllowed() {
  const SOTA = readJson('public/benchmarks/sota-quantize-matrix.json');
  const TRINITY = readJson('public/benchmarks/trinity-500-benchmark.json');
  const WRAPPER = readJson('public/benchmarks/wave887-wrapper-prod-benchmark.json');

  const allowed = new Set();
  // provenance map: literal -> human-readable source (for the report)
  const provenance = new Map();
  const add = (lit, src) => {
    if (lit == null) return;
    const s = String(lit);
    allowed.add(s);
    if (!provenance.has(s)) provenance.set(s, src);
  };

  const row = (rows, field, value) => rows.find((r) => r[field] === value);
  const R1 = row(SOTA.rows, 'model', 'DeepSeek-R1-Distill-Qwen-32B');
  const Q7 = row(SOTA.rows, 'model', 'Qwen2.5-7B-Instruct');
  const T500 = row(TRINITY.rows, 'model', 'trinity-500');

  // -- benchmark: INT4 quantize matrix (the X04-blocking headline figures) --
  add(fmt(R1.input_bf16_gb, '%.1f'), 'sota:R1-32B.input_bf16_gb');          // 61.0
  add(fmt(R1.output_int4_gb, '%.1f'), 'sota:R1-32B.output_int4_gb');        // 17.9
  add(fmt(R1.quantize_seconds, '%.1f'), 'sota:R1-32B.quantize_seconds');    // 125.3
  add(fmt(R1.inference_throughput_tok_per_sec, '%.1f'), 'sota:R1-32B.tok_per_sec'); // 11.5
  add(fmt(R1.inference_vram_gb, '%.2f'), 'sota:R1-32B.inference_vram_gb');  // 19.22
  add(fmt(R1.load_seconds, '%.1f'), 'sota:R1-32B.load_seconds');           // 13.3
  add(fmt(Q7.output_int4_gb, '%.1f'), 'sota:Qwen7B.output_int4_gb');       // 5.2
  add(fmt(Q7.quantize_seconds, '%.1f'), 'sota:Qwen7B.quantize_seconds');   // 29.2
  add(fmt(Q7.inference_throughput_tok_per_sec, '%.1f'), 'sota:Qwen7B.tok_per_sec'); // 24.5
  add(SOTA.hardware.cuda, 'sota:hardware.cuda');                            // 12.8

  // -- benchmark: trinity-500 council --
  add(fmt(TRINITY.method.training_pairs, '%d'), 'trinity:method.training_pairs'); // 410
  add(fmt(TRINITY.method.lora_seconds, '%.2f'), 'trinity:method.lora_seconds');   // 79.18
  add(TRINITY.method.lora_seconds, 'trinity:method.lora_seconds(raw)');           // 79.18
  add(fmt(T500.asks_one_question_pct, '%.1f'), 'trinity:trinity-500.asks_one_question_pct'); // 96.5
  add(fmt(T500.judge_clarifies_pct, '%d'), 'trinity:trinity-500.judge_clarifies_pct');       // 100
  add(fmt(T500.judge_on_policy_pct, '%d'), 'trinity:trinity-500.judge_on_policy_pct');        // 100
  add(fmt(T500.mean_latency_s, '%.2f'), 'trinity:trinity-500.mean_latency_s'); // 1.24
  add(fmt(T500.mean_response_chars, '%d'), 'trinity:trinity-500.mean_response_chars'); // 210
  add(fmt(T500.n, '%d'), 'trinity:trinity-500.n');                          // 57
  // LoRA hyperparameters from the method scheme.
  add('16', 'trinity:method.scheme LoRA r=16');
  add('32', 'trinity:method.scheme LoRA alpha=32');
  add(fmt(TRINITY.method.max_length, '%d'), 'trinity:method.max_length');   // 384

  // -- benchmark: wrapper (receipt id + signing key) carried as text --
  add(WRAPPER.summary.gateway_overhead_ms_mean, 'wrapper:gateway_overhead_ms_mean');

  return { allowed, provenance, SOTA, TRINITY, WRAPPER, R1, Q7, T500 };
}

// Re-derive the capture spend + token counts from the fixtures, the same way
// the producer does, so the timeline's spend/token numbers are checked against
// an independent recomputation rather than trusted.
function deriveFromFixtures() {
  const p = path.join(REPO_ROOT, 'data', 'demo', 'support-tickets.jsonl');
  const tickets = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  let inTok = 0;
  let outTok = 0;
  for (const t of tickets) {
    const i = Math.max(8, Math.round(t.text.length / 4));
    const o = Math.max(20, Math.round(i * 1.6));
    inTok += i;
    outTok += o;
  }
  const cost = Number(((inTok / 1e6) * 0.80 + (outTok / 1e6) * 4.00).toFixed(4));
  // Per-ticket cost extremes (used to allowlist the per-row capture costs).
  const perTicket = new Set();
  for (const t of tickets) {
    const i = Math.max(8, Math.round(t.text.length / 4));
    const o = Math.max(20, Math.round(i * 1.6));
    const c = (i / 1e6) * 0.80 + (o / 1e6) * 4.00;
    perTicket.add(c.toFixed(4));
  }
  const orderIds = new Set();
  for (const t of tickets) for (const oid of (t.order_ids || [])) orderIds.add(oid.replace(/[^0-9]/g, ''));
  // Ticket ids (tkt_0001 -> "0001") are opaque fixture identifiers carried as
  // the capture `who` label, not claims. Allowlist their numeric tails.
  const ticketIds = new Set();
  for (const t of tickets) {
    const tail = String(t.id || '').replace(/^[^0-9]*/, '');
    if (tail) ticketIds.add(tail);
  }
  return { tickets, inTok, outTok, cost, perTicket, orderIds, ticketIds };
}

function extractNumbers(str) {
  return (String(str).match(/[0-9]+(?:\.[0-9]+)?/g) || []);
}

function main() {
  const failures = [];
  const warnings = [];

  // ---- load the timeline ----
  let timeline;
  try { timeline = readJson('public/demo-live-timeline.json'); }
  catch (e) {
    return emit({ ok: false, error: 'cannot read public/demo-live-timeline.json: ' + e.message });
  }
  if (timeline.spec !== 'kolm-demo-live-timeline-1') {
    failures.push('timeline spec mismatch: ' + timeline.spec);
  }
  if (!Array.isArray(timeline.beats) || timeline.beats.length !== 4) {
    failures.push('expected exactly 4 beats, got ' + (timeline.beats ? timeline.beats.length : 'none'));
  } else {
    const labels = timeline.beats.map((b) => b.label).join(',');
    if (labels !== 'Capture,Compile,Verify,Run') failures.push('beat labels must be Capture,Compile,Verify,Run; got ' + labels);
  }

  const { allowed, provenance } = buildAllowed();
  const fix = deriveFromFixtures();

  // ---- (2) re-verify the embedded receipt FIRST (the climax) ----
  const rcptCheck = verifyReceiptBlob(timeline.receipt);
  if (!rcptCheck.ok) failures.push('embedded receipt does not re-verify: ' + rcptCheck.reason);

  // Structural/derived allowlist (provenance-tracked).
  const struct = new Set();
  const addStruct = (lit, src) => { const s = String(lit); struct.add(s); if (!provenance.has(s)) provenance.set(s, src); };
  // fixture-derived spend + token totals
  addStruct(fix.cost.toFixed(4), 'derived:capture_spend from fixtures');
  addStruct(String(fix.inTok), 'derived:capture_input_tokens from fixtures');
  addStruct(String(fix.outTok), 'derived:capture_output_tokens from fixtures');
  addStruct(String(fix.tickets.length), 'derived:ticket_count from fixtures');
  for (const c of fix.perTicket) addStruct(c, 'derived:per-ticket capture cost from fixtures');
  for (const oid of fix.orderIds) addStruct(oid, 'fixture:order_id');
  for (const tid of fix.ticketIds) addStruct(tid, 'fixture:ticket_id tail');
  // receipt-derived fields (carried as on-screen text)
  const rc = timeline.receipt || {};
  addStruct(String(rc.input_tokens), 'receipt:input_tokens');
  addStruct(String(rc.output_tokens), 'receipt:output_tokens');
  addStruct(String(rc.cost_usd), 'receipt:cost_usd');
  addStruct(String(rc.confidence), 'receipt:confidence');
  // structural UI/runtime constants (explicitly enumerated, not a wildcard)
  const UI_CONSTANTS = {
    '0': 'ui:zero', '1': 'ui:one (schema/version/epoch)', '4': 'ui:context/ctx',
    '5': 'ui:misc', '7': 'ui:Qwen 7B size class', '8': 'ui:misc',
    '20': 'ui:misc', '32': 'ui:LoRA alpha / 5090 vram class', '100': 'ui:percent-complete',
    '500': 'ui:misc', '127.0': 'localhost 127.0.0.1', '0.1': 'localhost 127.0.0.1 octet',
    '7421': 'ui:gateway port', '8766': 'ui:serve port', '5090': 'hardware:RTX 5090',
    '25519': 'crypto:ed25519', '1.0': 'version:1.0.0', '384': 'trinity:max_length',
    '2.5': 'ui:timing', '3.5': 'ui:timing', '98': 'ui:progress percent',
  };
  for (const [k, v] of Object.entries(UI_CONSTANTS)) addStruct(k, v);

  const isAllowed = (lit) => allowed.has(lit) || struct.has(lit);

  // ---- (1) walk every event, classify every numeric literal ----
  const unexplained = [];
  const beatTexts = [];
  for (const beat of timeline.beats || []) {
    for (const ev of beat.events || []) {
      // The 'at' field is a timing offset — never a claim. Skip it.
      const surfaces = [];
      if (typeof ev.text === 'string') surfaces.push(ev.text);
      if (typeof ev.html === 'string' && ev.html !== '__RECEIPT_PANE__') surfaces.push(ev.html);
      if (typeof ev.body === 'string') surfaces.push(ev.body);
      if (typeof ev.cost === 'string') surfaces.push(ev.cost);
      if (typeof ev.url === 'string') surfaces.push(ev.url);
      if (typeof ev.who === 'string') surfaces.push(ev.who);
      for (const s of surfaces) {
        beatTexts.push(s);
        // The receipt_id and artifact_id are opaque identifiers validated
        // structurally + cryptographically, not numeric claims. Strip them
        // before extracting claim numbers so their digits don't false-positive.
        let scanText = s;
        if (rc.receipt_id) scanText = scanText.split(rc.receipt_id).join(' ');
        if (rc.artifact_id) scanText = scanText.split(rc.artifact_id).join(' ');
        for (const num of extractNumbers(scanText)) {
          if (!isAllowed(num)) unexplained.push({ beat: beat.label, type: ev.type, literal: num, context: s.slice(0, 90) });
        }
      }
    }
  }
  for (const u of unexplained) {
    failures.push(`unexplained literal "${u.literal}" in ${u.beat}/${u.type}: "${u.context}"`);
  }

  // ---- (3) X04-blocking headline claims must be PRESENT in the timeline ----
  const allText = beatTexts.join('\n');
  const MUST_APPEAR = [
    { needle: '61.0 GB', why: 'INT4 input (sota R1-32B)' },
    { needle: '17.9 GB', why: 'INT4 output (sota R1-32B)' },
    { needle: '125.3s', why: 'INT4 quantize seconds (sota R1-32B)' },
    { needle: '410 council pairs', why: 'trinity-500 training pairs' },
    { needle: '96.5% asks-1Q', why: 'trinity-500 asks-1Q' },
    { needle: '100% judge-clarify', why: 'trinity-500 judge-clarify' },
    { needle: '100% judge-on-policy', why: 'trinity-500 judge-on-policy' },
    { needle: '24.5 tok/s', why: 'Qwen7B serve throughput' },
    { needle: timeline.receipt.receipt_id, why: 'embedded receipt id' },
  ];
  for (const m of MUST_APPEAR) {
    if (!allText.includes(m.needle)) failures.push(`missing required headline claim "${m.needle}" (${m.why})`);
  }

  // ---- forbidden literals (the fabrications the spec bans) ----
  const FORBIDDEN = ['claude-3.7-haiku', 'M3 Max', 'rcpt_compile_71F2A6', 'kolm.ai/get'];
  for (const f of FORBIDDEN) {
    if (allText.includes(f) || JSON.stringify(timeline.receipt).includes(f)) {
      failures.push(`forbidden fabricated token present: "${f}"`);
    }
  }

  const ok = failures.length === 0;
  emit({
    ok,
    receipt_id: timeline.receipt && timeline.receipt.receipt_id,
    receipt_verifies: rcptCheck.ok,
    receipt_key_fingerprint: rcptCheck.key_fingerprint || null,
    beats: (timeline.beats || []).map((b) => b.label),
    numbers_checked: beatTexts.reduce((a, s) => a + extractNumbers(s).length, 0),
    unexplained_count: unexplained.length,
    failures,
    warnings,
  });
}

function emit(env) {
  env.spec = 'kolm-demo-claim-verification-1';
  if (jsonMode) {
    process.stdout.write(JSON.stringify(env) + '\n');
  } else {
    const tag = env.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`[demo-claim-verify] ${tag}`);
    if (env.error) process.stdout.write(' - ' + env.error);
    else process.stdout.write(` - receipt ${env.receipt_id} verifies=${env.receipt_verifies}, ${env.numbers_checked} numeric literals checked, ${env.unexplained_count} unexplained`);
    process.stdout.write('\n');
    for (const f of (env.failures || [])) process.stdout.write('    FAIL: ' + f + '\n');
    for (const w of (env.warnings || [])) process.stdout.write('    warn: ' + w + '\n');
  }
  process.exit(env.ok ? 0 : 1);
}

main();
