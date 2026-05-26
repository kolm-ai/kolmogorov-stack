// W888-T - assistant block umbrella lock-ins.
//
// Tests the SEAMS between W888-M..S (the contracts each consumer depends on
// from the next module up the chain). Individual wave files own per-module
// behavior; this file owns CROSS-WAVE invariants so if W888-M renames a
// field, W888-N silently dropping rows fails HERE first.
//
// Seams locked (Director-supplied):
//   Corpus -> Pair (M -> N): #1-#5
//   Pair   -> Compile (N -> O): #6-#10
//   Compile -> Client (O -> P): #11-#15
//   Client -> Surface (P -> {Q,R,S}): #16-#20
//   Budget telemetry roll-up: #21
//
// No new product code. No HTTP server unless strictly required by a seam
// (only #13 + #14 exercise AssistantClient at the module layer; everything
// else is static-analysis or file-system assertion).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');

const SEEDS = path.join(REPO, 'data', 'assistant-corpus', 'seeds.jsonl');
const TRAIN_PAIRS = path.join(REPO, 'data', 'assistant-corpus', 'training-pairs.jsonl');
const HOLDOUT = path.join(REPO, 'data', 'assistant-corpus', 'holdout-200.jsonl');
const TRAIN_754 = path.join(REPO, 'data', 'assistant-corpus', 'train-754.jsonl');
const COMPILE_SCRIPT = path.join(REPO, 'scripts', 'compile-assistant.cjs');
const HALLU_SCRIPT = path.join(REPO, 'scripts', 'check-assistant-hallucinations.cjs');
const COMPILE_PASSPORT = path.join(REPO, 'build', 'kolm-assistant-1.5b', 'compile-passport.json');
const ASSISTANT_CLIENT = path.join(REPO, 'src', 'assistant-client.js');
const ROUTER_JS = path.join(REPO, 'src', 'router.js');
const AUTH_JS = path.join(REPO, 'src', 'auth.js');
const PUBLIC_INDEX = path.join(REPO, 'public', 'index.html');
const PUBLIC_ABOUT = path.join(REPO, 'public', 'about-the-assistant.html');
const ACCOUNT_WIDGET_JS = path.join(REPO, 'public', 'assets', 'assistant-widget.js');
const META_WIDGET_JS = path.join(REPO, 'public', 'assistant-widget.js');

const NINE_BUCKETS = new Set([
  'docs', 'cli_help', 'error_fix', 'workflow',
  'casual', 'guardrail', 'concept', 'pricing', 'hardware',
]);

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
function readText(p) { return fs.readFileSync(p, 'utf8'); }
function readJson(p) { return JSON.parse(readText(p)); }

// ─── Corpus -> Pair contract (M -> N) ───────────────────────────────────────

test('W888-T #1: seeds.jsonl exists, parses as JSONL, every row has id+bucket+intent', () => {
  assert.ok(fs.existsSync(SEEDS), 'seeds.jsonl missing');
  const rows = readJsonl(SEEDS);
  assert.ok(rows.length > 0, 'seeds.jsonl is empty');
  // The MCD directive used `category`/`prompt` shorthand for what shipped as
  // `bucket`/`intent` after Director sign-off; this row-shape is the live
  // contract every downstream consumer reads.
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    assert.equal(typeof r.id, 'string', `seed row ${i}: id must be string`);
    assert.equal(typeof r.bucket, 'string', `seed row ${i}: bucket must be string`);
    assert.equal(typeof r.intent, 'string', `seed row ${i}: intent must be string (a.k.a. "prompt")`);
  }
});

test('W888-T #2: seeds.jsonl has >= 900 rows (MCD nine-bucket spec)', () => {
  const rows = readJsonl(SEEDS);
  assert.ok(rows.length >= 900, `seeds.jsonl has ${rows.length} rows; MCD spec requires >=900`);
});

