// R-11 — Cross-module integration tests pinning the contracts between R-1
// through R-8 modules.
//
// These tests do NOT re-cover per-module unit pins (those live in
// r1-runtime-passport.test.js through r8-cost-displacement.test.js). They
// pin the wires BETWEEN modules so that an edit to one module that breaks
// the contract another module relies on is caught here.
//
// The 8 wires:
//
//   #1  R-1 -> R-5  : runtime passport ride into the evidence DAG as a
//                     'runtime' kind node, validates round-trip.
//   #2  R-2 -> R-5  : lifecycle revoke + DAG revoke produces an invalidates
//                     fan-out across descendants.
//   #3  R-3 + R-4   : detectRuntime(gguf+CUDA) -> 'llama.cpp', and
//                     generateDockerCompose({runtime:'llama.cpp'}) references
//                     the llama.cpp container image.
//   #4  R-4 -> R-6  : generateAirgapBundle produces a sha256, and that
//                     sha256 can ride into an assurance-case envelope as
//                     evidence (the receipt summary is shaped so the
//                     assurance case rebuilder reads it without throwing).
//   #5  R-5 -> R-6  : a revoked node in the DAG leaves the assurance case
//                     in a 'package-gated' state because the audit receipt
//                     chain it pointed at is gone; assurance case still
//                     emits without throwing.
//   #6  R-7         : end-to-end drift detection — 50 baseline + 50
//                     lookback captures with deliberately shifted vocab
//                     trips the SPC ladder to at least 'warn'.
//   #7  R-8         : end-to-end cost displacement — local + frontier mix
//                     with explicit compile_cost_usd produces a numeric
//                     payback_period_months.
//   #8  R-1..R-8    : surface presence — 11 R-series source files exist
//                     under src/ and each exports the documented
//                     headline symbol.
//
// All tests use ESM + node:test + node:assert/strict. No edits to anything
// under src/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Isolated tmp dirs BEFORE we import any module that touches disk on
// import (artifact-lifecycle reads KOLM_DATA_DIR at module-eval time).
// ---------------------------------------------------------------------------

const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-r11-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');

const runtimePassport = await import('../src/runtime-passport.js');
const lifecycle = await import('../src/artifact-lifecycle.js');
const serveAutodetect = await import('../src/serve-autodetect.js');
const deployGen = await import('../src/deploy-generators.js');
const dagMod = await import('../src/evidence-dag.js');
const assurance = await import('../src/assurance-case.js');
const drift = await import('../src/drift-detector.js');
const cost = await import('../src/cost-displacement.js');

// =============================================================================
// #1 — R-1 -> R-5: runtime passport becomes an evidence DAG 'runtime' node.
// =============================================================================
//
// The runtime probe step produces a passport (R-1). That passport must be
// attachable to the artifact's evidence DAG (R-5) as a 'runtime' kind node
// so the procurement reviewer can trace the deployment-integrity claim back
// to the actual measurement. This test builds a real passport, packages it
// into a DAG node, builds the DAG, and walks the DAG to confirm the
// passport made the round trip with no mutation.
test('R11 #1 — R-1 runtime passport rides into R-5 evidence DAG as a runtime node', () => {
  const passport = runtimePassport.recordTestedPassport({
    target_id: 'gguf-q4_k_m-llama.cpp',
    runtime: 'llama.cpp',
    runtime_version: 'b3415',
    precision: 'q4_k_m',
    memory_mb: 4096,
    latency_p50_ms: 12,
    latency_p95_ms: 22,
    tok_s: 80,
    quality_delta: 0,
    fallback: null,
  });
  const v = runtimePassport.validatePassport(passport);
  assert.equal(v.ok, true, 'passport must validate before it can ride into the DAG');

  // Build a DAG that includes the passport as a runtime node, plus a
  // signature node so we can exercise the validated_by relationship.
  const dag = dagMod.buildDag({
    nodes: [
      { id: 'rt_probe_001', kind: 'runtime', passport },
      { id: 'sig_001',      kind: 'signature', fingerprint: 'fp_001' },
    ],
    edges: [
      { from: 'sig_001', to: 'rt_probe_001', relationship: 'validated_by' },
    ],
  });

  const node = dagMod.showNode(dag, 'rt_probe_001');
  assert.ok(node, 'runtime node must be retrievable by id');
  assert.equal(node.kind, 'runtime');
  // Passport survived the DAG round-trip with every field intact.
  assert.ok(node.passport, 'runtime node carries the passport payload');
  for (const f of runtimePassport.RUNTIME_PASSPORT_FIELDS) {
    assert.deepEqual(node.passport[f], passport[f], 'field ' + f + ' must round-trip');
  }
  // Trace from the signature node should reach the runtime node.
  const tr = dagMod.trace(dag, 'sig_001');
  assert.ok(tr.ancestors.some((a) => a.id === 'rt_probe_001'),
    'signature must trace to the runtime probe ancestor');
});

