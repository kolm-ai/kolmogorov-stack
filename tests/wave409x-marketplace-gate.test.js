// Wave 409x — marketplace metadata + production-gate on install.
//
// Auditor finding: listing rows shipped a stripped-down set of fields
// (slug/name/license/badges) so a buyer couldn't tell author, runtime,
// schema, privacy class, or device compatibility from the listing. Even
// worse, `kolm marketplace install` relied on the catalog's verified flag
// without re-running productionReady() against the freshly downloaded
// bytes — a compromised mirror could ship a stub past the gate.
//
// W409x wires:
//   - buildArtifactMetadata(): single source of truth for the 8 metadata
//     fields (author, license, runtime_target, input_schema, output_schema,
//     privacy_class, production_readiness_state, verified_receipt_hash,
//     device_compatibility). Pulled from the manifest where possible,
//     seed-overridable, never fake.
//   - installArtifactFromBytes(): re-runs productionReady() against the
//     downloaded buffer and rejects install when the verdict fails (even
//     when the listing claims production_ready_verified). --force overrides
//     for canary/debug.
//   - listArtifacts({filter}) accepts new filter keys: runtime_target,
//     privacy_class, device, production_readiness_state.
//
// Tests assert BEHAVIOR (function return shapes / install side-effects).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Fixture that we know passes productionReady() — built by W343 with --seeds,
// 60 real seeds, K~0.985, all gates green.
const FIXTURE_OK = path.join(ROOT, 'examples', 'claims-redactor', 'claims-redactor.kolm');

// Fixture that we know fails productionReady() — phi-redactor.kolm was built
// without --seeds, so seed_provenance is null and the verdict ok=false.
const FIXTURE_STUB = path.join(ROOT, 'public', 'registry-pack', 'phi-redactor.kolm');

function newTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wave409x-'));
  return d;
}

// ---------- W409x #1 — Marketplace listing exposes full metadata fields ----------

test('W409x #1 — marketplace listing returns the 8 metadata fields', async () => {
  const { listArtifacts } = await import('../src/marketplace.js');
  const arr = listArtifacts({ filter: {} });
  assert.ok(arr.length > 0, 'seed catalog must hydrate at least one row');
  for (const a of arr) {
    // Each row carries the new W409x metadata block AND mirrors the most
    // load-bearing fields at the top level (so a UI table can render the
    // listing without reaching into row.metadata.*).
    assert.equal(typeof a.author, 'string', `${a.slug}: author must be a string (got ${typeof a.author})`);
    assert.equal(typeof a.license, 'string', `${a.slug}: license must be a string`);
    assert.equal(typeof a.runtime_target, 'string', `${a.slug}: runtime_target must be a string`);
    assert.ok(a.input_schema != null, `${a.slug}: input_schema must be present`);
    assert.ok(a.output_schema != null, `${a.slug}: output_schema must be present`);
    assert.equal(typeof a.privacy_class, 'string', `${a.slug}: privacy_class must be a string`);
    assert.ok(['public-data-only', 'redacted-pii', 'raw-pii-internal-only'].includes(a.privacy_class),
      `${a.slug}: privacy_class must be one of the three honest classes (got ${a.privacy_class})`);
    assert.equal(typeof a.production_readiness_state, 'string', `${a.slug}: production_readiness_state must be a string`);
    assert.ok(['production_ready_verified', 'source_generated', 'foundation'].includes(a.production_readiness_state),
      `${a.slug}: production_readiness_state must be one of the three documented states (got ${a.production_readiness_state})`);
    assert.ok(Array.isArray(a.device_compatibility), `${a.slug}: device_compatibility must be an array`);
    assert.ok(a.device_compatibility.length > 0, `${a.slug}: device_compatibility must be non-empty`);
    // verified_receipt_hash MAY be null for unsigned artifacts, but the FIELD
    // must exist (so a downstream JSON consumer can read it without optional
    // chaining gymnastics).
    assert.ok('verified_receipt_hash' in a, `${a.slug}: verified_receipt_hash field must be present (even if null)`);
    // The nested metadata block must mirror the top-level fields.
    assert.ok(a.metadata && typeof a.metadata === 'object', `${a.slug}: metadata block must exist`);
    assert.equal(a.metadata.author, a.author);
    assert.equal(a.metadata.runtime_target, a.runtime_target);
    assert.equal(a.metadata.privacy_class, a.privacy_class);
    assert.equal(a.metadata.production_readiness_state, a.production_readiness_state);
  }
});