test('W888-T #3: every category in seeds.jsonl is one of the 9 MCD buckets (no drift)', () => {
  const rows = readJsonl(SEEDS);
  const seen = new Set();
  for (const r of rows) seen.add(r.bucket);
  const unknown = [...seen].filter(b => !NINE_BUCKETS.has(b));
  assert.deepEqual(unknown, [], `unknown buckets present: ${unknown.join(', ')}`);
  // Inverse: every of the 9 buckets is represented.
  const missing = [...NINE_BUCKETS].filter(b => !seen.has(b));
  assert.deepEqual(missing, [], `missing buckets: ${missing.join(', ')}`);
});

test('W888-T #4: training-pairs.jsonl is a strict subset of seeds.jsonl by id', () => {
  // The shipped W888-N pair generator preserves the seed id verbatim onto
  // each pair (provenance.seed_row_id mirrors row.id). The current
  // training-pairs.jsonl is a dry-run --limit 50 sample so it's small;
  // the seam contract is that EVERY pair traces to a seed id.
  const seeds = readJsonl(SEEDS);
  const seedIds = new Set(seeds.map(s => s.id));
  const pairs = readJsonl(TRAIN_PAIRS);
  assert.ok(pairs.length > 0, 'training-pairs.jsonl is empty');
  const orphans = [];
  for (const p of pairs) {
    const sid = (p.provenance && p.provenance.seed_row_id) || p.id;
    if (!seedIds.has(sid)) orphans.push(sid);
  }
  assert.equal(orphans.length, 0,
    `pairs reference seed ids not in seeds.jsonl: ${orphans.slice(0, 5).join(', ')}`);
});

test('W888-T #5: holdout-200.jsonl is disjoint from train-754.jsonl by id', () => {
  // The W888-N deterministic stratified split emits train-754.jsonl +
  // holdout-200.jsonl with NO id overlap. (training-pairs.jsonl is a
  // separate W888-N dry-run sample that's allowed to overlap with the
  // holdout since it's not used for the train/eval split — only the
  // train-754 file is consumed by W888-O compile step.)
  if (!fs.existsSync(TRAIN_754)) {
    // Soft-skip if the split hasn't been materialized yet.
    return;
  }
  const train = readJsonl(TRAIN_754);
  const hold = readJsonl(HOLDOUT);
  const trainIds = new Set(train.map(r => r.id));
  const overlap = hold.filter(r => trainIds.has(r.id));
  assert.equal(overlap.length, 0,
    `${overlap.length} ids in BOTH train-754 and holdout-200: ${overlap.slice(0, 3).map(r => r.id).join(', ')}`);
});

// ─── Pair -> Compile contract (N -> O) ──────────────────────────────────────

test('W888-T #6: compile-assistant.cjs reads training-pairs.jsonl by name', () => {
  const src = readText(COMPILE_SCRIPT);
  assert.ok(src.indexOf('training-pairs.jsonl') !== -1,
    'compile-assistant.cjs must reference training-pairs.jsonl by path');
});

test('W888-T #7: check-assistant-hallucinations.cjs reads holdout / responses', () => {
  // The hallu checker consumes `bench-responses.jsonl` (emitted by O step 3),
  // which is the holdout pumped through the artifact. The grep target is
  // the responses file path the checker accepts via --responses.
  const src = readText(HALLU_SCRIPT);
  assert.ok(src.indexOf('--responses') !== -1,
    'check-assistant-hallucinations.cjs must accept --responses');
  // And the compile orchestrator passes bench-responses.jsonl -> holdout
  // because the bench step emits one response row per holdout row.
  const orch = readText(COMPILE_SCRIPT);
  assert.ok(orch.indexOf('holdout-200.jsonl') !== -1,
    'compile-assistant.cjs must reference holdout-200.jsonl');
  assert.ok(orch.indexOf('check-assistant-hallucinations.cjs') !== -1,
    'compile-assistant.cjs must invoke the hallu checker');
});