// =============================================================================
// #2 — R-2 -> R-5: revoke transitions + DAG fan-out.
// =============================================================================
//
// When a deployed artifact is revoked (R-2), the evidence DAG must surface
// every downstream node that was derived from the revoked node so a
// reviewer can list everything that needs re-review. This test drives the
// full transition path created -> signed -> deployed -> revoked, then runs
// revoke() on the DAG and confirms the descendants list matches the wired
// graph.
test('R11 #2 — R-2 revoke + R-5 DAG fan-out matches transitive descendants', () => {
  // Use a distinct artifact id so we never collide with sibling tests.
  const artifact_id = 'art_r11_2_' + crypto.randomBytes(2).toString('hex');
  let record = lifecycle.loadOrInit(artifact_id);
  record = lifecycle.transition(record, 'signed',   { actor: 'system', reason: 'sealed' });
  record = lifecycle.transition(record, 'deployed', { actor: 'system', reason: 'rollout' });
  // Capture state mid-flight before revoke for the deny-pull invariant.
  assert.equal(record.current_state, 'deployed');
  assert.equal(lifecycle.canPull(record), true, 'deployed artifact must be pullable');

  record = lifecycle.transition(record, 'revoked', {
    actor: 'system',
    reason: 'license-violation',
    evidence_id: 'evt_revoke_001',
  });
  assert.equal(record.current_state, 'revoked');
  assert.equal(lifecycle.canPull(record), false, 'revoked artifact must NOT be pullable');
  // The transition log must include the revoke entry with its reason.
  const hist = lifecycle.getHistory(record);
  const last = hist[hist.length - 1];
  assert.equal(last.to, 'revoked');
  assert.equal(last.reason, 'license-violation');

  // Now drive the matching DAG fan-out: a teacher -> a student derived from
  // teacher -> a runtime probe validated by the student. Revoking the
  // teacher must surface BOTH descendants.
  const dag = dagMod.buildDag({
    nodes: [
      { id: 'teacher_001', kind: 'teacher' },
      { id: 'student_001', kind: 'student' },
      { id: 'rt_probe_002', kind: 'runtime' },
    ],
    edges: [
      { from: 'student_001',  to: 'teacher_001', relationship: 'derived_from' },
      { from: 'rt_probe_002', to: 'student_001', relationship: 'validated_by' },
    ],
  });
  const verdict = dagMod.revoke(dag, 'teacher_001');
  assert.deepEqual(verdict.revoked, ['teacher_001']);
  // Both student and runtime probe must surface in needs_review.
  assert.ok(verdict.needs_review.includes('student_001'), 'student is direct derived_from descendant');
  assert.ok(verdict.needs_review.includes('rt_probe_002'), 'runtime is transitive descendant');
  assert.equal(verdict.needs_review.length, 2, 'exactly two descendants');
});

