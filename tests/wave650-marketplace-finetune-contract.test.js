// W650 - direct contract/security test for src/marketplace-finetune.js.
//
// The marketplace fine-tune helper is the handoff from a paid/signed listing
// into a later training worker. It must fail closed unless the base artifact is
// local, present, digest-matched, copied into the Kolm artifact cache, and
// durably queued in the event store.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w650-marketplace-finetune-'));
process.env.KOLM_DATA_DIR = path.join(TEST_HOME, '.kolm');
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
process.env.KOLM_STORE_DRIVER = 'jsonl';

after(() => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  delete process.env.KOLM_DATA_DIR;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.KOLM_EVENT_STORE_DRIVER;
  delete process.env.KOLM_STORE_DRIVER;
});

let moduleCache = null;
async function modules() {
  if (!moduleCache) {
    const [finetune, w825, eventStore] = await Promise.all([
      import('../src/marketplace-finetune.js'),
      import('../src/marketplace-w825.js'),
      import('../src/event-store.js'),
    ]);
    moduleCache = { finetune, w825, eventStore };
  }
  return moduleCache;
}

async function resetStores() {
  const mods = await modules();
  mods.eventStore._resetForTests();
  fs.rmSync(process.env.KOLM_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  mods.w825._resetForTests();
  mods.eventStore._resetForTests();
  return mods;
}

function digest(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function writeArtifact(name, bytes) {
  const dir = path.join(TEST_HOME, 'source-artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function seedListing(w825, overrides = {}) {
  const artifactPath = overrides.artifact_uri || writeArtifact(`${overrides.id || 'base'}.kolm`, 'base artifact bytes');
  const bytes = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile()
    ? fs.readFileSync(artifactPath)
    : Buffer.from(String(overrides.id || 'missing'));
  return w825.upsertListing({
    id: overrides.id || 'base-ok',
    publisher_tenant_id: overrides.publisher_tenant_id || 'tenant_publisher',
    title: overrides.title || 'Base artifact',
    vertical: overrides.vertical || 'code',
    task_type: overrides.task_type || 'generation',
    hardware_targets: overrides.hardware_targets || ['cpu only'],
    teacher_model: overrides.teacher_model || 'w650-teacher',
    artifact_uri: artifactPath,
    manifest_sha256: overrides.manifest_sha256 || digest(bytes),
    signature_b64: overrides.signature_b64 || 'signed-digest-placeholder',
    paid: overrides.paid ?? true,
    price_micro_usd: overrides.price_micro_usd ?? 2500,
  });
}

async function queuedRows(eventStore) {
  return eventStore.listEvents({
    provider: 'kolm_marketplace_finetune_queued',
    limit: 0,
    order: 'asc',
  });
}

test('W650 marketplace finetune queues only a verified local artifact copy', async () => {
  const { finetune, w825, eventStore } = await resetStores();
  const artifactPath = writeArtifact('local-ok.kolm', 'verified local base bytes');
  const sha256 = digest(fs.readFileSync(artifactPath));
  seedListing(w825, {
    id: 'local-ok',
    artifact_uri: artifactPath,
    manifest_sha256: sha256,
    publisher_tenant_id: 'tenant_pub',
    paid: true,
    price_micro_usd: 9876,
  });

  const env = await finetune.finetuneFromMarketplace({
    artifact_id: 'local-ok',
    tenant_id: 'tenant_buyer',
    captures_namespace: 'captures/custom',
    k_target: 1.7,
    max_steps: 0,
  });

  assert.equal(env.ok, true);
  assert.match(env.run_id, /^distill_/);
  assert.equal(env.status, 'queued');
  assert.equal(env.base_artifact_id, 'local-ok');
  assert.equal(env.base_artifact_sha256, sha256);
  assert.equal(env.listing_manifest_sha256, sha256);
  assert.equal(env.base_artifact_bytes, Buffer.byteLength('verified local base bytes'));
  assert.equal(env.k_target, 1, 'k_target is clamped to the valid 0..1 range');
  assert.equal(env.max_steps, 1, 'max_steps is clamped to at least one step');
  assert.equal(env.copy_skipped_reason, undefined);
  assert.ok(env.copied_to.endsWith(path.join('artifacts', 'local-ok.kolm')));
  assert.equal(fs.readFileSync(env.copied_to, 'utf8'), 'verified local base bytes');

  const rows = await queuedRows(eventStore);
  assert.equal(rows.length, 1, 'success path must durably queue exactly one row');
  assert.equal(rows[0].tenant_id, 'tenant_buyer');
  assert.equal(rows[0].namespace, 'kolm_marketplace');
  const feedback = JSON.parse(rows[0].feedback);
  assert.equal(feedback.run_id, env.run_id);
  assert.equal(feedback.base_artifact_id, 'local-ok');
  assert.equal(feedback.base_artifact_path, env.copied_to);
  assert.equal(feedback.base_artifact_sha256, sha256);
  assert.equal(feedback.base_artifact_bytes, env.base_artifact_bytes);
  assert.equal(feedback.publisher_tenant_id, 'tenant_pub');
  assert.equal(feedback.listing_paid, true);
  assert.equal(feedback.listing_price_micro_usd, 9876);
  assert.equal(feedback.version, finetune.MARKETPLACE_FINETUNE_VERSION);
});

test('W650 marketplace finetune fails closed for remote, missing, and tampered bases', async () => {
  const { finetune, w825, eventStore } = await resetStores();
  seedListing(w825, {
    id: 'remote-base',
    artifact_uri: 'https://example.invalid/base.kolm',
    manifest_sha256: digest('remote-base'),
  });
  seedListing(w825, {
    id: 'missing-base',
    artifact_uri: path.join(TEST_HOME, 'does-not-exist.kolm'),
    manifest_sha256: digest('missing-base'),
  });
  const tamperedPath = writeArtifact('tampered.kolm', 'original bytes');
  seedListing(w825, {
    id: 'tampered-base',
    artifact_uri: tamperedPath,
    manifest_sha256: digest('original bytes'),
  });
  fs.writeFileSync(tamperedPath, 'tampered bytes');

  const remote = await finetune.finetuneFromMarketplace({
    artifact_id: 'remote-base',
    tenant_id: 'tenant_buyer',
  });
  assert.equal(remote.ok, false);
  assert.equal(remote.error, 'artifact_uri_unavailable_for_finetune');
  assert.equal(remote.reason, 'artifact_uri_remote');

  const missing = await finetune.finetuneFromMarketplace({
    artifact_id: 'missing-base',
    tenant_id: 'tenant_buyer',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'artifact_uri_missing_on_disk');

  const tampered = await finetune.finetuneFromMarketplace({
    artifact_id: 'tampered-base',
    tenant_id: 'tenant_buyer',
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.error, 'artifact_sha256_mismatch');
  assert.equal(tampered.expected_sha256, digest('original bytes'));
  assert.equal(tampered.actual_sha256, digest('tampered bytes'));

  const rows = await queuedRows(eventStore);
  assert.equal(rows.length, 0, 'failed preflight paths must not queue training work');
});

test('W650 marketplace finetune writes traversal-shaped listing ids inside artifacts dir', async () => {
  const { finetune, w825, eventStore } = await resetStores();
  const artifactPath = writeArtifact('traversal-source.kolm', 'safe bytes');
  const sha256 = digest(fs.readFileSync(artifactPath));
  seedListing(w825, {
    id: '../escape',
    artifact_uri: artifactPath,
    manifest_sha256: sha256,
  });

  const env = await finetune.finetuneFromMarketplace({
    artifact_id: '../escape',
    tenant_id: 'tenant_buyer',
  });

  assert.equal(env.ok, true);
  const artifactsDir = path.resolve(process.env.KOLM_DATA_DIR, 'artifacts');
  const copied = path.resolve(env.copied_to);
  const rel = path.relative(artifactsDir, copied);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'copied artifact stays inside artifacts dir');
  assert.notEqual(copied, path.resolve(artifactsDir, '../escape.kolm'));
  assert.equal(path.basename(copied).includes('escape'), true);
  assert.equal(fs.readFileSync(copied, 'utf8'), 'safe bytes');
  assert.equal((await queuedRows(eventStore)).length, 1);
});