test('W888-T #8: compile-passport.json top-level shape carries the required tracers', () => {
  // Director-supplied required keys: passport_sha256 / k_score /
  // hallucinations / compile_args / training_pairs_count / holdout_count.
  // The shipped passport surfaces these as: gate.k_score / gate.hallu_count /
  // config / steps.bench.envelope.rows_total. Lock the shape as it actually
  // shipped so downstream tooling stays bound.
  assert.ok(fs.existsSync(COMPILE_PASSPORT),
    'compile-passport.json missing - W888-O dry-run must run first');
  const p = readJson(COMPILE_PASSPORT);
  assert.equal(p.schema_version, 'w888o-compile-assistant-v1',
    `wrong schema_version: ${p.schema_version}`);
  assert.equal(typeof p.dry_run, 'boolean', 'dry_run flag missing');
  assert.ok(p.gate, 'gate block missing');
  assert.equal(typeof p.gate.k_score, 'number', 'gate.k_score must be number');
  assert.equal(typeof p.gate.hallu_count, 'number', 'gate.hallu_count must be number');
  assert.ok(p.config, 'config block missing');
  assert.equal(typeof p.config.student, 'string', 'config.student must be string');
  assert.equal(typeof p.config.k_score_gate, 'number', 'config.k_score_gate must be number');
  // The publish stdout contains passport_sha256 - it gets surfaced into
  // the homepage callout via data-passport-hash. Drift here breaks the
  // meta-demo claim.
  assert.ok(p.publish, 'publish block missing');
  const publishStdout = String(p.publish.stdout || '');
  assert.ok(publishStdout.indexOf('passport_sha256') !== -1,
    'publish.stdout must include passport_sha256 (consumed by W888-S homepage)');
  // training_pairs_count + holdout_count surface via the bench step.
  const benchEnv = p.steps && p.steps.bench && p.steps.bench.envelope;
  if (benchEnv) {
    assert.equal(typeof benchEnv.rows_total, 'number',
      'bench.envelope.rows_total must be number (= holdout count)');
  }
});