// =============================================================================
// #3 — R-3 + R-4: gguf+CUDA detection feeds a llama.cpp compose file.
// =============================================================================
//
// The serve auto-detect picks a runtime based on (artifact format, hw probe).
// That runtime string must be accepted by the deploy generators so the
// operator can take the same artifact from "detect" to "compose file" in one
// pipeline. This test walks: gguf artifact + CUDA hwProbe -> detectRuntime
// returns 'llama.cpp' with -ngl in the args -> generateDockerCompose with
// that runtime emits a YAML that references the llama.cpp container image
// (NOT the vLLM image).
test('R11 #3 — R-3 detectRuntime(gguf+CUDA) -> R-4 generateDockerCompose llama.cpp wire', () => {
  const detection = serveAutodetect.detectRuntime({
    artifactPath: '/tmp/model.gguf',
    hwProbe: { primary: { vendor: 'nvidia', name: 'RTX 5090', vram_gb: 32 } },
    port: 8000,
  });
  assert.equal(detection.runtime, 'llama.cpp');
  assert.equal(detection.format, 'gguf');
  assert.equal(detection.gpu_class, 'cuda');
  assert.ok(detection.command, 'detection must include a spawn command');
  assert.equal(detection.command.bin, 'llama-server');
  assert.ok(detection.command.args.includes('-ngl'),
    'CUDA path must pass -ngl to llama-server');

  // Feed the detected runtime into R-4 deploy generator.
  const composeYaml = deployGen.generateDockerCompose({
    artifact: 'model-r11-3',
    runtime: detection.runtime,
    port: 8000,
  });
  assert.equal(typeof composeYaml, 'string');
  assert.ok(composeYaml.includes('ghcr.io/ggml-org/llama.cpp:server'),
    'llama.cpp compose must reference the llama.cpp container image');
  // And must NOT reference the vllm image — picking the wrong image silently
  // would be the worst-case integration bug.
  assert.ok(!composeYaml.includes('vllm/vllm-openai'),
    'llama.cpp compose must NOT reference the vllm image');
  assert.ok(composeYaml.includes('model-r11-3'), 'compose must mount the named artifact');
});

// =============================================================================
// #4 — R-4 -> R-6: air-gap bundle SHA256 + assurance case envelope.
// =============================================================================
//
// generateAirgapBundle (R-4) writes a tar.gz to disk and returns a SHA256
// of the manifest. That SHA256 is the procurement-grade artifact the
// reviewer in R-6 (assurance case) attaches to evidence. This test
// generates a real bundle, confirms the SHA256 is the expected hex shape,
// and confirms an assurance case built off an artifact that references the
// bundle SHA256 in its receipt survives validation.
test('R11 #4 — R-4 air-gap bundle SHA256 attaches to an R-6 assurance case as evidence', () => {
  // Stage a fake artifact file in our tmpdir.
  const stage = path.join(TEST_DATA_DIR, 'r11-4-stage');
  fs.mkdirSync(stage, { recursive: true });
  const artifactPath = path.join(stage, 'art_r11_4.kolm');
  fs.writeFileSync(artifactPath, Buffer.from('fake artifact bytes for r11 #4'));

  const outDir = path.join(stage, 'out');
  const bundle = deployGen.generateAirgapBundle({
    artifact_path: artifactPath,
    runtime: 'llama.cpp',
    output_dir: outDir,
  });
  assert.equal(bundle.ok, true, 'bundle generation must succeed');
  assert.match(bundle.manifest_sha256, /^[0-9a-f]{64}$/, 'manifest_sha256 must be 64-hex');
  assert.match(bundle.sha256, /^[0-9a-f]{64}$/, 'bundle sha256 must be 64-hex');
  assert.ok(fs.existsSync(bundle.bundle_path), 'bundle tarball must exist on disk');
  assert.ok(bundle.size_bytes > 0, 'bundle must be non-empty');

  // Now build an assurance case for an artifact that references the bundle
  // SHA256 in its receipt summary. The case must include the SHA in at
  // least one place — either as a claim evidence id, or via the receipt
  // signature_fingerprint (which we set to the bundle SHA so a downstream
  // grep finds it).
  const artifact = {
    id: bundle.artifact_id,
    namespace: 'prod-r11',
    manifest: {
      artifact_id: bundle.artifact_id,
      runtime_passports: [
        runtimePassport.estimatePassport({
          target_id: 'gguf-q4_k_m-llama.cpp',
          runtime: 'llama.cpp',
          runtime_version: 'b3415',
          precision: 'q4_k_m',
          params_b: 7,
        }),
      ],
      evidence_dag: {
        nodes: [
          { id: 'cap_001', kind: 'capture' },
          { id: 'rt_001',  kind: 'rights', covers: ['cap_001'] },
          { id: 'airgap_001', kind: 'signature',
            bundle_sha256: bundle.sha256,
            manifest_sha256: bundle.manifest_sha256 },
        ],
      },
    },
    receipt: {
      signature_ed25519: 'aabb...',
      signature_mode: 'ed25519',
      signature_fingerprint: bundle.sha256,
      receipts: [{ cid: 'cidv1:sha256:' + bundle.sha256.slice(0, 32), kind: 'kolm-audit-1' }],
    },
  };

  const envelope = assurance.buildAssuranceCase({ artifact });
  const validation = assurance.validateAssuranceCase(envelope);
  assert.equal(validation.ok, true,
    'assurance case envelope must validate: ' + JSON.stringify(validation.reasons));
  // The receipt signature_fingerprint = bundle SHA256 — assurance case
  // surfaces it on the envelope.signed_by string.
  assert.ok(envelope.signed_by, 'envelope must record a signed_by line');
  assert.ok(envelope.signed_by.includes(bundle.sha256),
    'signed_by must surface the bundle SHA256 fingerprint');
});

