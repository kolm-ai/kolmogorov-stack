import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

import { buildAndZip } from '../src/artifact.js';
import { loadArtifact } from '../src/artifact-runner.js';
import { verifyArtifactProvenanceSidecars } from '../src/artifact-provenance-verify.js';
import { verifyArtifactStructured } from '../src/binder.js';

const SOURCE_DATE_EPOCH = 1700000000;
const SOURCE_DATE_ISO = '2023-11-14T22:13:20.000Z';

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function realSeedProvenance() {
  const trainRows = [{ input: 'q1', output: 'a1' }, { input: 'q2', output: 'a2' }];
  const holdoutRows = [{ input: 'q3', output: 'a3' }];
  return {
    seeds_hash: sha256(Buffer.from(JSON.stringify([...trainRows, ...holdoutRows]))),
    split_seed: 'c7-fixture-v1',
    holdout_ratio: 0.2,
    train_hash: sha256(Buffer.from(JSON.stringify(trainRows))),
    holdout_hash: sha256(Buffer.from(JSON.stringify(holdoutRows))),
    train_count: 80,
    holdout_count: 20,
    eval_source: 'captured_io',
    leakage_report_hash: sha256(Buffer.from('clean-c7-leakage-report')),
    comparator: 'exact',
    production_ready: false,
    min_train: 50,
    min_holdout: 10,
    input_overlap_count: 0,
    output_overlap_count: 0,
    near_duplicate_count: 0,
    grouped_overlap_count: 0,
    source_seed_count: 100,
    approved_count: 100,
    synthetic_count: 0,
    eval_provenance: 'real_eval',
    event_source_hashes: [sha256(Buffer.from('event-1')), sha256(Buffer.from('event-2'))],
  };
}

function rezipWithEntryReplaced(srcPath, dstPath, entryName, newBytes) {
  const src = new AdmZip(srcPath);
  const out = new AdmZip();
  for (const e of src.getEntries()) {
    out.addFile(e.entryName, e.entryName === entryName ? Buffer.from(newBytes) : e.getData());
  }
  out.writeZip(dstPath);
}

function withIsolatedEnv() {
  const keys = [
    'HOME',
    'USERPROFILE',
    'KOLM_HOME',
    'KOLM_DATA_DIR',
    'RECIPE_RECEIPT_SECRET',
    'KOLM_ED25519_DISABLE',
    'KOLM_SIGSTORE_DISABLE',
    'KOLM_SIGSTORE_REKOR_URL',
    'SOURCE_DATE_EPOCH',
    'KOLM_SOURCE_DATE_EPOCH',
    'KOLM_REPRODUCIBLE_BUILD',
  ];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-c7-'));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-c7-repro-fixture-secret';
  delete process.env.KOLM_ED25519_DISABLE;
  delete process.env.KOLM_SIGSTORE_DISABLE;
  delete process.env.KOLM_SIGSTORE_REKOR_URL;
  delete process.env.SOURCE_DATE_EPOCH;
  delete process.env.KOLM_SOURCE_DATE_EPOCH;
  delete process.env.KOLM_REPRODUCIBLE_BUILD;
  return {
    tmp,
    restore() {
      for (const k of keys) {
        if (old[k] === undefined) delete process.env[k];
        else process.env[k] = old[k];
      }
    },
  };
}

function buildSpec(outPath, overrides = {}) {
  return {
    job_id: 'c7_repro_real_artifact',
    task: 'c7 real artifact reproducibility',
    base_model: 'none',
    recipes: [{
      id: 'echo_rule',
      name: 'Echo rule',
      source: 'function generate(input) { return { text: String(input.text || input) }; }',
    }],
    training_stats: { verifier_accepted: true, pass_rate_positive: 1, latency_p50_us: 50 },
    evals: { spec: 'rs-1-evals', coverage: 1, cases: [{ id: 'e1', input: 'hello', expected: 'hello' }] },
    judge_id: 'c7-judge',
    tier: 'recipe',
    seed_provenance: realSeedProvenance(),
    allow_below_gate: true,
    outPath,
    source_date_epoch: SOURCE_DATE_EPOCH,
    ...overrides,
  };
}

async function buildRealArtifact(tmp, filename, overrides = {}) {
  return buildAndZip(buildSpec(path.join(tmp, filename), overrides));
}

test('C7: live buildAndZip emits byte-identical .kolm files with source_date_epoch', async () => {
  const env = withIsolatedEnv();
  try {
    const a = await buildRealArtifact(env.tmp, 'a.kolm');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const b = await buildRealArtifact(env.tmp, 'b.kolm');

    assert.equal(sha256File(a.outPath), sha256File(b.outPath), 'real .kolm zip bytes must be reproducible');
    assert.equal(a.artifact_hash, b.artifact_hash, 'artifact_hash must be stable across reproducible rebuilds');
    assert.equal(a.cid, b.cid, 'CID must be stable across reproducible rebuilds');

    const loaded = loadArtifact(a.outPath);
    assert.equal(loaded.signature_valid, true);
    assert.equal(loaded.manifest.created_at, SOURCE_DATE_ISO);
    assert.deepEqual(loaded.manifest.reproducible_build, {
      spec: 'kolm-reproducible-build-v1',
      source_date_epoch: SOURCE_DATE_EPOCH,
      timestamp: SOURCE_DATE_ISO,
    });
    assert.match(loaded.receipt.receipt_id, /^rcpt_[0-9a-f]{32}$/);
    assert.equal(loaded.receipt.signed_at, SOURCE_DATE_ISO);
  } finally {
    env.restore();
  }
});

test('C7: final .kolm verifies SLSA and OMS sidecars from the embedded signer public key', async () => {
  const env = withIsolatedEnv();
  try {
    const built = await buildRealArtifact(env.tmp, 'sidecars.kolm');
    const v = verifyArtifactProvenanceSidecars(built.outPath);
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.present, true);
    assert.ok(v.subjects_total >= 3, 'sidecars cover multiple artifact members');
    assert.equal(v.slsa.subjects_matched, v.slsa.subjects_total);
    assert.equal(v.oms.subjects_matched, v.oms.subjects_total);

    const structured = await verifyArtifactStructured(built.outPath, { runProductionCheck: false });
    assert.equal(structured.ok, true, structured.detail || structured.reason);
    const check = structured.checks.find((c) => c.name === 'Provenance sidecars (SLSA/OMS, signer-derived)');
    assert.ok(check, 'binder emits the signer-derived sidecar check');
    assert.equal(check.status, 'pass', check.detail);
  } finally {
    env.restore();
  }
});

test('C7: sidecar verifier catches tampering of a non-seal artifact member', async () => {
  const env = withIsolatedEnv();
  try {
    const built = await buildRealArtifact(env.tmp, 'tamper-source.kolm');
    const tampered = path.join(env.tmp, 'tampered.kolm');
    fs.copyFileSync(built.outPath, tampered);

    const zip = new AdmZip(built.outPath);
    const recipes = zip.getEntry('recipes.json').getData();
    rezipWithEntryReplaced(built.outPath, tampered, 'recipes.json', Buffer.concat([recipes, Buffer.from('\n')]));

    const v = verifyArtifactProvenanceSidecars(tampered);
    assert.equal(v.ok, false, 'tampering recipes.json must break sidecar verification');
    assert.match(v.reason, /SLSA sidecar failed|OMS sidecar failed|subject digest mismatch/i);
  } finally {
    env.restore();
  }
});