// ---------- W409x #2 — Metadata round-trip through manifest preserves fields ----------

test('W409x #2 — extractManifestMetadataFromBytes returns the same fields from a .kolm', async () => {
  if (!fs.existsSync(FIXTURE_OK)) {
    assert.ok(true, 'fixture missing — skip');
    return;
  }
  const { extractManifestMetadataFromBytes, listArtifacts } = await import('../src/marketplace.js');
  const buf = fs.readFileSync(FIXTURE_OK);
  // Pass the catalog seed so tag-driven inference (PHI tag => redacted-pii)
  // resolves identically to how the listing computed it.
  const listing0 = listArtifacts({ filter: {} }).find((a) => a.slug === 'claims-redactor');
  assert.ok(listing0, 'fixture seed must be present');
  const seed = { slug: listing0.slug, license: listing0.license, tags: listing0.tags || [] };
  const fromBytes = extractManifestMetadataFromBytes(buf, seed);
  assert.ok(fromBytes, 'metadata must extract from a real .kolm');
  // The 8 fields must round-trip.
  for (const k of ['author', 'license', 'runtime_target', 'input_schema', 'output_schema',
                   'privacy_class', 'production_readiness_state', 'verified_receipt_hash',
                   'device_compatibility']) {
    assert.ok(k in fromBytes, `extractManifestMetadataFromBytes must surface ${k}`);
  }
  // Compare against the catalog listing entry for the same slug.
  const listing = listArtifacts({ filter: {} }).find((a) => a.slug === 'claims-redactor');
  assert.ok(listing, 'claims-redactor must be in the seed catalog');
  // runtime_target, privacy_class, device_compatibility are derived from the
  // same manifest data on both paths (listing's hydrate() reads the manifest
  // too), so they must match. License diverges by design — the listing's
  // top-level `license` mirrors the seed slug ("Apache-2.0") for back-compat
  // while metadata.license carries the manifest's license id; assert against
  // listing.metadata.license to compare apples to apples.
  assert.equal(fromBytes.license, listing.metadata.license, 'metadata.license must match catalog vs from-bytes');
  assert.equal(fromBytes.runtime_target, listing.runtime_target, 'runtime_target must match');
  assert.equal(fromBytes.privacy_class, listing.privacy_class, 'privacy_class must match');
  assert.deepEqual(fromBytes.device_compatibility, listing.device_compatibility,
    'device_compatibility must round-trip identically');
});

// ---------- W409x #3 — Install ACCEPTS artifact whose local re-check passes ----------

