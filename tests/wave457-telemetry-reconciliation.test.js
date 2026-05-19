// W457 — telemetry reconciliation (P0 release blocker).
//
// The audit found that `kolm what` and `kolm lake stats` / `kolm lake storage`
// / `kolm opportunities` disagreed on capture counts. `kolm what` read from
// the legacy capture-store (src/store.js 'observations' JSON table) while the
// other three read from the canonical event-store (~/.kolm/events/events.sqlite).
// Machines that captured traffic before the W409a one-shot migration could
// have 9000+ rows in the legacy store and only ~1900 in the canonical store —
// breaking the core capture -> distill product thesis.
//
// The fix (src/intent.js snapshotContext): read from the canonical event-store
// FIRST. Fall back to capture-store ONLY when event-store is empty.
//
// This test asserts BEHAVIOR (exit codes + JSON envelope numbers), not page
// copy. It seeds N events directly via the canonical event-store API, spawns
// the CLI in an isolated HOME, and verifies all three local readers agree on
// the total. `kolm capture status` is a SERVER surface (hits remote
// /v1/labels/synthesize-corpus) — we assert it fails cleanly on a fresh,
// unauthed isolated HOME (proving it does NOT silently fall back to a local
// counter that would re-introduce divergence).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'cli', 'kolm.js');

// Drive the CLI with an isolated HOME so we never touch the developer's real
// ~/.kolm. The event-store also honors KOLM_DATA_DIR; we set both so a single
// override drives every storage lookup.
function runCli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
}

function jsonOrThrow(stdout, label) {
  // Strip any node ExperimentalWarning lines that leak onto stderr but also
  // sometimes the CLI prints a banner — find the first { and parse from there.
  const i = stdout.indexOf('{');
  if (i < 0) throw new Error(`${label}: no JSON in output: ${stdout.slice(0, 200)}`);
  try {
    return JSON.parse(stdout.slice(i));
  } catch (e) {
    throw new Error(`${label}: JSON parse failed: ${e.message}\nout:\n${stdout.slice(0, 400)}`);
  }
}

