// W661 - direct contract for src/sbom-emit.js.
//
// Focus: API-safe manifest emission, trusted local path opt-in, standards-shaped
// package URLs, and honest hash handling for Node/Python dependency sources.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  emitSbomFromManifest,
  emitSbomFromPackageLock,
  emitSbomFromPython,
  verifySbomShape,
} from '../src/sbom-emit.js';

const SHA256_HEX = 'a'.repeat(64);
const SHA384_HEX = 'b'.repeat(96);
const SHA512_BYTES = Buffer.alloc(64, 0x42);
const SHA512_B64 = SHA512_BYTES.toString('base64');
const SHA512_HEX = SHA512_BYTES.toString('hex');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w661-sbom-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function componentByName(sbom, name) {
  return sbom.components.find((c) => c.name === name);
}

test('W661 manifest emission is object-first, deduped, purl-normalized, and verifiable', () => {
  const manifest = {
    name: 'frontier-artifact',
    version: '1.0.0',
    deps: [
      { name: '@kolm/runtime', version: '2.0.0', hash: `sha256:${SHA256_HEX}` },
      { name: '@kolm/runtime', version: '2.0.0', hash: `sha256:${SHA384_HEX}` },
      { name: 'invalid-hash-lib', version: '0.1.0', hash: 'sha999-not-real' },
    ],
    bom: [
      { name: 'vector-db', version: '3.2.1', ecosystem: 'pypi', hash: `sha512-${SHA512_B64}` },
    ],
    dependencies: {
      admzip: '0.5.17',
    },
  };

  const cdx = emitSbomFromManifest({ manifest });
  assert.equal(cdx.ok, true);
  assert.equal(cdx.format, 'cyclonedx-json');
  assert.equal(cdx.component_count, 4);
  assert.equal(verifySbomShape(cdx.sbom).valid, true);

  const scoped = componentByName(cdx.sbom, '@kolm/runtime');
  assert.equal(scoped.purl, 'pkg:npm/%40kolm/runtime@2.0.0');
  assert.deepEqual(scoped.hashes, [{ alg: 'SHA-256', content: SHA256_HEX }]);

  const vector = componentByName(cdx.sbom, 'vector-db');
  assert.equal(vector.purl, 'pkg:pypi/vector-db@3.2.1');
  assert.deepEqual(vector.hashes, [{ alg: 'SHA-512', content: SHA512_HEX }]);

  const invalid = componentByName(cdx.sbom, 'invalid-hash-lib');
  assert.equal('hashes' in invalid, false);

  const spdx = emitSbomFromManifest({ manifest, format: 'spdx-json' });
  assert.equal(spdx.ok, true);
  assert.equal(spdx.sbom.packages.length, 4);
  assert.equal(verifySbomShape(spdx.sbom).valid, true);
  assert.ok(spdx.sbom.packages.some((p) => p.downloadLocation === 'pkg:npm/%40kolm/runtime@2.0.0'));
});

test('W661 manifest string paths are denied by default and allowed only by trusted opt-in', (t) => {
  const dir = tempDir(t);
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: 'trusted-local',
    deps: [{ name: 'dep-a', version: '1.0.0', hash: SHA256_HEX }],
  }));

  const blocked = emitSbomFromManifest({ manifest: manifestPath });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'manifest_path_read_disabled');

  const allowed = emitSbomFromManifest({ manifest: manifestPath, allow_path_read: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.source_path, path.resolve(manifestPath));
  assert.equal(allowed.component_count, 1);
  assert.equal(verifySbomShape(allowed.sbom).valid, true);
});

