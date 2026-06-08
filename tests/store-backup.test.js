import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Bind the canonical (unqueried) store + store-backup modules to a throwaway
// temp dir so importing them never writes a ./data tree into the repo. Each
// test below operates on its OWN dir via an injected `info`, decoupled from
// this canonical binding (which is exactly how server.js calls backupNow() in
// production: with no override, against the live store's backendInfo()).
const BASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bk-base-'));
process.env.KOLM_DATA_DIR = BASE_DIR;
after(() => { try { fs.rmSync(BASE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ } });

test('sqlite: backupNow writes a consistent, restorable VACUUM INTO snapshot', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { t.skip('node:sqlite is unavailable in this Node runtime'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bk-sqlite-'));
  const saved = {
    dd: process.env.KOLM_DATA_DIR,
    drv: process.env.KOLM_STORE_DRIVER,
    db: process.env.KOLM_DB_PATH,
  };
  process.env.KOLM_DATA_DIR = dir;
  process.env.KOLM_STORE_DRIVER = 'sqlite';
  process.env.KOLM_DB_PATH = path.join(dir, 'kolm.sqlite');

  let store;
  t.after(() => {
    try { store?.close(); } catch { /* best-effort */ }
    if (saved.dd === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = saved.dd;
    if (saved.drv === undefined) delete process.env.KOLM_STORE_DRIVER; else process.env.KOLM_STORE_DRIVER = saved.drv;
    if (saved.db === undefined) delete process.env.KOLM_DB_PATH; else process.env.KOLM_DB_PATH = saved.db;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Fresh, queried imports bound to this test's dir (the canonical store is
  // pinned to BASE_DIR). backupNow receives this store's backendInfo() so the
  // snapshot targets the same db the rows were written to.
  store = await import(`../src/store.js?bk-sqlite=${Date.now()}`);
  const backup = await import(`../src/store-backup.js?bk-sqlite=${Date.now()}`);

  assert.equal(store.backendInfo().driver, 'sqlite');
  store.insert('agent_audits', { id: 'a1', tenant_id: 't1', verdict: 'pass' });
  store.insert('agent_audits', { id: 'a2', tenant_id: 't1', verdict: 'fail' });
  store.insert('tenants', { id: 't1', plan: 'report' });

  const r = backup.backupNow({ info: store.backendInfo() });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.driver, 'sqlite');
  assert.ok(fs.existsSync(r.path), 'snapshot file should exist on disk');
  assert.ok(r.bytes > 0, 'snapshot should be non-empty');

  // Open the snapshot as an INDEPENDENT database and confirm the rows survived
  // the copy — this is the real restorability assertion.
  const snap = new DatabaseSync(r.path);
  try {
    const audits = snap
      .prepare("SELECT json FROM kolm_store_rows WHERE table_name = ? ORDER BY row_id")
      .all('agent_audits')
      .map(x => JSON.parse(x.json));
    assert.deepEqual(audits.map(x => x.id), ['a1', 'a2']);
    assert.equal(audits[1].verdict, 'fail');
    const tenants = snap
      .prepare("SELECT json FROM kolm_store_rows WHERE table_name = ?")
      .all('tenants')
      .map(x => JSON.parse(x.json));
    assert.deepEqual(tenants.map(x => x.id), ['t1']);
  } finally {
    snap.close();
  }

  // The snapshot is discoverable via listBackups.
  const listed = backup.listBackups({ info: store.backendInfo() });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, 'sqlite');
  assert.equal(listed[0].path, r.path);
});

test('json: backupNow copies the table files into a timestamped snapshot dir', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bk-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'tenants.json'), JSON.stringify([{ id: 't1' }]), 'utf8');
  fs.writeFileSync(path.join(dir, 'agent_audits.json'), JSON.stringify([{ id: 'a1' }, { id: 'a2' }]), 'utf8');
  // Non-json siblings and JSON .bak files must NOT be copied into the snapshot.
  fs.writeFileSync(path.join(dir, 'tenants.json.bak'), JSON.stringify([{ id: 't1' }]), 'utf8');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me', 'utf8');

  const backup = await import(`../src/store-backup.js?bk-json=${Date.now()}`);
  const info = { driver: 'json', data_dir: dir, db_path: null };

  const r = backup.backupNow({ info });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.driver, 'json');
  assert.equal(r.files, 2);
  assert.ok(fs.statSync(r.path).isDirectory(), 'json snapshot should be a directory');

  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(r.path, 'tenants.json'), 'utf8')),
    [{ id: 't1' }],
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(r.path, 'agent_audits.json'), 'utf8')).map(x => x.id),
    ['a1', 'a2'],
  );
  assert.equal(fs.existsSync(path.join(r.path, 'notes.txt')), false, 'non-json must be skipped');
  assert.equal(fs.existsSync(path.join(r.path, 'tenants.json.bak')), false, '.bak must be skipped');

  const listed = backup.listBackups({ info });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].kind, 'json');
});

test('retention prunes to keep the most recent N snapshots', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bk-prune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const backupsDir = path.join(dir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  // 20 dummy snapshots with strictly increasing ISO-shaped names.
  const names = [];
  for (let i = 0; i < 20; i++) {
    const name = `kolm-2026-06-09T00-00-${String(i).padStart(2, '0')}-000Z.sqlite`;
    fs.writeFileSync(path.join(backupsDir, name), 'x', 'utf8');
    names.push(name);
  }

  const backup = await import(`../src/store-backup.js?bk-prune=${Date.now()}`);
  const info = { driver: 'sqlite', data_dir: dir, db_path: path.join(dir, 'kolm.sqlite') };

  assert.equal(backup.listBackups({ info }).length, 20);

  // Explicit keep = 5 retains the newest five.
  const r = backup.pruneBackups(5, { info });
  assert.equal(r.ok, true);
  assert.equal(r.pruned.length, 15);
  assert.equal(r.kept, 5);
  const remaining = backup.listBackups({ info }).map(b => b.name);
  assert.deepEqual(remaining, names.slice(15), 'the five newest are kept');

  // Default keep = 14. Add 10 more (total 15) then prune to default.
  for (let i = 20; i < 30; i++) {
    const name = `kolm-2026-06-09T00-00-${String(i).padStart(2, '0')}-000Z.sqlite`;
    fs.writeFileSync(path.join(backupsDir, name), 'x', 'utf8');
  }
  const r2 = backup.pruneBackups(undefined, { info });
  assert.equal(r2.ok, true);
  assert.equal(r2.kept, 14);
  assert.equal(backup.listBackups({ info }).length, 14);

  // Pruning a below-threshold set is a no-op.
  const r3 = backup.pruneBackups(50, { info });
  assert.equal(r3.ok, true);
  assert.deepEqual(r3.pruned, []);
  assert.equal(r3.kept, 14);
});

test('backupNow never throws and reports an error for an unresolvable target', async () => {
  const backup = await import(`../src/store-backup.js?bk-err=${Date.now()}`);
  // A sqlite driver whose db file does not exist -> structured error, no throw.
  const missing = path.join(os.tmpdir(), `kolm-bk-missing-${Date.now()}`);
  const r = backup.backupNow({ info: { driver: 'sqlite', data_dir: missing, db_path: path.join(missing, 'nope.sqlite') } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
  // listBackups on a missing dir returns [] rather than throwing.
  assert.deepEqual(backup.listBackups({ info: { driver: 'sqlite', data_dir: missing } }), []);
});
