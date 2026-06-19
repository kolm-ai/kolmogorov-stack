import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

function loadSurfaceProbe(surfaceId, probeId) {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'product-surfaces.json'), 'utf8'));
  const surface = catalog.surfaces.find((entry) => entry.id === surfaceId);
  assert.ok(surface, `missing product surface ${surfaceId}`);
  const probe = surface.production_smoke.find((entry) => entry.id === probeId);
  assert.ok(probe, `missing product surface probe ${surfaceId}/${probeId}`);
  return probe;
}

test('W601 - readiness-gated public evidence probes accept only explicit gated readiness 503s', () => {
  const evidence = loadSurfaceProbe('public-docs-sdk', 'evidence-readiness');
  const benchmark = loadSurfaceProbe('capture-data-eval-training', 'benchmark-evidence-public');
  const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'prod-surface-smoke.cjs'), 'utf8');
  const router = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');

  for (const probe of [evidence, benchmark]) {
    assert.deepEqual(probe.expect, [200, 503]);
    assert.ok(probe.checks.includes('json'));
    assert.ok(probe.checks.includes('readiness-gated'));
  }

  assert.match(smoke, /readiness-gated envelope missing ok\/readiness/);
  assert.match(smoke, /readiness-gated 503 did not include blocked\/gated proof requirements/);
  assert.match(smoke, /readiness-gated 200 reported non-ready status/);
  assert.match(router, /\/v1\/evidence\/readiness[\s\S]*res\.status\(readiness\.external_ready \? 200 : 503\)\.json\(envelope\)/);
  assert.match(router, /\/v1\/eval\/benchmark-evidence[\s\S]*res\.status\(audit\.public_claim_ready \? 200 : 503\)\.json\(envelope\)/);
  assert.match(router, /\/v1\/compliance\/certification-packet[\s\S]*res\.status\(audit\.live_certification_verified \? 200 : 503\)\.json\(envelope\)/);
});

test('W601 - local surface smoke stamps SDK assets before serving static manifests', () => {
  const localSmoke = fs.readFileSync(path.join(ROOT, 'scripts', 'local-surface-smoke.cjs'), 'utf8');

  assert.match(localSmoke, /build-sdk-version\.js/);
  assert.match(localSmoke, /failed to stamp SDK assets before local smoke/);
  assert.ok(
    localSmoke.indexOf('build-sdk-version.js') < localSmoke.indexOf("['server.js']"),
    'SDK stamping must run before the local server starts',
  );
});