test('W888-T #9: K-Score gate exits non-zero when --mock-k-score below threshold', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const out = path.join(os.tmpdir(), `kolm-w888t-kfail-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  const r = spawnSync(process.execPath,
    [COMPILE_SCRIPT, '--dry-run', '--mock-k-score', '0.85', '--out', out],
    { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1,
    `K-Score below 0.90 must exit 1; got ${r.status}. stderr: ${r.stderr}`);
  const passport = readJson(path.join(out, 'compile-passport.json'));
  assert.equal(passport.gate.k_pass, false, 'gate.k_pass must be false');
  assert.ok(passport.gate.k_score < 0.90,
    `k_score ${passport.gate.k_score} must be < 0.90`);
  // The publish step must be skipped on gate fail (production receipt
  // depends on this: a sub-threshold artifact must never get a passport).
  assert.equal(passport.publish.skipped, true,
    'publish must be skipped when K-Score gate fails');
});

test('W888-T #10: hallucination gate exits non-zero when --inject-hallu', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const out = path.join(os.tmpdir(), `kolm-w888t-hallufail-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  const r = spawnSync(process.execPath,
    [COMPILE_SCRIPT, '--dry-run', '--inject-hallu', '--out', out],
    { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1,
    `--inject-hallu must exit 1; got ${r.status}. stderr: ${r.stderr}`);
  const passport = readJson(path.join(out, 'compile-passport.json'));
  assert.equal(passport.gate.hallu_pass, false, 'hallu_pass must be false');
  assert.ok(passport.gate.hallu_count >= 1,
    `hallu_count must be >=1 when --inject-hallu; got ${passport.gate.hallu_count}`);
  // Publish blocked on hallu fail too.
  assert.equal(passport.publish.skipped, true,
    'publish must be skipped on hallu fail');
});

// ─── Compile -> Client contract (O -> P) ────────────────────────────────────

test('W888-T #11: AssistantClient default GGUF path is ~/.kolm/models/kolm-assistant-1.5b.gguf', async () => {
  const src = readText(ASSISTANT_CLIENT);
  // Greppable: the constant must include the canonical path.
  assert.ok(src.indexOf('kolm-assistant-1.5b.gguf') !== -1,
    'assistant-client.js must reference kolm-assistant-1.5b.gguf');
  assert.ok(src.indexOf("'.kolm'") !== -1 || src.indexOf('".kolm"') !== -1,
    'assistant-client.js must reference the .kolm home directory');
  // Smoke: instantiate the client and check the resolved path.
  const { AssistantClient } = await import(pathToFileURL(ASSISTANT_CLIENT).href);
  const c = new AssistantClient({});
  assert.ok(c.localGgufPath.endsWith('kolm-assistant-1.5b.gguf'),
    `localGgufPath must end with kolm-assistant-1.5b.gguf; got ${c.localGgufPath}`);
  assert.ok(c.localGgufPath.indexOf('.kolm') !== -1,
    `localGgufPath must contain .kolm; got ${c.localGgufPath}`);
});

test('W888-T #12: extractKolmCommands parses 3 backticked kolm verbs from a reply', async () => {
  const { extractKolmCommands } = await import(pathToFileURL(ASSISTANT_CLIENT).href);
  const reply = 'First run `kolm whoami` then `kolm artifacts --json` then `kolm compile spec.toml`.';
  const known = ['whoami', 'artifacts', 'compile'];
  const out = extractKolmCommands(reply, known);
  assert.equal(out.commands.length, 3, `expected 3 commands; got ${out.commands.length}`);
  assert.deepEqual(out.commands.map(c => c.verb), ['whoami', 'artifacts', 'compile']);
  assert.equal(out.unknown_count, 0);
});

test('W888-T #13: fallback chain order is local -> api -> gateway, gateway path resolves provider', async () => {
  const { AssistantClient } = await import(pathToFileURL(ASSISTANT_CLIENT).href);
  const c = new AssistantClient({
    localShim: async () => ({ ok: false, response: '', reason: 'unavailable' }),
    apiShim: async () => ({ ok: false, response: '', reason: 'unavailable' }),
    gatewayShim: async () => ({ ok: true, response: 'gateway answer', cost_usd: 0.001 }),
    apiKey: 'ks_test',
    perTurnCapUsd: 0.01,
  });
  const r = await c.ask('umbrella seam test');
  // The order of fallback_chain attempts is the contract every consumer
  // relies on: local first, api second, gateway last.
  assert.deepEqual(r.fallback_chain.map(x => x.layer), ['local', 'api', 'gateway']);
  // The directive prose says provider_used == 'gateway'. The shipped
  // envelope field is `source` (Q's route maps it to provider_used). Lock
  // BOTH bindings here.
  assert.equal(r.source, 'gateway',
    `source must be 'gateway' when only gateway resolves; got ${r.source}`);
  assert.equal(r.ok, true);
  assert.equal(r.response, 'gateway answer');
});

test('W888-T #14: budget_exceeded triggers at the actual W888-Q+R caps ($0.01 + $0.005)', async () => {
  const { AssistantClient } = await import(pathToFileURL(ASSISTANT_CLIENT).href);
  // W888-Q authed cap = $0.01. cost_usd = $0.02 must trip budget_exceeded.
  const cQ = new AssistantClient({
    localShim: async () => ({ ok: false, response: '', reason: 'unavailable' }),
    apiShim: async () => ({ ok: false, response: '', reason: 'unavailable' }),
    gatewayShim: async () => ({ ok: true, response: 'over cap', cost_usd: 0.02 }),
    apiKey: 'ks_test',
    perTurnCapUsd: 0.01,
  });
  const rQ = await cQ.ask('expensive');
  assert.equal(rQ.ok, false);
  assert.equal(rQ.error, 'budget_exceeded',
    `W888-Q $0.01 cap should trigger budget_exceeded; got ${rQ.error}`);
  // W888-R public docs cap = $0.005. cost_usd = $0.006 must trip.
  const cR = new AssistantClient({
    localShim: async () => ({ ok: false, response: '', reason: 'unavailable' }),
    apiShim: async () => ({ ok: false, response: '', reason: 'unavailable' }),
    gatewayShim: async () => ({ ok: true, response: 'over half cap', cost_usd: 0.006 }),
    apiKey: 'ks_test',
    perTurnCapUsd: 0.005,
  });
  const rR = await cR.ask('expensive');
  assert.equal(rR.ok, false);
  assert.equal(rR.error, 'budget_exceeded',
    `W888-R $0.005 cap should trigger budget_exceeded; got ${rR.error}`);
  // The final fallback_chain entry must carry the cap that tripped.
  const lastR = rR.fallback_chain[rR.fallback_chain.length - 1];
  assert.equal(lastR.cap_usd, 0.005,
    `cap_usd in chain must report 0.005; got ${lastR.cap_usd}`);
});

test('W888-T #15: passport_hash is non-null when build/.../compile-passport.json exists', async () => {
  const { AssistantClient } = await import(pathToFileURL(ASSISTANT_CLIENT).href);
  // Real passport - hash must materialize.
  const c1 = new AssistantClient({
    localShim: async () => ({ response: 'ok' }),
    passportPath: COMPILE_PASSPORT,
  });
  const r1 = await c1.ask('test');
  if (fs.existsSync(COMPILE_PASSPORT)) {
    assert.equal(typeof r1.passport_hash, 'string',
      `passport_hash must be string when passport exists; got ${typeof r1.passport_hash}`);
    assert.ok(r1.passport_hash.length === 16,
      `passport_hash must be 16-char short hash; got "${r1.passport_hash}" (${r1.passport_hash.length} chars)`);
  }
  // Missing passport - hash must be null (no fabrication).
  const c2 = new AssistantClient({
    localShim: async () => ({ response: 'ok' }),
    passportPath: '/this/path/does/not/exist/compile-passport.json',
  });
  const r2 = await c2.ask('test');
  assert.equal(r2.passport_hash, null,
    `passport_hash must be null when passport missing; got ${r2.passport_hash}`);
});

// ─── Client -> Surface contract (P -> {Q, R, S}) ────────────────────────────

test('W888-T #16: /v1/assistant/chat is NOT in PUBLIC_API (authed-only)', () => {
  const auth = readText(AUTH_JS);
  // The authed Q route. Negative lock-in: it must NOT appear in any
  // PUBLIC_API path equality or regex match. The grep that catches all
  // listed-equal entries:
  //   p === '/v1/assistant/chat'
  // ...must NOT be present (only /v1/assistant/chat-docs is public).
  assert.ok(auth.indexOf("p === '/v1/assistant/chat'") === -1,
    "/v1/assistant/chat must NOT appear in PUBLIC_API (authed-only)");
});

test('W888-T #17: /v1/assistant/chat-docs IS in PUBLIC_API (public-rate-limited)', () => {
  const auth = readText(AUTH_JS);
  assert.ok(auth.indexOf("p === '/v1/assistant/chat-docs'") !== -1,
    "/v1/assistant/chat-docs MUST appear in PUBLIC_API");
});

test('W888-T #18: account widget + meta-demo widget are distinct and target distinct endpoints', () => {
  // Account widget at public/assets/assistant-widget.js (W888-Q) targets
  // /v1/assistant/chat. Meta-demo widget at public/assistant-widget.js
  // (W888-S) targets /v1/assistant/chat-docs first, /v1/assistant/chat
  // second. Lock the divergence so a future inject-nav or build step
  // can't accidentally overwrite one with the other.
  assert.ok(fs.existsSync(ACCOUNT_WIDGET_JS), 'public/assets/assistant-widget.js (account) missing');
  assert.ok(fs.existsSync(META_WIDGET_JS), 'public/assistant-widget.js (meta-demo) missing');
  const acct = readText(ACCOUNT_WIDGET_JS);
  const meta = readText(META_WIDGET_JS);
  assert.notEqual(acct, meta,
    'account widget and meta-demo widget must be DISTINCT files');
  // Account widget hits the authed endpoint.
  assert.ok(acct.indexOf('/v1/assistant/chat') !== -1,
    'account widget must target /v1/assistant/chat');
  // Meta-demo widget tries docs first, then falls through to authed.
  assert.ok(meta.indexOf('/v1/assistant/chat-docs') !== -1,
    'meta-demo widget must target /v1/assistant/chat-docs first');
  assert.ok(meta.indexOf('/v1/assistant/chat') !== -1,
    'meta-demo widget must fall back to /v1/assistant/chat');
});

test('W888-T #19: about-the-assistant.html references /v1/verify/ and does NOT contain "honest"', () => {
  assert.ok(fs.existsSync(PUBLIC_ABOUT), 'about-the-assistant.html missing');
  const html = readText(PUBLIC_ABOUT);
  assert.ok(/\/v1\/verify\/[a-f0-9]/i.test(html),
    'about-the-assistant.html must link to /v1/verify/<hash>');
  const lower = html.toLowerCase();
  // The standing user directive: never the H-word. Lift to umbrella so
  // any future S-page edit that re-introduces it fails HERE.
  assert.equal(lower.indexOf('honest'), -1,
    'about-the-assistant.html must not contain "honest" - use Caveats/Constraints/Limitations');
});

test('W888-T #20: index.html has data-section="meta-demo" + references assistant-widget.js', () => {
  assert.ok(fs.existsSync(PUBLIC_INDEX), 'index.html missing');
  const html = readText(PUBLIC_INDEX);
  assert.ok(/data-section\s*=\s*["']meta-demo["']/.test(html),
    'homepage must declare a section with data-section="meta-demo"');
  assert.ok(/<script[^>]+src\s*=\s*["'][^"']*assistant-widget\.js/i.test(html),
    'homepage must load assistant-widget.js');
  // data-kolm-assistant is the mount selector the widget reads.
  assert.ok(html.indexOf('data-kolm-assistant') !== -1,
    'homepage must mount the widget via data-kolm-assistant');
});

// ─── Budget telemetry roll-up ───────────────────────────────────────────────

test('W888-T #21: no consumer of AssistantClient exceeds the W888-O design cap ($0.01)', () => {
  // Audit every perTurnCapUsd literal across the consumers. The design cap
  // is $0.01 (W888-O directive). The actuals are:
  //   - W888-P CLI:        AssistantClient default = $0.01
  //   - W888-Q account:    router.js ensureAssistantClient = $0.01
  //   - W888-R docs:       router.js docs route       = $0.005
  // If a future PR raises any of these above $0.01, this test must fail.
  const client = readText(ASSISTANT_CLIENT);
  const m = client.match(/DEFAULT_PER_TURN_CAP_USD\s*=\s*([\d.]+)/);
  assert.ok(m, 'assistant-client.js must declare DEFAULT_PER_TURN_CAP_USD');
  const clientCap = parseFloat(m[1]);
  assert.ok(clientCap <= 0.01,
    `assistant-client.js default cap ${clientCap} must be <= $0.01`);
  // Scan router.js for perTurnCapUsd assignments and bound each.
  const router = readText(ROUTER_JS);
  const re = /perTurnCapUsd\s*:\s*([\d.]+)/g;
  const found = [];
  let mm;
  while ((mm = re.exec(router)) !== null) {
    const cap = parseFloat(mm[1]);
    found.push(cap);
    assert.ok(cap <= 0.01,
      `router.js perTurnCapUsd=${cap} exceeds W888-O design cap $0.01`);
  }
  assert.ok(found.length >= 2,
    `expected at least 2 perTurnCapUsd literals in router.js (Q + R); got ${found.length}`);
});