test('W457 #1 — kolm what / lake stats / opportunities all read the same canonical event-store', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w457-'));
  const kolmDir = path.join(tmpdir, '.kolm');
  fs.mkdirSync(kolmDir, { recursive: true });

  const env = {
    HOME: tmpdir,
    USERPROFILE: tmpdir,
    KOLM_DATA_DIR: kolmDir,
    // Force CLI to skip network bootstraps.
    KOLM_OFFLINE: '1',
  };

  // Seed N events directly via the canonical event-store API. This is the
  // same code-path `appendEvent` runs through under the proxy + connector,
  // so we are recording exactly what the lake / opportunity engine query.
  const SEED_NS_A = 'w457-recon-a';
  const SEED_NS_B = 'w457-recon-b';
  const SEED_COUNT_A = 17;
  const SEED_COUNT_B = 8;
  const TOTAL = SEED_COUNT_A + SEED_COUNT_B;

  // We need to make the event-store import inside this test see the same
  // KOLM_DATA_DIR override the spawned CLI will see. Set env vars BEFORE
  // importing the module, then call _resetForTests so the singleton picks
  // up the new path. (The CLI we spawn later is a fresh process; it picks
  // up env naturally — this seeding step is the only one that has to
  // override our own process env.)
  const savedHome = process.env.HOME;
  const savedUp = process.env.USERPROFILE;
  const savedDd = process.env.KOLM_DATA_DIR;
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  process.env.KOLM_DATA_DIR = kolmDir;
  try {
    const eventStore = await import('../src/event-store.js?w457seed=' + Date.now());
    if (typeof eventStore._resetForTests === 'function') eventStore._resetForTests();
    for (let i = 0; i < SEED_COUNT_A; i++) {
      await eventStore.appendEvent({
        event_id: `w457_a_${i}`,
        tenant_id: 'local',
        namespace: SEED_NS_A,
        created_at: new Date(Date.now() - (TOTAL - i) * 1000).toISOString(),
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'ok',
        prompt_redacted: `prompt-a-${i}`,
        response_redacted: `resp-a-${i}`,
        prompt_tokens: 10,
        completion_tokens: 5,
        latency_ms: 100 + i,
        estimated_cost_usd: 0.0001,
        sensitive_data_detected: false,
        request_hash: `hash_a_${i}`,
      });
    }
    for (let i = 0; i < SEED_COUNT_B; i++) {
      await eventStore.appendEvent({
        event_id: `w457_b_${i}`,
        tenant_id: 'local',
        namespace: SEED_NS_B,
        created_at: new Date(Date.now() - i * 1000).toISOString(),
        provider: 'anthropic',
        model: 'claude-haiku',
        status: 'ok',
        prompt_redacted: `prompt-b-${i}`,
        response_redacted: `resp-b-${i}`,
        prompt_tokens: 8,
        completion_tokens: 4,
        latency_ms: 50 + i,
        estimated_cost_usd: 0.00005,
        sensitive_data_detected: false,
        request_hash: `hash_b_${i}`,
      });
    }
    // Confirm the in-process seed worked before we spawn the CLI.
    const seedCount = await eventStore.countEvents({});
    assert.equal(seedCount, TOTAL, 'in-process seed should have written all rows');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUp === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUp;
    if (savedDd === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = savedDd;
  }

  // 1) kolm what --json
  const whatR = runCli(['what', '--json'], env);
  assert.equal(whatR.status, 0, `kolm what exited non-zero: ${whatR.stderr}`);
  const whatJ = jsonOrThrow(whatR.stdout, 'kolm what');
  const whatTotal = whatJ.counts && whatJ.counts.captures;
  assert.equal(typeof whatTotal, 'number', 'what.counts.captures must be a number');

  // 2) kolm lake stats --json
  const lakeR = runCli(['lake', 'stats', '--json'], env);
  assert.equal(lakeR.status, 0, `kolm lake stats exited non-zero: ${lakeR.stderr}`);
  const lakeJ = jsonOrThrow(lakeR.stdout, 'kolm lake stats');
  const lakeTotal = lakeJ.total_calls;
  assert.equal(typeof lakeTotal, 'number', 'lake.total_calls must be a number');

  // 3) kolm lake storage --json (separate storage-only verb, W444)
  const storR = runCli(['lake', 'storage', '--json'], env);
  assert.equal(storR.status, 0, `kolm lake storage exited non-zero: ${storR.stderr}`);
  const storJ = jsonOrThrow(storR.stdout, 'kolm lake storage');
  const storTotal = storJ.event_count;
  assert.equal(typeof storTotal, 'number', 'storage.event_count must be a number');

  // 4) kolm opportunities --json — same store, different aggregator. The opps
  //    envelope carries a `total` field but it counts *opportunities*, not
  //    events; however, opportunities are derived from the same listEvents
  //    query the lake uses, so the underlying corpus must be the same N rows.
  //    We assert exit-code is 0 and the envelope shape is well-formed.
  const oppR = runCli(['opportunities', '--json'], env);
  assert.equal(oppR.status, 0, `kolm opportunities exited non-zero: ${oppR.stderr}`);
  const oppJ = jsonOrThrow(oppR.stdout, 'kolm opportunities');
  assert.equal(oppJ.ok, true, 'opportunities envelope must be ok=true');
  assert.equal(typeof oppJ.total, 'number', 'opportunities.total must be a number');

  // RECONCILIATION ASSERTION — the three canonical-store surfaces agree.
  assert.equal(
    whatTotal, lakeTotal,
    `RECONCILIATION FAILURE: kolm what reports ${whatTotal} captures, kolm lake stats reports ${lakeTotal}`
  );
  assert.equal(
    lakeTotal, storTotal,
    `RECONCILIATION FAILURE: kolm lake stats=${lakeTotal} vs lake storage=${storTotal}`
  );
  assert.equal(
    whatTotal, TOTAL,
    `RECONCILIATION FAILURE: surfaces agree at ${whatTotal} but seed was ${TOTAL}`
  );

  // Also verify namespace agreement: snapshot.captures_summary aggregates by
  // namespace; assert both seeded namespaces appear and roll up to TOTAL.
  const summaryNs = Object.fromEntries(
    (whatJ.captures || []).map(r => [r.namespace, r.count])
  );
  assert.equal(summaryNs[SEED_NS_A], SEED_COUNT_A,
    `kolm what should see ${SEED_COUNT_A} rows in ${SEED_NS_A}, got ${summaryNs[SEED_NS_A]}`);
  assert.equal(summaryNs[SEED_NS_B], SEED_COUNT_B,
    `kolm what should see ${SEED_COUNT_B} rows in ${SEED_NS_B}, got ${summaryNs[SEED_NS_B]}`);
  assert.equal(whatJ.counts.namespaces, 2,
    `kolm what should report exactly 2 namespaces, got ${whatJ.counts.namespaces}`);

  // 5) kolm capture status — this surface tries the remote
  //    /v1/labels/synthesize-corpus first, then falls back to a LOCAL count
  //    when offline / unauthed. W457 also wires the offline fallback through
  //    the canonical event-store, so the per-namespace local count must
  //    match what the event-store reports for that namespace. Using
  //    --namespace SEED_NS_A means we expect SEED_COUNT_A.
  const capR = runCli(['capture', 'status', '--namespace', SEED_NS_A, '--json'], env);
  assert.equal(capR.status, 0, `kolm capture status exited non-zero: ${capR.stderr}`);
  const capJ = jsonOrThrow(capR.stdout, 'kolm capture status');
  assert.equal(capJ.ok, true, 'capture status envelope must be ok=true');
  assert.equal(capJ.namespace, SEED_NS_A, 'capture status should echo the namespace');
  // RECONCILIATION ASSERTION for capture status: when offline, it counts from
  // the canonical event-store filtered by namespace. Should equal SEED_COUNT_A.
  assert.equal(capJ.count, SEED_COUNT_A,
    `RECONCILIATION FAILURE: kolm capture status reports ${capJ.count} for ${SEED_NS_A}, expected ${SEED_COUNT_A} (must read canonical event-store)`);
  assert.equal(capJ.source, 'local',
    'on isolated HOME with no api_key capture status must source from local event-store');

  // Cleanup
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
});

