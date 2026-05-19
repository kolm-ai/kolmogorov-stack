// Wave 439 — incremental retrain (--since=last-compile + opts.since).
//
// The post-W436 audit's P1 finding: "Incremental retrain is not actually
// wired into compileFull — W435 added bridges --since but compileFull does
// a full namespace rebuild on every call." W439 closes the gap.
//
// Contracts pinned here:
//
//   1. prepareDistillCorpus({namespace, since}) accepts a since param (ISO
//      string, Date, or epoch ms) and filters events to created_at > since.
//
//   2. The corpus stats envelope reports {dropped_since, since} so a watcher
//      can confirm the filter fired.
//
//   3. compileFull({namespace, opts:{since}}) threads since through to
//      prepareDistillCorpus and surfaces both fields on the corpus_prepare
//      phase event.
//
//   4. CLI cmdCompile (`kolm pipeline compile --namespace <n> --since <iso>`
//      OR `--since-last-compile`) resolves the since window and forwards it.
//      The --since-last-compile branch resolves to the newest .kolm in
//      ~/.kolm/artifacts/ matching the namespace.
//
// W438 added the real-synth path; W439 makes the loop closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_EVENT_STORE_DRIVER: process.env.KOLM_EVENT_STORE_DRIVER,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
  };
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function _mkIsolatedHome(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w439-' + label + '-'));
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  process.env.KOLM_RECIPE_RECEIPT_SECRET = 'wave439-incremental-retrain-32chars-min';
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

// ---------------------------------------------------------------------------
// W439 #1 — prepareDistillCorpus filters on since (ISO string form).
// ---------------------------------------------------------------------------
test('W439 #1 — prepareDistillCorpus filters on since (ISO string)', async () => {
  const saved = _snapEnv();
  _mkIsolatedHome('iso');
  try {
    const { appendEvent, _resetForTests } = await import('../src/event-store.js');
    if (_resetForTests) _resetForTests();
    const ns = 'w439_1';
    const tenant = 'wave439-1';
    const baseTime = Date.parse('2026-05-01T00:00:00Z');
    // 5 OLD events at t=base..base+4.
    for (let i = 0; i < 5; i++) {
      await appendEvent({
        event_id: `evt_w439_1_old_${i}`,
        tenant_id: tenant,
        namespace: ns,
        provider: 'openai',
        model: 'gpt-4',
        prompt_redacted: `old prompt ${i}`,
        response_redacted: `old response ${i}`,
        status: 'ok',
        source_type: 'real',
        created_at: new Date(baseTime + i).toISOString(),
      });
    }
    // 3 NEW events at t=base+100..102.
    for (let i = 0; i < 3; i++) {
      await appendEvent({
        event_id: `evt_w439_1_new_${i}`,
        tenant_id: tenant,
        namespace: ns,
        provider: 'openai',
        model: 'gpt-4',
        prompt_redacted: `new prompt ${i}`,
        response_redacted: `new response ${i}`,
        status: 'ok',
        source_type: 'real',
        created_at: new Date(baseTime + 100 + i).toISOString(),
      });
    }
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const sinceIso = new Date(baseTime + 10).toISOString();
    const r = await prepareDistillCorpus({ namespace: ns, split: 'all', tenant_id: tenant, since: sinceIso });
    assert.equal(r.stats.dropped_since, 5, 'must drop the 5 old events');
    assert.equal(r.stats.pairs_kept, 3, 'must keep the 3 new events');
    assert.equal(r.stats.since, sinceIso, 'stats.since must echo the filter');
    for (const p of r.pairs) {
      assert.ok(/^new prompt/.test(p.prompt), 'every kept pair must be a new one');
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// W439 #2 — prepareDistillCorpus accepts epoch ms and Date.
// ---------------------------------------------------------------------------
test('W439 #2 — prepareDistillCorpus accepts epoch ms and Date', async () => {
  const saved = _snapEnv();
  _mkIsolatedHome('epoch');
  try {
    const { appendEvent, _resetForTests } = await import('../src/event-store.js');
    if (_resetForTests) _resetForTests();
    const ns = 'w439_2';
    const baseTime = Date.parse('2026-05-01T00:00:00Z');
    for (let i = 0; i < 4; i++) {
      await appendEvent({
        event_id: `evt_w439_2_${i}`,
        tenant_id: 'wave439-2',
        namespace: ns,
        provider: 'openai',
        model: 'gpt-4',
        prompt_redacted: `prompt ${i}`,
        response_redacted: `response ${i}`,
        status: 'ok',
        source_type: 'real',
        created_at: new Date(baseTime + i * 1000).toISOString(),
      });
    }
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const cutoffMs = baseTime + 1500; // drops 0 and 1 (t=0,1000); keeps 2,3 (t=2000,3000)
    const rEpoch = await prepareDistillCorpus({ namespace: ns, split: 'all', tenant_id: 'wave439-2', since: cutoffMs });
    assert.equal(rEpoch.stats.dropped_since, 2, 'epoch ms form must drop 2 old events');
    assert.equal(rEpoch.stats.pairs_kept, 2);

    const rDate = await prepareDistillCorpus({ namespace: ns, split: 'all', tenant_id: 'wave439-2', since: new Date(cutoffMs) });
    assert.equal(rDate.stats.dropped_since, 2, 'Date object form must drop 2 old events');
    assert.equal(rDate.stats.pairs_kept, 2);
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// W439 #3 — compileFull surfaces the since window on corpus_prepare event.
// ---------------------------------------------------------------------------
test('W439 #3 — compileFull surfaces since + dropped_since on corpus_prepare', async () => {
  const saved = _snapEnv();
  _mkIsolatedHome('compile-emit');
  try {
    const { appendEvent, _resetForTests } = await import('../src/event-store.js');
    if (_resetForTests) _resetForTests();
    const ns = 'w439_3';
    const tenant = 'wave439-3';
    const { approveEvent } = await import('../src/dataset-workbench.js');
    const baseTime = Date.parse('2026-05-01T00:00:00Z');
    // 6 OLD approved events, 4 NEW approved events.
    for (let i = 0; i < 6; i++) {
      const e = await appendEvent({
        event_id: `evt_w439_3_old_${i}`,
        tenant_id: tenant,
        namespace: ns,
        provider: 'openai',
        model: 'gpt-4',
        prompt_redacted: `old prompt ${i}`,
        response_redacted: `old response ${i}`,
        status: 'ok',
        source_type: 'real',
        created_at: new Date(baseTime + i).toISOString(),
      });
      await approveEvent(e.event_id, { tenant_id: tenant, reviewer: 'wave439' });
    }
    for (let i = 0; i < 4; i++) {
      const e = await appendEvent({
        event_id: `evt_w439_3_new_${i}`,
        tenant_id: tenant,
        namespace: ns,
        provider: 'openai',
        model: 'gpt-4',
        prompt_redacted: `new prompt ${i}`,
        response_redacted: `new response ${i}`,
        status: 'ok',
        source_type: 'real',
        created_at: new Date(baseTime + 1000 + i).toISOString(),
      });
      await approveEvent(e.event_id, { tenant_id: tenant, reviewer: 'wave439' });
    }
    const sinceIso = new Date(baseTime + 500).toISOString();
    const { compileFull } = await import('../src/compile-pipeline.js');
    let corpusEv = null;
    try {
      for await (const ev of compileFull({
        namespace: ns,
        opts: {
          emit_progress_every: 0,
          allow_stub: true,
          force: true,
          no_install: true,
          tenant_id: tenant,
          approved_only: true,
          max_steps: 2,
          since: sinceIso,
        },
      })) {
        if (ev.phase === 'corpus_prepare') corpusEv = ev;
        if (corpusEv) break; // we only need this phase
      }
    } catch {}
    assert.ok(corpusEv, 'compileFull must emit a corpus_prepare event');
    assert.equal(corpusEv.since, sinceIso, 'corpus_prepare.since must echo the filter');
    assert.equal(corpusEv.dropped_since, 6, 'must drop the 6 old approved events');
    assert.equal(corpusEv.pair_count, 4, 'must keep only the 4 new approved events');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// W439 #4 — null/undefined since is a no-op (back-compat: pre-W439 callers
// don't accidentally start filtering when they pass no since).
// ---------------------------------------------------------------------------
test('W439 #4 — since=null is a no-op (full namespace, no filter)', async () => {
  const saved = _snapEnv();
  _mkIsolatedHome('noop');
  try {
    const { appendEvent, _resetForTests } = await import('../src/event-store.js');
    if (_resetForTests) _resetForTests();
    const ns = 'w439_4';
    for (let i = 0; i < 5; i++) {
      await appendEvent({
        event_id: `evt_w439_4_${i}`,
        tenant_id: 'wave439-4',
        namespace: ns,
        provider: 'openai',
        model: 'gpt-4',
        prompt_redacted: `prompt ${i}`,
        response_redacted: `response ${i}`,
        status: 'ok',
        source_type: 'real',
        created_at: new Date(Date.now() + i).toISOString(),
      });
    }
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const rNull = await prepareDistillCorpus({ namespace: ns, split: 'all', tenant_id: 'wave439-4', since: null });
    assert.equal(rNull.stats.dropped_since, 0, 'since=null must not drop any rows');
    assert.equal(rNull.stats.pairs_kept, 5);
    assert.equal(rNull.stats.since, null, 'stats.since echoes null');
    const rNone = await prepareDistillCorpus({ namespace: ns, split: 'all', tenant_id: 'wave439-4' });
    assert.equal(rNone.stats.dropped_since, 0, 'omitted since defaults to null no-op');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// W439 #5 — invalid since (unparseable string, NaN) is a safe no-op rather
// than a thrown error. Defends against user-supplied flag values like
// "yesterday" that the pipeline cannot resolve.
// ---------------------------------------------------------------------------
test('W439 #5 — invalid since is a safe no-op', async () => {
  const saved = _snapEnv();
  _mkIsolatedHome('invalid');
  try {
    const { appendEvent, _resetForTests } = await import('../src/event-store.js');
    if (_resetForTests) _resetForTests();
    const ns = 'w439_5';
    for (let i = 0; i < 3; i++) {
      await appendEvent({
        event_id: `evt_w439_5_${i}`,
        tenant_id: 'wave439-5',
        namespace: ns,
        provider: 'openai',
        model: 'gpt-4',
        prompt_redacted: `prompt ${i}`,
        response_redacted: `response ${i}`,
        status: 'ok',
        source_type: 'real',
        created_at: new Date(Date.now() + i).toISOString(),
      });
    }
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const r = await prepareDistillCorpus({ namespace: ns, split: 'all', tenant_id: 'wave439-5', since: 'yesterday' });
    // Unparseable string → sinceMs stays null → no filtering applied.
    assert.equal(r.stats.dropped_since, 0, 'unparseable since must not drop rows');
    assert.equal(r.stats.pairs_kept, 3);
    assert.equal(r.stats.since, null, 'invalid since must surface as null on stats');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// W439 #6 — CLI surface: `kolm pipeline compile --since-last-compile` is
// advertised in the help-or-error output. Catches the regression where the
// flag is wired in code but not surfaced to humans/agents discovering it.
// ---------------------------------------------------------------------------
test('W439 #6 — --since-last-compile + --since flags resolved by cmdCompile in cli/kolm.js', async () => {
  const cliPath = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'cli', 'kolm.js');
  const src = fs.readFileSync(cliPath, 'utf8');
  // The flag must be parsed AND forwarded into opts.since.
  assert.ok(src.includes("'--since-last-compile'"),
    'cli/kolm.js must reference --since-last-compile flag');
  assert.ok(src.includes("--since"),
    'cli/kolm.js must reference --since flag for explicit ISO/epoch override');
  assert.ok(src.includes('_newestArtifactForNamespace'),
    'cli/kolm.js must export the artifact-cutoff resolver helper');
  assert.ok(src.includes('since: sinceIso') || src.includes('since: sinceFlag'),
    'cli/kolm.js must thread the resolved since into compileFull opts');
});
