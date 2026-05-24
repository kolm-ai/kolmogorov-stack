// W821 [T2] — pipeline orchestrator tests.
//
// Twelve lock-in tests across the schema, parser, validator, K-Score and
// orchestrate() runtime + the HTTP route registration shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Per-test isolated KOLM_DATA_DIR so listPipelines/createPipeline don't fight
// with each other or pollute the dev user's ~/.kolm.
function _freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w821-'));
  process.env.KOLM_DATA_DIR = d;
  return d;
}

test('W821 #1 — PIPELINE_SCHEMA is frozen', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  assert.equal(Object.isFrozen(mod.PIPELINE_SCHEMA), true, 'PIPELINE_SCHEMA must be frozen');
  assert.ok(Array.isArray(mod.PIPELINE_SCHEMA.supported_versions), 'must declare supported_versions[]');
  assert.ok(mod.PIPELINE_SCHEMA.supported_versions.includes('v1'), 'v1 must be supported');
});

test('W821 #2 — PIPELINE_STATES is frozen with documented set', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  assert.equal(Object.isFrozen(mod.PIPELINE_STATES), true, 'PIPELINE_STATES must be frozen');
  // Spec frozen states: idle / running / ok / failed / partial.
  const vals = new Set(Object.values(mod.PIPELINE_STATES));
  for (const s of ['idle', 'running', 'ok', 'failed', 'partial']) {
    assert.ok(vals.has(s), 'missing state: ' + s);
  }
});

test('W821 #3 — parsePipelineYaml accepts a valid kolm.pipeline.yaml', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  const yaml = [
    'version: v1',
    'name: customer-support',
    'classifier: ./classifier.kolm',
    'routes:',
    '  - match: {intent: refund}',
    '    artifact: ./specialists/refund.kolm',
    '  - match: {intent: status}',
    '    artifact: ./specialists/status.kolm',
    '  - default: true',
    '    artifact: ./specialists/fallback.kolm',
  ].join('\n');
  const parsed = mod.parsePipelineYaml(yaml);
  assert.equal(parsed.version, 'v1');
  assert.equal(parsed.classifier, './classifier.kolm');
  assert.ok(Array.isArray(parsed.routes), 'routes must be a list');
  assert.equal(parsed.routes.length, 3);
  assert.equal(parsed.routes[0].match.intent, 'refund');
  assert.equal(parsed.routes[2].default, true);
});

test('W821 #4 — validatePipeline reports pipeline_version_required when version missing', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  const parsed = { routes: [{ default: true, artifact: './x.kolm' }] };
  const result = mod.validatePipeline(parsed);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'pipeline_version_required'),
    'expected pipeline_version_required error');
});

test('W821 #5 — validatePipeline reports pipeline_routes_required when routes missing', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  const parsed = { version: 'v1' };
  const result = mod.validatePipeline(parsed);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'pipeline_routes_required'),
    'expected pipeline_routes_required error');
});

test('W821 #6 — validatePipeline returns ok:true on a well-formed pipeline', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  const parsed = {
    version: 'v1',
    routes: [
      { match: { intent: 'a' }, artifact: './a.kolm' },
      { default: true, artifact: './fb.kolm' },
    ],
  };
  const result = mod.validatePipeline(parsed);
  assert.equal(result.ok, true, 'should pass: ' + JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test('W821 #7 — validatePipeline accumulates multiple errors (does not stop at first)', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  const parsed = { name: '', routes: 'not-a-list' };
  const result = mod.validatePipeline(parsed);
  assert.equal(result.ok, false);
  // Expect at least: pipeline_version_required + pipeline_routes_must_be_list
  // + pipeline_name_must_be_non_empty_string.
  assert.ok(result.errors.length >= 2, 'expected >=2 errors, got ' + result.errors.length);
  const codes = new Set(result.errors.map((e) => e.code));
  assert.ok(codes.has('pipeline_version_required'), 'must report missing version');
  assert.ok(codes.has('pipeline_routes_must_be_list'), 'must report routes shape error');
});

test('W821 #8 — computePipelineKScore returns weighted average', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  const pipeline = {
    version: 'v1',
    routes: [
      { match: { intent: 'a' }, artifact: './a.kolm' },
      { match: { intent: 'b' }, artifact: './b.kolm' },
    ],
  };
  const eval_set = {
    a: { k_score: 0.9, n_eval: 100 },
    b: { k_score: 0.5, n_eval: 100 },
  };
  const route_frequencies = { a: 3, b: 1 };
  const r = mod.computePipelineKScore({ pipeline, eval_set, route_frequencies });
  assert.equal(r.ok, true, JSON.stringify(r));
  // (3*0.9 + 1*0.5) / (3+1) = 3.2/4 = 0.8
  assert.ok(Math.abs(r.weighted_k_score - 0.8) < 1e-9,
    'weighted K-Score should be 0.8, got ' + r.weighted_k_score);
});

