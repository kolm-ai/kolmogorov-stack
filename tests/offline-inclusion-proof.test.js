// GAP-7 - offline transparency-log inclusion proof + trust-anchor mirror.
//
// A signed report's log_checkpoint used to carry only (root_hash, seq): the
// buyer had to call the LIVE /v1/transparency-log/proof/:seq endpoint to check
// inclusion, putting kolm's origin inside the trust path. Now the Merkle audit
// path is embedded in the checkpoint AT SIGNING TIME, so:
//   - the Node verifier (src/transparency-log.js verifyInclusionProof) and
//   - the browser verifier (public/kolm-audit-verify.js verifyInclusionOffline)
// both prove inclusion fully offline. The mirror script
// (scripts/mirror-trust-anchors.mjs) lets independent parties keep write-once
// copies of the signed tree heads so a split view becomes durable evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runAudit } from '../src/audit-orchestrator.js';
import { buildAndSignReport, verifyReport, canonicalizeReport } from '../src/attestation-report-builder.js';
import { TransparencyLog, verifyInclusionProof } from '../src/transparency-log.js';
import { verifyInclusionOffline } from '../public/kolm-audit-verify.js';
import { rmSyncBestEffort } from './_spawn-helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');
const MIRROR_SCRIPT = path.join(ROOT, 'scripts', 'mirror-trust-anchors.mjs');

function dirtyAudit() {
  return runAudit(fs.readFileSync(FIXTURE, 'utf8'), { source: 'litellm' });
}