test('W661 package-lock emission preserves scoped purls and omits malformed integrity hashes', (t) => {
  const dir = tempDir(t);
  const lockPath = path.join(dir, 'package-lock.json');
  fs.writeFileSync(lockPath, JSON.stringify({
    name: 'lock-root',
    version: '9.9.9',
    packages: {
      '': { name: 'lock-root', version: '9.9.9' },
      'node_modules/@scope/pkg': {
        version: '1.2.3',
        integrity: `sha512-${SHA512_B64}`,
        license: 'MIT',
      },
      'node_modules/bad-integrity': {
        version: '4.5.6',
        integrity: 'sha1-not-valid-for-frontier-sbom',
      },
    },
  }));

  const result = emitSbomFromPackageLock({ lock_path: lockPath });
  assert.equal(result.ok, true);
  assert.equal(result.component_count, 2);
  assert.equal(verifySbomShape(result.sbom).valid, true);

  const scoped = componentByName(result.sbom, '@scope/pkg');
  assert.equal(scoped.purl, 'pkg:npm/%40scope/pkg@1.2.3');
  assert.deepEqual(scoped.hashes, [{ alg: 'SHA-512', content: SHA512_HEX }]);
  assert.deepEqual(scoped.licenses, [{ license: { id: 'MIT' } }]);

  const bad = componentByName(result.sbom, 'bad-integrity');
  assert.equal('hashes' in bad, false);
});

test('W661 requirements emission flags unhashed rows while keeping valid hashes', (t) => {
  const dir = tempDir(t);
  const requirementsPath = path.join(dir, 'requirements.txt');
  fs.writeFileSync(requirementsPath, [
    '--index-url https://example.invalid/simple',
    `requests==2.31.0 --hash=sha256:${SHA256_HEX}`,
    'numpy>=1.26.0',
    'badpkg==1.0.0 --hash=sha1:0123456789012345678901234567890123456789',
  ].join('\n'));

  const result = emitSbomFromPython({ requirements_txt_path: requirementsPath });
  assert.equal(result.ok, true);
  assert.equal(result.component_count, 3);
  assert.equal(result.hashed_count, 1);
  assert.equal(result.unhashed_count, 2);
  assert.equal(verifySbomShape(result.sbom).valid, true);

  const requests = componentByName(result.sbom, 'requests');
  assert.equal(requests.purl, 'pkg:pypi/requests@2.31.0');
  assert.deepEqual(requests.hashes, [{ alg: 'SHA-256', content: SHA256_HEX }]);

  const numpy = componentByName(result.sbom, 'numpy');
  assert.deepEqual(numpy.properties, [{ name: 'kolm:no_hash', value: 'true' }]);

  const unhashedPath = path.join(dir, 'unhashed.txt');
  fs.writeFileSync(unhashedPath, 'flask==3.0.0\n');
  const unhashed = emitSbomFromPython({ requirements_txt_path: unhashedPath });
  assert.equal(unhashed.ok, true);
  assert.equal(unhashed.note, 'no_hashed_requirements');
  assert.equal(unhashed.hashed_count, 0);
  assert.equal(unhashed.unhashed_count, 1);
  assert.equal(verifySbomShape(unhashed.sbom).valid, true);
});

test('W661 shape verifier rejects primitives and reports required field gaps', () => {
  assert.deepEqual(verifySbomShape([]), {
    ok: false,
    valid: false,
    errors: ['sbom_required'],
    version: 'w763-v1',
  });

  const malformedCdx = verifySbomShape({ bomFormat: 'CycloneDX', specVersion: '1.5' });
  assert.equal(malformedCdx.ok, true);
  assert.equal(malformedCdx.valid, false);
  assert.ok(malformedCdx.errors.includes('cyclonedx_missing_version'));
  assert.ok(malformedCdx.errors.includes('cyclonedx_missing_components'));

  const malformedSpdx = verifySbomShape({ spdxVersion: 'SPDX-2.3', SPDXID: 'SPDXRef-DOCUMENT' });
  assert.equal(malformedSpdx.ok, true);
  assert.equal(malformedSpdx.valid, false);
  assert.ok(malformedSpdx.errors.includes('spdx_missing_or_invalid_dataLicense'));
  assert.ok(malformedSpdx.errors.includes('spdx_missing_packages'));
});
