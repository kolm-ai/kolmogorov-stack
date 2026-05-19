// Wave 426 — importSeedsJsonl(..., {createDataset:true}) must not drop the
// import tenant when it creates the dataset.
//
// Audit 2026-05-19 P1-2: Before this fix, the createDataset() call inside
// importSeedsJsonl() was:
//
//   const ds = await createDataset(namespace, { sourceType, approvedOnly, ... });
//
// — missing `tenant_id`. createDataset() falls through to listEvents(namespace,
// tenant_id: null), which means tenantA's seed-import into namespace X would
// fold in every other tenant's pre-existing rows in X (including tenantB's
// approved/synthetic/PHI events). The dataset's source_event_ids would
// therefore include rows the importing tenant doesn't own.
//
// This file pins:
//   (1) Tenant A imports seeds into namespace X → resulting dataset's
//       source_event_ids are ALL owned by tenant A.
//   (2) Tenant B imports seeds into the same namespace X → B's dataset has
//       only B's event_ids; A's dataset's source_event_ids are unchanged.
//   (3) Per-row source_type from the JSONL row carries through to the
//       underlying event (W411 P0 #2 pattern applied to imports).
//   (4) Static-source assertion: createDataset call inside importSeedsJsonl
//       passes tenant_id (regression guard against the audit's literal claim).
//
// Run with `--test-concurrency=1` to avoid the SQLite parallel-test trap
// (W311 + W319). Per-test tmpdirs (KOLM_DATA_DIR + HOME) so the dev box's
// real ~/.kolm is never touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function _mkTmp(label = 'w426') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_DB_PATH: process.env.KOLM_DB_PATH,
  };
}

function _setEnv(tmp) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // Use jsonl driver for the event-store — keeps the test self-contained and
  // avoids the node:sqlite parallel-test box quirks.
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  process.env.KOLM_DB_PATH = path.join(tmp, 'kolm.sqlite');
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

async function _resetStore() {
  const ev = await import('../src/event-store.js');
  if (typeof ev._resetForTests === 'function') ev._resetForTests();
}

function _writeJsonl(dir, name, rows) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

test('wave426 #1 — tenantA seed import → dataset only contains tenantA rows', async () => {
  const saved = _snapEnv();
  const tmp = _mkTmp('w426-1');
  _setEnv(tmp);
  await _resetStore();
  try {
    const { appendEvent } = await import('../src/event-store.js');
    const { importSeedsJsonl, inspectDataset } = await import('../src/dataset-workbench.js');

    // Pre-seed namespace X with 3 tenantB rows (so a missing tenant filter
    // would clearly pull them into A's dataset).
    const bIds = [];
    for (let i = 0; i < 3; i++) {
      const ev = await appendEvent({
        event_id: `evt_w426_pre_b_${i}`,
        tenant_id: 'tenantB',
        namespace: 'shared-X',
        prompt_redacted: `B prompt ${i}`,
        response_redacted: `B reply ${i}`,
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'ok',
        source_type: 'real',
      });
      bIds.push(ev.event_id);
    }

    // Build a 4-row seeds.jsonl for tenantA and import with createDataset:true.
    const seedsPath = _writeJsonl(tmp, 'a-seeds.jsonl', [
      { input: 'A unique 1', output: 'A reply 1' },
      { input: 'A unique 2', output: 'A reply 2' },
      { input: 'A unique 3', output: 'A reply 3' },
      { input: 'A unique 4', output: 'A reply 4' },
    ]);

    const result = await importSeedsJsonl(seedsPath, {
      namespace: 'shared-X',
      tenantId: 'tenantA',
      createDataset: true,
      sourceType: 'real',
    });

    assert.equal(result.imported, 4, 'four rows imported');
    assert.ok(result.dataset_id, 'createDataset returned an id');

    const ds = await inspectDataset(result.dataset_id);
    assert.ok(Array.isArray(ds.source_event_ids), 'dataset has source_event_ids array');
    // PRIMARY ASSERTION — no tenantB rows should be present.
    const bLeak = ds.source_event_ids.filter(id => bIds.includes(id));
    assert.deepEqual(bLeak, [], 'no tenantB event_ids leaked into tenantA dataset');
    // Sanity — all returned ids are exactly the ones the importer just made.
    assert.equal(ds.source_event_ids.length, 4, 'dataset size === imported rows');
    for (const id of ds.source_event_ids) {
      assert.ok(result.event_ids.includes(id), `${id} came from this import`);
    }
    // tenant_id stamp on the dataset record matches the importer.
    assert.equal(ds.tenant_id, 'tenantA', 'dataset.tenant_id === tenantA');
  } finally {
    await _resetStore();
    _restoreEnv(saved);
  }
});