// =============================================================================
// #5 — R-5 -> R-6: revoked node still produces an assurance case.
// =============================================================================
//
// When a node in the evidence DAG is revoked (R-5), the assurance case
// generator (R-6) must still produce a valid envelope — it should not
// throw. The closest available downgrade signal is that data provenance
// drops to 'package-gated' when the capture node referenced by rights is
// absent from the DAG (mimicking the post-revoke state).
//
// Note on API surprise: assurance-case.js does NOT currently emit an
// explicit 'stale_evidence' warning string — the closest behavior is the
// status downgrade + limitations text. This test pins what the API does
// today rather than rewriting the module to add a warning we have not
// shipped.
test('R11 #5 — revoking a DAG node leaves R-6 assurance case in a downgraded but valid state', () => {
  // Build a DAG with capture + eval + signature, revoke the capture, and
  // then build an assurance case off an artifact whose DAG drops the
  // revoked capture (simulating the post-revoke snapshot).
  const dagFull = dagMod.buildDag({
    nodes: [
      { id: 'cap_revoked', kind: 'capture' },
      { id: 'eval_001',    kind: 'eval' },
    ],
    edges: [
      { from: 'eval_001', to: 'cap_revoked', relationship: 'validated_by' },
    ],
  });
  const verdict = dagMod.revoke(dagFull, 'cap_revoked');
  assert.deepEqual(verdict.revoked, ['cap_revoked']);
  assert.ok(verdict.needs_review.includes('eval_001'),
    'eval that was validated_by the revoked capture must surface for review');

  // Post-revoke artifact: capture is gone from the DAG; rights node lost
  // its target. Data provenance claim should downgrade, not throw.
  const artifact = {
    id: 'art_r11_5',
    namespace: 'prod-r11',
    manifest: {
      artifact_id: 'art_r11_5',
      runtime_passports: [],
      evidence_dag: {
        nodes: [
          // Note: capture is intentionally absent (post-revoke).
          { id: 'eval_001', kind: 'eval' },
        ],
      },
    },
    receipt: null,
  };
  const envelope = assurance.buildAssuranceCase({ artifact });
  const validation = assurance.validateAssuranceCase(envelope);
  assert.equal(validation.ok, true,
    'assurance case must still produce a valid envelope after revoke: '
    + JSON.stringify(validation.reasons));

  // Every claim downgraded (none should be 'implemented' because the
  // evidence is gone).
  const provenance = envelope.claims.find((c) => /captures are tied to a verified rights/i.test(c.claim));
  assert.ok(provenance, 'data provenance claim must be present');
  assert.notEqual(provenance.status, 'implemented',
    'with capture revoked, data provenance MUST NOT be implemented');
  assert.ok(provenance.limitations.length > 0,
    'downgraded claim must record limitations the reviewer can read');
  // Model integrity downgrades because receipt is null.
  const integrity = envelope.claims.find((c) => /cryptographically signed/i.test(c.claim));
  assert.ok(integrity, 'model integrity claim must be present');
  assert.notEqual(integrity.status, 'implemented',
    'unsigned artifact MUST downgrade model integrity');
});