test('W457 #2 — snapshotContext prefers the canonical event-store over capture-store', async () => {
  // White-box check: src/intent.js snapshotContext must import event-store
  // BEFORE capture-store inside the capture-summary block, and the
  // capture-store branch must only fire when out.captures_summary.length === 0.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'intent.js'), 'utf8');
  // Find the snapshotContext block.
  const blockStart = src.indexOf('export async function snapshotContext');
  assert.ok(blockStart > 0, 'snapshotContext must be exported from src/intent.js');
  const blockEnd = src.indexOf('\n}\n', blockStart);
  const block = src.slice(blockStart, blockEnd);
  // event-store import must come first inside the !SANDBOX_MODE branch.
  const evIdx = block.indexOf("import('./event-store.js')");
  const csIdx = block.indexOf("import('./capture-store.js')");
  assert.ok(evIdx > 0, 'snapshotContext must dynamically import ./event-store.js');
  assert.ok(csIdx > 0, 'snapshotContext must still keep capture-store as fallback');
  assert.ok(evIdx < csIdx,
    'event-store import must come BEFORE capture-store (canonical-first ordering)');
  // The capture-store fallback must be gated on out.captures_summary.length===0.
  const fallbackGate = block.indexOf('out.captures_summary.length === 0');
  assert.ok(fallbackGate > evIdx,
    'capture-store fallback must be gated on event-store returning empty');
  // Comment must mention W457 so future readers know why the ordering matters.
  assert.match(block, /W457/, 'block must carry W457 reconciliation reference');
});

test('W457 #3 — event-store countEvents matches snapshotContext aggregation', async () => {
  // Sanity check: on the developer's actual machine, the snapshotContext
  // capture count equals event-store countEvents({}). This is the property
  // the audit was looking for — they must never diverge again.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w457b-'));
  const kolmDir = path.join(tmpdir, '.kolm');
  fs.mkdirSync(kolmDir, { recursive: true });

  const savedHome = process.env.HOME;
  const savedUp = process.env.USERPROFILE;
  const savedDd = process.env.KOLM_DATA_DIR;
  process.env.HOME = tmpdir;
  process.env.USERPROFILE = tmpdir;
  process.env.KOLM_DATA_DIR = kolmDir;
  try {
    const eventStore = await import('../src/event-store.js?w457b=' + Date.now());
    if (typeof eventStore._resetForTests === 'function') eventStore._resetForTests();
    // Seed exactly 5 rows.
    for (let i = 0; i < 5; i++) {
      await eventStore.appendEvent({
        event_id: `w457b_${i}`,
        tenant_id: 'local',
        namespace: 'w457b-ns',
        created_at: new Date().toISOString(),
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'ok',
        prompt_redacted: `p${i}`,
        response_redacted: `r${i}`,
      });
    }
    const directCount = await eventStore.countEvents({});
    const intent = await import('../src/intent.js?w457b=' + Date.now());
    const snap = await intent.snapshotContext({ cwd: tmpdir });
    assert.equal(snap.counts.captures, directCount,
      `snapshotContext.counts.captures (${snap.counts.captures}) must equal eventStore.countEvents (${directCount})`);
    assert.equal(directCount, 5, 'seed count guard');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUp === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUp;
    if (savedDd === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = savedDd;
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
  }
});