test('wave426 #2 — tenantB seed import into same namespace → only B rows; A dataset unaffected', async () => {
  const saved = _snapEnv();
  const tmp = _mkTmp('w426-2');
  _setEnv(tmp);
  await _resetStore();
  try {
    const { importSeedsJsonl, inspectDataset } = await import('../src/dataset-workbench.js');

    // Tenant A imports first.
    const aPath = _writeJsonl(tmp, 'a.jsonl', [
      { input: 'A q1', output: 'A a1' },
      { input: 'A q2', output: 'A a2' },
    ]);
    const aRes = await importSeedsJsonl(aPath, {
      namespace: 'shared-X',
      tenantId: 'tenantA',
      createDataset: true,
    });
    assert.ok(aRes.dataset_id, 'A dataset created');
    const aDs = await inspectDataset(aRes.dataset_id);
    const aIds = aDs.source_event_ids.slice();
    assert.equal(aDs.tenant_id, 'tenantA');

    // Tenant B imports into the SAME namespace.
    const bPath = _writeJsonl(tmp, 'b.jsonl', [
      { input: 'B q1', output: 'B a1' },
      { input: 'B q2', output: 'B a2' },
      { input: 'B q3', output: 'B a3' },
    ]);
    const bRes = await importSeedsJsonl(bPath, {
      namespace: 'shared-X',
      tenantId: 'tenantB',
      createDataset: true,
    });
    assert.ok(bRes.dataset_id, 'B dataset created');
    assert.notEqual(bRes.dataset_id, aRes.dataset_id, 'distinct dataset ids');

    const bDs = await inspectDataset(bRes.dataset_id);
    assert.equal(bDs.tenant_id, 'tenantB', 'B dataset stamped with tenantB');
    // B's dataset must NOT include any of A's event_ids.
    const aLeakIntoB = bDs.source_event_ids.filter(id => aIds.includes(id));
    assert.deepEqual(aLeakIntoB, [], 'no tenantA event_ids leaked into tenantB dataset');
    assert.equal(bDs.source_event_ids.length, 3, 'B dataset has exactly 3 rows (its own)');

    // A's dataset record must NOT have been mutated by B's import.
    const aDsAfter = await inspectDataset(aRes.dataset_id);
    assert.equal(aDsAfter.tenant_id, 'tenantA', 'A dataset still tenantA');
    assert.deepEqual(aDsAfter.source_event_ids, aIds, 'A dataset rows unchanged after B import');
    const bLeakIntoA = aDsAfter.source_event_ids.filter(id => bDs.source_event_ids.includes(id));
    assert.deepEqual(bLeakIntoA, [], 'no tenantB event_ids leaked into tenantA dataset post-B-import');
  } finally {
    await _resetStore();
    _restoreEnv(saved);
  }
});

test('wave426 #3 — per-row source_type from JSONL carries through to the event', async () => {
  const saved = _snapEnv();
  const tmp = _mkTmp('w426-3');
  _setEnv(tmp);
  await _resetStore();
  try {
    const { getEvent } = await import('../src/event-store.js');
    const { importSeedsJsonl } = await import('../src/dataset-workbench.js');

    // Mixed-source seeds: one row tagged synthetic, one real, one simulated,
    // one defaulting (no source_type — should fall back to importer default).
    // Allowed source_type values are pinned in src/event-schema.js
    // SOURCE_TYPES: real | synthetic | simulated | teacher_generated |
    // legacy_unknown. Anything else gets normalized to 'real'.
    const seedsPath = _writeJsonl(tmp, 'mixed.jsonl', [
      { input: 'q1', output: 'a1', source_type: 'synthetic' },
      { input: 'q2', output: 'a2', source_type: 'real' },
      { input: 'q3', output: 'a3', source_type: 'simulated' },
      { input: 'q4', output: 'a4' }, // no source_type
    ]);

    const res = await importSeedsJsonl(seedsPath, {
      namespace: 'src-type-X',
      tenantId: 'tenantA',
      sourceType: 'real', // importer default for row 4
      createDataset: false,
    });
    assert.equal(res.imported, 4);
    assert.equal(res.event_ids.length, 4);

    const evs = await Promise.all(res.event_ids.map(id => getEvent(id)));
    const types = evs.map(e => e && e.source_type);
    assert.equal(types[0], 'synthetic', 'row 1 keeps explicit synthetic');
    assert.equal(types[1], 'real', 'row 2 keeps explicit real');
    assert.equal(types[2], 'simulated', 'row 3 keeps explicit simulated');
    assert.equal(types[3], 'real', 'row 4 defaults to importer sourceType');
    // Tenant stamp also preserved (defensive — cross-checks the tenant chain).
    for (const e of evs) assert.equal(e.tenant_id, 'tenantA', 'tenant_id preserved on every imported row');
  } finally {
    await _resetStore();
    _restoreEnv(saved);
  }
});