test('W821 #9 — computePipelineKScore returns no_eval_data when route_frequencies empty', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  const pipeline = {
    version: 'v1',
    routes: [{ match: { intent: 'a' }, artifact: './a.kolm' }],
  };
  const r = mod.computePipelineKScore({ pipeline, eval_set: {}, route_frequencies: {} });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'no_eval_data', 'status must be no_eval_data, got ' + r.status);
  assert.equal(r.weighted_k_score, null, 'weighted_k_score must be null when no data');
});

test('W821 #10 — orchestrate returns runtime_required envelope when no runtime injected', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  const pipeline = {
    version: 'v1',
    routes: [{ default: true, artifact: './fb.kolm' }],
  };
  const r = await mod.orchestrate({ pipeline, input: 'hello' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'runtime_required');
  assert.equal(r.state, mod.PIPELINE_STATES.FAILED);
});

test('W821 #11 — orchestrate routes to first default when no intent matches', async () => {
  const mod = await import('../src/pipeline-orchestrator.js');
  const pipeline = {
    version: 'v1',
    classifier: './cls.kolm',
    routes: [
      { match: { intent: 'a' }, artifact: './a.kolm' },
      { default: true, artifact: './fallback.kolm' },
    ],
  };
  // Stub runtime: classifier returns intent "zzz" (no match), default fires.
  const calls = [];
  const runtime = {
    runArtifact: async (artifactPath, input) => {
      calls.push(artifactPath);
      if (artifactPath === './cls.kolm') {
        return { ok: true, output: { intent: 'zzz' } };
      }
      return { ok: true, output: { reply: 'from ' + artifactPath, input } };
    },
  };
  const r = await mod.orchestrate({ pipeline, input: 'hi', runtime });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.artifact_used, './fallback.kolm', 'must route to default');
  assert.equal(r.intent, 'zzz');
  assert.equal(r.route_index, 1);
  assert.equal(r.state, mod.PIPELINE_STATES.OK);
  assert.deepEqual(calls, ['./cls.kolm', './fallback.kolm']);
});

test('W821 #12 — registerPipelineRoutes is an exported function from pipeline-routes.js', async () => {
  const mod = await import('../src/pipeline-routes.js');
  assert.equal(typeof mod.registerPipelineRoutes, 'function',
    'pipeline-routes.js must export registerPipelineRoutes');
  // Sanity: calling without a router must throw rather than silently no-op.
  assert.throws(() => mod.registerPipelineRoutes(null), /registerPipelineRoutes/);
});

// Bonus: end-to-end persistence smoke (isolated tmp dir).
test('W821 #13 — createPipeline + getPipeline + listPipelines + deletePipeline round trip', async () => {
  _freshDir();
  const mod = await import('../src/pipeline-orchestrator.js');
  mod._resetForTests && mod._resetForTests();
  const yaml = [
    'version: v1',
    'name: round-trip',
    'routes:',
    '  - default: true',
    '    artifact: ./fb.kolm',
  ].join('\n');
  const created = mod.createPipeline({ name: 'round-trip', yaml, tenant_id: 'tenant_w821' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.ok(created.id && created.id.startsWith('pl_'), 'id must start with pl_');
  const fetched = mod.getPipeline(created.id, { tenant_id: 'tenant_w821' });
  assert.ok(fetched, 'getPipeline must find created pipeline');
  assert.equal(fetched.name, 'round-trip');
  const listed = mod.listPipelines({ tenant_id: 'tenant_w821' });
  assert.ok(listed.find((r) => r.id === created.id), 'listPipelines must include the new pipeline');
  // Cross-tenant must not see the row.
  const other = mod.listPipelines({ tenant_id: 'tenant_other' });
  assert.equal(other.find((r) => r.id === created.id), undefined, 'cross-tenant must NOT see pipeline');
  const del = mod.deletePipeline(created.id, { tenant_id: 'tenant_w821' });
  assert.equal(del.ok, true);
  const after = mod.getPipeline(created.id, { tenant_id: 'tenant_w821' });
  assert.equal(after, null, 'after delete getPipeline must return null');
});