// =============================================================================
// #6 — R-7 end-to-end: 50 baseline + 50 shifted lookback trips drift.
// =============================================================================
//
// The drift detector accepts injected readReceipts/readCaptures so we can
// drive a fully deterministic end-to-end run without writing to disk. We
// stage:
//   - 50 baseline receipts (route_decision = 'local', steady-state prompts)
//   - 50 baseline captures (same English vocab)
//   - 50 lookback receipts where 25 are 'frontier_fallback' (rising rate)
//   - 50 lookback captures with deliberately shifted vocab
// At minimum we expect the SPC ladder to land on 'warn' or 'alert' (NOT
// 'ok') — pinning the exact tier is brittle because the SPC sigma floor
// depends on absolute deltas, so we assert the worst-of-three is at least
// 'warn'.
test('R11 #6 — R-7 drift detector fires at least warn on a deliberately shifted lookback', () => {
  const DAY = 24 * 3600 * 1000;
  const NOW = Date.UTC(2026, 4, 26, 12, 0, 0);
  // Baseline window is 30 days back (from -37d to -7d); lookback window is
  // -7d to NOW. Stage rows accordingly.
  const baselineStart = NOW - 37 * DAY;
  const baselineEnd = NOW - 7 * DAY;
  const lookbackStart = NOW - 7 * DAY;
  // Spread receipts evenly across each window.
  const baselineReceipts = [];
  const baselineCaptures = [];
  for (let i = 0; i < 50; i++) {
    const ts = baselineStart + Math.floor(((i + 0.5) / 50) * (baselineEnd - baselineStart));
    baselineReceipts.push({
      tenant: 'tenant_r11_6',
      namespace: 'ns_r11_6',
      route_decision: 'local',
      cost_usd: 0,
      input_tokens: 100,
      output_tokens: 50,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      ts,
    });
    baselineCaptures.push({
      tenant: 'tenant_r11_6',
      namespace: 'ns_r11_6',
      prompt_redacted: 'order status lookup item ' + i + ' shipping eta',
      ts,
    });
  }
  const lookbackReceipts = [];
  const lookbackCaptures = [];
  for (let i = 0; i < 50; i++) {
    const ts = lookbackStart + Math.floor(((i + 0.5) / 50) * (NOW - lookbackStart));
    // Half the lookback receipts land on frontier_fallback - that's the
    // rising fallback-rate signal.
    const decision = i % 2 === 0 ? 'frontier_fallback' : 'local';
    lookbackReceipts.push({
      tenant: 'tenant_r11_6',
      namespace: 'ns_r11_6',
      route_decision: decision,
      cost_usd: decision === 'frontier_fallback' ? 0.005 : 0,
      input_tokens: 100,
      output_tokens: 50,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      ts,
    });
    // Shifted vocab — entirely different words from baseline so cosine
    // distance climbs.
    lookbackCaptures.push({
      tenant: 'tenant_r11_6',
      namespace: 'ns_r11_6',
      prompt_redacted: 'refund cancel subscription billing dispute charge ' + i,
      ts,
    });
  }

  const verdict = drift.computeDriftSignals({
    tenant_id: 'tenant_r11_6',
    namespace: 'ns_r11_6',
    lookback_days: 7,
    baseline_days: 30,
    now: NOW,
    readReceipts: () => baselineReceipts.concat(lookbackReceipts),
    readCaptures: () => baselineCaptures.concat(lookbackCaptures),
  });
  assert.equal(verdict.ok, true);
  // The status MUST escalate above 'ok' — both signals are deliberately
  // skewed (fallback rate jumps from 0 to ~50%, vocab is disjoint).
  assert.notEqual(verdict.status, 'ok',
    'shifted lookback must trip at least warn; got status=' + verdict.status
    + ' details=' + JSON.stringify(verdict.details && verdict.details.per_signal_status));
  // And on a non-ok status the module must emit a recommendation the
  // operator can paste into a terminal.
  assert.ok(verdict.recommendation, 'non-ok status must produce a recommendation');
  assert.ok(verdict.recommendation.includes('kolm distill'),
    'recommendation must include the kolm distill remediation command');
});