test('wave426 #4 — static-source: createDataset call inside importSeedsJsonl passes tenant_id', () => {
  // Regression guard for the audit's literal claim. If a future refactor
  // drops tenant_id from the createDataset call site again, this fails fast
  // BEFORE the behavioral tests get a chance to run, so the diagnostic
  // points at the exact line.
  const srcPath = path.join(__dirname, '..', 'src', 'dataset-workbench.js');
  const src = fs.readFileSync(srcPath, 'utf8');

  // Locate the importSeedsJsonl function body.
  const fnStart = src.indexOf('export async function importSeedsJsonl');
  assert.ok(fnStart > 0, 'importSeedsJsonl is exported');
  // The next top-level export marks the end of this function.
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : src.length);

  // The createDataset call inside the importer must pass tenant_id.
  const createIdx = body.indexOf('createDataset(');
  assert.ok(createIdx > 0, 'importSeedsJsonl calls createDataset');
  // Pull the call's argument block (rough — first 600 chars after the call).
  const callBlock = body.slice(createIdx, createIdx + 600);
  assert.match(callBlock, /tenant_id\s*:/, 'createDataset call inside importSeedsJsonl passes tenant_id');
  // And it should be wired to the import tenant (the local `tenant` variable
  // or opts.tenantId), not a hard-coded 'local'.
  assert.match(callBlock, /tenant_id\s*:\s*(tenant\b|opts\.tenantId)/,
    'createDataset receives the import tenant (not a hard-coded value)');
  // Sanity: the namespace-wide rescan is narrowed by fromEventIds so
  // intra-tenant unrelated rows in the namespace don't bleed in.
  assert.match(callBlock, /fromEventIds\s*:/,
    'createDataset call inside importSeedsJsonl passes fromEventIds for exact-set narrowing');
});

test('wave426 #5 — createDataset honours fromEventIds whitelist', async () => {
  const saved = _snapEnv();
  const tmp = _mkTmp('w426-5');
  _setEnv(tmp);
  await _resetStore();
  try {
    const { appendEvent } = await import('../src/event-store.js');
    const { createDataset, inspectDataset } = await import('../src/dataset-workbench.js');

    // 5 rows for tenantA, namespace nsZ. Only allow-list 2 ids.
    const allIds = [];
    for (let i = 0; i < 5; i++) {
      const ev = await appendEvent({
        event_id: `evt_w426_5_${i}`,
        tenant_id: 'tenantA',
        namespace: 'nsZ',
        prompt_redacted: `q${i}`,
        response_redacted: `a${i}`,
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'ok',
        source_type: 'real',
      });
      allIds.push(ev.event_id);
    }
    const allowed = [allIds[1], allIds[3]];

    const ds = await createDataset('nsZ', {
      tenant_id: 'tenantA',
      fromEventIds: allowed,
    });
    const rec = await inspectDataset(ds.dataset_id);
    assert.equal(rec.source_event_ids.length, 2, 'only whitelisted ids present');
    assert.deepEqual(rec.source_event_ids.slice().sort(), allowed.slice().sort(),
      'source_event_ids === fromEventIds');
    assert.equal(rec.tenant_id, 'tenantA');
  } finally {
    await _resetStore();
    _restoreEnv(saved);
  }
});