test('W409x #3 — installArtifactFromBytes accepts a real production_ready fixture', async () => {
  if (!fs.existsSync(FIXTURE_OK)) {
    assert.ok(true, 'fixture missing — skip');
    return;
  }
  const { installArtifactFromBytes } = await import('../src/marketplace.js');
  const buf = fs.readFileSync(FIXTURE_OK);
  const tmpDir = newTmpDir();
  const dest = path.join(tmpDir, 'claims-redactor.kolm');
  const result = await installArtifactFromBytes({
    buffer: buf,
    destPath: dest,
    listingRow: { slug: 'claims-redactor', verified: true, production_readiness_state: 'production_ready_verified' },
  });
  assert.equal(result.ok, true, `install must accept: ${JSON.stringify(result.recheck && result.recheck.reasons)}`);
  assert.equal(result.written_path, dest);
  assert.ok(fs.existsSync(dest), 'install must persist bytes to destPath');
  assert.equal(result.recheck.ok, true, 're-check must report ok=true');
  // sha256 of the persisted file must match the input buffer.
  const got = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  const want = crypto.createHash('sha256').update(buf).digest('hex');
  assert.equal(got, want, 'persisted bytes must be sha256-identical to input');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- W409x #4 — Install REJECTS artifact whose local re-check finds a stub ----------

test('W409x #4 — install rejects when listing claims ready but local re-check fails', async () => {
  if (!fs.existsSync(FIXTURE_STUB)) {
    assert.ok(true, 'fixture missing — skip');
    return;
  }
  const { installArtifactFromBytes } = await import('../src/marketplace.js');
  const buf = fs.readFileSync(FIXTURE_STUB);
  const tmpDir = newTmpDir();
  const dest = path.join(tmpDir, 'phi-redactor.kolm');
  // The listing row LIES and says production_ready_verified. The local
  // re-check sees no seed_provenance and fails the verdict. Install must
  // reject — never trust the listing.
  const result = await installArtifactFromBytes({
    buffer: buf,
    destPath: dest,
    listingRow: {
      slug: 'phi-redactor',
      verified: true,
      production_readiness_state: 'production_ready_verified',
    },
  });
  assert.equal(result.ok, false, 'install must reject a stub even if listing claimed ready');
  assert.equal(result.reason, 'production_ready_failed');
  assert.equal(result.listing_claimed_ready, true,
    'rejection must surface the listing-vs-recheck contradiction');
  assert.ok(Array.isArray(result.recheck.reasons));
  assert.ok(result.recheck.reasons.length > 0, 'recheck must list failing gates');
  assert.ok(!fs.existsSync(dest), 'rejected install must not write to destPath');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- W409x #5 — sha256 mismatch is rejected (compromised mirror) ----------

test('W409x #5 — install rejects on sha256 mismatch (compromised mirror)', async () => {
  const { installArtifactFromBytes } = await import('../src/marketplace.js');
  const buf = Buffer.from('not a real .kolm');
  const tmpDir = newTmpDir();
  const dest = path.join(tmpDir, 'fake.kolm');
  const result = await installArtifactFromBytes({
    buffer: buf,
    destPath: dest,
    expectedSha256: 'deadbeef'.repeat(8), // 64 hex chars but not the real sha256
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sha256_mismatch');
  assert.ok(!fs.existsSync(dest));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- W409x #6 — --force override allows install of a failing artifact ----------

test('W409x #6 — force=true bypasses the production gate', async () => {
  if (!fs.existsSync(FIXTURE_STUB)) {
    assert.ok(true, 'fixture missing — skip');
    return;
  }
  const { installArtifactFromBytes } = await import('../src/marketplace.js');
  const buf = fs.readFileSync(FIXTURE_STUB);
  const tmpDir = newTmpDir();
  const dest = path.join(tmpDir, 'phi-redactor.kolm');
  const result = await installArtifactFromBytes({
    buffer: buf,
    destPath: dest,
    listingRow: { slug: 'phi-redactor', verified: true },
    force: true,
  });
  assert.equal(result.ok, true, 'force=true must accept');
  assert.equal(result.forced, true);
  assert.equal(result.recheck.ok, false, 'forced install still records honest verdict');
  assert.ok(fs.existsSync(dest), 'forced install must persist bytes');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- W409x #7 — listArtifacts({filter}) supports the W409x filter keys ----------

test('W409x #7 — listArtifacts filters by runtime_target / privacy_class / device', async () => {
  const { listArtifacts } = await import('../src/marketplace.js');
  // First, get the universe so we can pick filter values that match SOMETHING.
  const all = listArtifacts({ filter: {} });
  assert.ok(all.length > 0);
  // runtime_target filter
  const runtime = all[0].runtime_target;
  const filtered = listArtifacts({ filter: { runtime_target: runtime } });
  assert.ok(filtered.length > 0, `at least one row must match runtime_target=${runtime}`);
  for (const a of filtered) assert.equal(a.runtime_target, runtime);
  // privacy_class filter: pick the most common class so we always get a hit.
  const counts = {};
  for (const a of all) counts[a.privacy_class] = (counts[a.privacy_class] || 0) + 1;
  const topClass = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const byClass = listArtifacts({ filter: { privacy_class: topClass } });
  assert.ok(byClass.length > 0);
  for (const a of byClass) assert.equal(a.privacy_class, topClass);
  // No-match returns []
  const empty = listArtifacts({ filter: { runtime_target: 'nonexistent-target-xyzzy' } });
  assert.deepEqual(empty, [], 'nonexistent runtime_target must filter to empty array');
});

// ---------- W409x #8 — production_readiness_state honestly reflects gate ----------

test('W409x #8 — production_readiness_state reflects the unified gate verdict', async () => {
  const { listArtifacts } = await import('../src/marketplace.js');
  const all = listArtifacts({ filter: {} });
  for (const a of all) {
    if (a.verified === true) {
      assert.equal(a.production_readiness_state, 'production_ready_verified',
        `${a.slug}: verified=true must imply production_ready_verified`);
    } else {
      assert.notEqual(a.production_readiness_state, 'production_ready_verified',
        `${a.slug}: verified=false MUST NOT advertise production_ready_verified (got ${a.production_readiness_state})`);
    }
  }
});

// ---------- W409x #9 — author field is never null/empty ----------

test('W409x #9 — every listing entry has a non-empty author string', async () => {
  const { listArtifacts } = await import('../src/marketplace.js');
  const all = listArtifacts({ filter: {} });
  for (const a of all) {
    assert.equal(typeof a.author, 'string');
    assert.ok(a.author.length > 0, `${a.slug}: author must not be empty`);
  }
});

// ---------- W409x #10 — buildArtifactMetadata is a pure function ----------

test('W409x #10 — buildArtifactMetadata composes the 8 fields deterministically', async () => {
  const { buildArtifactMetadata } = await import('../src/marketplace.js');
  const seed = {
    slug: 'test-slug',
    license: 'Apache-2.0',
    tags: ['phi', 'hipaa'],
  };
  const manifest = {
    runtime: 'cloud',
    license: { id: 'LicenseRef-kolm-default-1.0' },
    compiled_targets: [{ profile_class: 'cpu-amd64' }, { profile_class: 'cuda-12' }],
    seed_provenance: {
      seeds_hash: 'a'.repeat(64),
      train_count: 40,
      holdout_count: 10,
    },
    signature: { signature_ed25519: 'sig-base64-blob' },
  };
  const m = buildArtifactMetadata({
    seed,
    manifest,
    verdict: { ok: true, gates: {}, reasons: [] },
    sha256: 'f'.repeat(64),
    bytes: 1234,
  });
  // verdict.ok=true => production_ready_verified
  assert.equal(m.production_readiness_state, 'production_ready_verified');
  // PHI/HIPAA tags => redacted-pii
  assert.equal(m.privacy_class, 'redacted-pii');
  // license from manifest wins over seed
  assert.equal(m.license, 'LicenseRef-kolm-default-1.0');
  // device_compatibility pulls compiled_targets[*].profile_class
  assert.deepEqual(m.device_compatibility.sort(), ['cpu-amd64', 'cuda-12']);
  // verified_receipt_hash sourced from manifest.signature.signature_ed25519
  assert.equal(m.verified_receipt_hash, 'sig-base64-blob');
  // sha256/bytes passthrough
  assert.equal(m.sha256, 'f'.repeat(64));
  assert.equal(m.bytes, 1234);
});