// Sign N reports into one isolated in-memory log; return the envelopes.
function signInto(log, n) {
  const audit = dirtyAudit();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(buildAndSignReport(audit, { subject: 'Inc ' + i, transparencyLog: log }).envelope);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the embedded proof.
// ---------------------------------------------------------------------------
test('signing embeds an RFC 9162 inclusion proof inside log_checkpoint', () => {
  const log = new TransparencyLog({ origin: 'kolm.ai/test/inclusion' });
  const [e1, , e3] = signInto(log, 3);
  for (const env of [e1, e3]) {
    const cp = env.log_checkpoint;
    assert.ok(cp, 'checkpoint attached');
    const inc = cp.inclusion;
    assert.ok(inc, 'inclusion proof embedded at signing time');
    assert.equal(typeof inc.leaf_index, 'number');
    assert.ok(Array.isArray(inc.audit_path));
    assert.match(inc.root_hash, /^[0-9a-f]{64}$/);
  }
  // First report was signed into a then-1-leaf tree (empty path); the third
  // sees a 3-leaf tree and must carry a non-empty path.
  assert.equal(e1.log_checkpoint.inclusion.tree_size, 1);
  assert.equal(e1.log_checkpoint.inclusion.audit_path.length, 0, 'single-leaf proof is the empty path');
  assert.equal(e3.log_checkpoint.inclusion.tree_size, 3);
  assert.ok(e3.log_checkpoint.inclusion.audit_path.length >= 1, 'multi-leaf proof carries siblings');
});

test('the Node verifier proves inclusion offline from the checkpoint alone', () => {
  const log = new TransparencyLog({ origin: 'kolm.ai/test/inclusion' });
  const envs = signInto(log, 4);
  for (const env of envs) {
    const cp = env.log_checkpoint;
    const r = verifyInclusionProof({
      leaf_hash: cp.leaf_hash,
      leaf_index: cp.inclusion.leaf_index,
      tree_size: cp.inclusion.tree_size,
      audit_path: cp.inclusion.audit_path,
      root_hash: cp.inclusion.root_hash,
    });
    assert.equal(r.ok, true, 'offline inclusion verifies: ' + (r.reason || ''));
  }
});

test('the browser verifier (WebCrypto port) agrees with the Node verifier', async () => {
  const log = new TransparencyLog({ origin: 'kolm.ai/test/inclusion' });
  const envs = signInto(log, 5);
  for (const env of envs) {
    const r = await verifyInclusionOffline(env.log_checkpoint);
    assert.equal(r.ok, true, 'browser-side inclusion verifies: ' + (r.reason || ''));
    assert.equal(r.tree_size, env.log_checkpoint.inclusion.tree_size);
  }
});

test('a tampered path, wrong index, or cross-tree root is rejected offline', async () => {
  const log = new TransparencyLog({ origin: 'kolm.ai/test/inclusion' });
  const envs = signInto(log, 4);
  const cp = JSON.parse(JSON.stringify(envs[3].log_checkpoint));
  assert.ok(cp.inclusion.audit_path.length >= 1, 'fixture proof has a sibling to tamper');

  const flipped = JSON.parse(JSON.stringify(cp));
  flipped.inclusion.audit_path[0] = flipped.inclusion.audit_path[0].replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  assert.equal((await verifyInclusionOffline(flipped)).ok, false, 'tampered sibling rejected');

  const wrongIdx = JSON.parse(JSON.stringify(cp));
  wrongIdx.inclusion.leaf_index = (wrongIdx.inclusion.leaf_index + 1) % wrongIdx.inclusion.tree_size;
  assert.equal((await verifyInclusionOffline(wrongIdx)).ok, false, 'wrong leaf_index rejected');

  // A real proof from a DIFFERENT tree must not pair with this checkpoint.
  const crossRoot = JSON.parse(JSON.stringify(cp));
  crossRoot.inclusion.root_hash = '0'.repeat(64);
  const cross = await verifyInclusionOffline(crossRoot);
  assert.equal(cross.ok, false);
  assert.match(cross.reason, /differs from checkpoint/);
});

test('a pre-2026 checkpoint without an embedded path degrades cleanly', async () => {
  const log = new TransparencyLog({ origin: 'kolm.ai/test/inclusion' });
  const [env] = signInto(log, 1);
  const old = JSON.parse(JSON.stringify(env.log_checkpoint));
  delete old.inclusion;
  const r = await verifyInclusionOffline(old);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_embedded_proof', 'caller can fall back to the live proof endpoint');
  assert.equal((await verifyInclusionOffline(null)).ok, false, 'null input never throws');
});

test('embedding the proof never changes the signed bytes (backward compatible)', () => {
  const log = new TransparencyLog({ origin: 'kolm.ai/test/inclusion' });
  const [env] = signInto(log, 1);
  assert.equal(verifyReport(env).ok, true, 'report with embedded proof verifies');
  const stripped = JSON.parse(JSON.stringify(env));
  delete stripped.log_checkpoint;
  assert.equal(canonicalizeReport(env), canonicalizeReport(stripped), 'log_checkpoint stays outside the canonical bytes');
  assert.equal(verifyReport(stripped).ok, true, 'a verifier that drops the checkpoint still verifies the signature');
});

// ---------------------------------------------------------------------------
// trust-anchor mirror script.
// ---------------------------------------------------------------------------
function runMirror(env, args = []) {
  return spawnSync(process.execPath, [MIRROR_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('mirror-trust-anchors: capture is write-once, --check passes, split view fails loudly', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-mirror-'));
  t.after(() => rmSyncBestEffort(base));
  const dataDir = path.join(base, 'data');
  const mirrorDir = path.join(base, 'anchors');
  fs.mkdirSync(dataDir, { recursive: true });
  const env = {
    KOLM_DATA_DIR: dataDir,
    KOLM_STORE_DRIVER: 'json',
    KOLM_TRUST_MIRROR_DIR: mirrorDir,
    KOLM_TRUST_MIRROR_URL: '', // local self-mirror mode
  };

  // 1. first capture writes an anchor + latest.json.
  let r = runMirror(env);
  assert.equal(r.status, 0, 'capture succeeds: ' + r.stderr);
  const anchors = fs.readdirSync(mirrorDir).filter((f) => f.startsWith('anchor-'));
  assert.equal(anchors.length, 1, 'one tree_size-keyed anchor written');
  assert.ok(fs.existsSync(path.join(mirrorDir, 'latest.json')));
  const doc = JSON.parse(fs.readFileSync(path.join(mirrorDir, anchors[0]), 'utf8'));
  assert.ok(doc.signed_tree_head && /^[0-9a-f]{64}$/i.test(doc.signed_tree_head.root_hash), 'tree head mirrored');
  assert.ok(doc.generated_at, 'capture is timestamped');
  assert.ok(Object.prototype.hasOwnProperty.call(doc, 'issuers'), 'issuer keyring slot present');
  assert.ok(Object.prototype.hasOwnProperty.call(doc, 'key_statuses'), 'key lifecycle slot present');

  // 2. an identical re-capture is a clean no-op; --check passes.
  r = runMirror(env);
  assert.equal(r.status, 0, 're-capture of the same head is a no-op: ' + r.stderr);
  r = runMirror(env, ['--check']);
  assert.equal(r.status, 0, '--check passes on a consistent mirror: ' + r.stderr);

  // 3. forge a split view: same tree_size, different root. --check must fail
  //    and a re-capture must refuse to overwrite the write-once anchor.
  const forged = JSON.parse(JSON.stringify(doc));
  forged.signed_tree_head.root_hash = 'f'.repeat(64);
  fs.writeFileSync(path.join(mirrorDir, anchors[0]), JSON.stringify(forged, null, 2));
  r = runMirror(env, ['--check']);
  assert.notEqual(r.status, 0, '--check fails on a split view');
  assert.match(String(r.stderr), /SPLIT VIEW/);
  r = runMirror(env);
  assert.equal(r.status, 2, 'capture refuses to overwrite a divergent write-once anchor');
  assert.match(String(r.stderr), /write-once/);
});