// =============================================================================
// #7 — R-8 end-to-end: baseline vs actual produces a numeric payback.
// =============================================================================
//
// Confirms the cost-displacement module computes a sensible payback
// period when given a deliberately rigged scenario:
//   - 30-day window, all-local receipts
//   - compile_cost_usd = $300 (the artifact build cost)
//   - injected receipts so that the baseline (frontier) cost greatly
//     exceeds the actual local cost.
// The payback period must be a positive number of months (the rigged
// inputs make savings > 0).
test('R11 #7 — R-8 cost displacement produces a numeric payback_period_months when savings > 0', () => {
  const DAY = 24 * 3600 * 1000;
  const NOW = Date.UTC(2026, 4, 26, 12, 0, 0);
  // 30 local receipts with realistic token shapes. Each receipt's
  // counterfactual frontier cost is computed off the claude-haiku-4-5
  // rate ($0.80/M input, $4.00/M output).
  //   Per-row baseline: (1000 * 0.80 + 500 * 4.00) / 1e6 = $0.0028
  //   30 rows -> baseline ~= $0.084
  //   actual = $0 (local)
  //   savings = ~$0.084
  // We use higher token counts so savings/payback math stays meaningful.
  // We deliberately scale tokens UP so monthly savings is non-trivial.
  // Per row: (10_000 * 0.80 + 5000 * 4.00) / 1e6 = $0.028
  // 30 rows -> baseline = $0.84 over 30 days = monthly rate $0.84
  // compile_cost = $300 -> payback ~ 357 months (positive number)
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const ts = NOW - (29 - i) * DAY;
    rows.push({
      tenant: 'tenant_r11_7',
      namespace: 'ns_r11_7',
      route_decision: 'local',
      cost_usd: 0,
      input_tokens: 10_000,
      output_tokens: 5000,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      ts,
    });
  }
  const verdict = cost.computeDisplacement({
    tenant_id: 'tenant_r11_7',
    namespace: 'ns_r11_7',
    period_days: 30,
    now: NOW,
    readReceipts: () => rows,
    compile_cost_usd: 300,
    deployed_at_ms: NOW - 30 * DAY,
    frontier_provider: 'anthropic',
    frontier_model: 'claude-haiku-4-5',
  });
  assert.equal(verdict.ok, true);
  // actual must be 0 (all-local), baseline must be > actual, savings > 0.
  assert.equal(verdict.actual_cost_usd, 0, 'all-local actual cost is $0');
  assert.ok(verdict.baseline_cost_usd > 0,
    'baseline frontier cost must be > 0 with 30 priced rows');
  assert.ok(verdict.savings_usd > 0, 'savings = baseline - actual must be positive');
  // payback_period_months must be a finite positive number (compile_cost
  // is > 0, savings > 0).
  assert.equal(typeof verdict.payback_period_months, 'number',
    'payback_period_months must be a number (got ' + typeof verdict.payback_period_months + ')');
  assert.ok(verdict.payback_period_months > 0,
    'payback period must be positive given positive savings');
  // Manual sanity: payback = compile_cost / monthly_rate.
  // monthly_rate = (savings / 30) * 30 = savings (since period_days = 30).
  const expectedPayback = 300 / verdict.savings_usd;
  // Approximate equality within 1% — float drift only.
  const diff = Math.abs(verdict.payback_period_months - expectedPayback) / expectedPayback;
  assert.ok(diff < 0.01,
    'payback ' + verdict.payback_period_months + ' must approx equal '
    + expectedPayback + ' (diff=' + diff + ')');
});

// =============================================================================
// #8 — R-1..R-8 surface presence: 11 src files + headline exports.
// =============================================================================
//
// One sanity check that every R-series module exists on disk and exports
// the headline symbol the documentation promises. Pure grep — no behavior
// test. This is the wall against accidental deletion / rename collateral
// from sibling waves editing under src/.
test('R11 #8 — 11 R-series source files exist and export their headline symbols', async () => {
  const expected = [
    { file: 'src/runtime-passport.js',     symbols: ['validatePassport', 'estimatePassport', 'recordTestedPassport', 'RUNTIME_PASSPORT_FIELDS'] },
    { file: 'src/artifact-lifecycle.js',   symbols: ['LIFECYCLE_STATES', 'VALID_TRANSITIONS', 'transition', 'canPull', 'loadOrInit'] },
    { file: 'src/serve-autodetect.js',     symbols: ['detectRuntime', 'KNOWN_RUNTIMES'] },
    { file: 'src/serve-metrics-sidecar.js',symbols: ['parseRuntimeLogLine', 'startMetricsSidecar'] },
    { file: 'src/deploy-generators.js',    symbols: ['generateDockerCompose', 'generateKubernetesManifests', 'generateVllmConfig', 'generateAirgapBundle'] },
    { file: 'src/evidence-dag.js',         symbols: ['buildDag', 'trace', 'descendants', 'revoke', 'EVIDENCE_KINDS', 'EVIDENCE_RELATIONSHIPS'] },
    { file: 'src/evidence-store.js',       symbols: ['writeEvidenceDag', 'readEvidenceDag'] },
    { file: 'src/assurance-case.js',       symbols: ['buildAssuranceCase', 'validateAssuranceCase', 'CLAIM_STATUSES', 'REQUIRED_CONTROL_ROWS'] },
    { file: 'src/assurance-case-pdf.js',   symbols: ['renderAssuranceCasePdf'] },
    { file: 'src/drift-detector.js',       symbols: ['computeDriftSignals', 'pseudoEmbed', 'cosineDistance', 'SIGMA_WARN', 'SIGMA_ALERT'] },
    { file: 'src/cost-displacement.js',    symbols: ['computeDisplacement', 'COST_DISPLACEMENT_VERSION', 'DEFAULT_PERIOD_DAYS'] },
  ];
  for (const e of expected) {
    const abs = path.join(REPO_ROOT, e.file);
    assert.ok(fs.existsSync(abs), 'expected file missing: ' + e.file);
    const src = fs.readFileSync(abs, 'utf8');
    for (const sym of e.symbols) {
      // Match either `export function NAME`, `export const NAME`,
      // `export class NAME`, or `export { ... NAME ... }` form.
      const re = new RegExp(
        '(?:export\\s+(?:function|const|let|var|class|async\\s+function)\\s+'
        + sym + '\\b)'
        + '|(?:export\\s*\\{[^}]*\\b' + sym + '\\b[^}]*\\})',
      );
      assert.ok(re.test(src),
        e.file + ' missing exported symbol ' + sym);
    }
  }
  // Now confirm we can actually import each module without a load-time
  // throw (catches: accidentally introduced syntax error, top-level
  // throw on import).
  for (const e of expected) {
    const url = pathToFileURL(path.join(REPO_ROOT, e.file)).href;
    const mod = await import(url);
    assert.ok(mod && typeof mod === 'object', 'import of ' + e.file + ' returned no module');
    for (const sym of e.symbols) {
      assert.ok(sym in mod, e.file + ' import did not expose ' + sym);
    }
  }
});
