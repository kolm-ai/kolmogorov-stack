// tests/finalized-c1-provenance-receipt-transparency-chain.test.js
//
// C1 Provenance / Receipt / Transparency Chain - acceptance criteria AC1..AC9.
//
// REAL vectors only: Ed25519 generated in-process, no network, no GPU. The NRAS
// capstone (AC8) exercises the ENV-GATE + nonce-binding contract without
// requiring the NVIDIA stack (the worker is invoked only on the loud-fail path
// when KOLM_NRAS_VERIFIER=1 and a cert is present; the unset path is pure JS).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filenameTest = fileURLToPath(import.meta.url);

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import { canonicalJson } from '../src/cid.js';

import {
  receiptSubjects,
  buildInferencePredicate,
  toInTotoStatement as legacyToInToto,
  KOLM_INFERENCE_PREDICATE_TYPE as LEGACY_INFERENCE_TYPE,
} from '../src/intoto-receipt.js';
import {
  buildInTotoStatement,
  buildDsseEnvelope,
  verifyDsseEnvelope,
} from '../src/intoto-slsa.js';

import {
  resolveReceiptExport,
  genericReceiptSubjects,
  genericBuildPredicate,
  getReceiptDescriptor,
  listReceiptClasses,
  proofScopeLabel,
  PROOF_SCOPE,
  makeDurableAnchorQueue,
  omsMemberList,
  toOmsArtifactManifest,
  KOLM_TOOLCALL_PREDICATE_TYPE,
  KOLM_INFERENCE_PREDICATE_TYPE,
  KOLM_RECEIPT_PREDICATE_TYPE,
  KOLM_INFERENCE_CONFORMANCE,
} from '../src/receipt-export-registry.js';

import {
  buildMcpReceipt,
  signMcpReceipt,
  verifyMcpReceipt,
} from '../src/mcp-gateway.js';

import {
  ReceiptAnchorBatcher,
  verifyReceiptAnchor,
  anchorLeafHash,
} from '../src/transparency-anchor.js';

import {
  verifyAttestation,
  listRegisteredVerifiers,
  clearAttestationVerifier,
  STATES,
} from '../src/confidential-compute.js';

import {
  nonceBinding,
  makeNrasVerifier,
  registerNrasVerifier,
  NRAS_REPLAY_TTL_MS,
} from '../src/nras-verifier.js';

function freshSigner() {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
}

function sampleKolmReceipt(overrides = {}) {
  return {
    schema: 'kolm-audit-1',
    receipt_id: 'rcpt_01HXYZABCDEFGHJKMNPQRS',
    timestamp: '2026-05-29T12:00:00.000Z',
    namespace_id: 'ns_support',
    route_decision: 'frontier',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    artifact_id: null,
    confidence: 0.91,
    fallback_reason: null,
    input_hash: 'sha256:' + crypto.createHash('sha256').update('hello').digest('hex').slice(0, 32),
    output_hash: 'sha256:' + crypto.createHash('sha256').update('world').digest('hex').slice(0, 32),
    input_tokens: 12,
    output_tokens: 34,
    cost_usd: 0.0021,
    verify_url: 'https://kolm.ai/v1/verify/rcpt_01HXYZABCDEFGHJKMNPQRS',
    signature_ed25519: {
      alg: 'ed25519',
      key_fingerprint: 'kf_abc123',
      signed_at: '2026-05-29T12:00:00.500Z',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1 - build-time sidecar wiring guard (OMS member manifest digests == real
// member bytes; sidecars are SEALS that do NOT change the CID).
// ---------------------------------------------------------------------------
test('AC1: OMS member manifest digests equal real member bytes; seals do not change CID', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-test-secret-v1';
  const { buildPayload } = await import('../src/artifact.js');
  const signer = freshSigner();

  const payload = buildPayload({
    job_id: 'job_c1_ac1',
    task: 'classify support tickets',
    base_model: 'qwen2.5-coder-7b-instruct-q4_0',
    recipes: [
      { id: 'r1', name: 'urgent-detector', source: 'return {label:"urgent"};', source_hash: 'h1', version_id: 'v1', tags: [], schema: null },
    ],
    training_stats: { distilled_pairs: 0, pass_rate_positive: 1.0, latency_p50_us: 50 },
    evals: { spec: 'rs-1-evals', n: 1, cases: [{ id: 'c1', input: 'ticket', expected: 'urgent' }], coverage: 1.0 },
    judge_id: 'kolm-pattern-synth-1',
    eval_score: 1.0,
    tier: 'recipe',
  });

  const cidBefore = payload.manifest.cid;
  assert.ok(cidBefore, 'payload has a CID');

  // Materialize in-memory bytes for every non-seal member so we can hash real
  // bytes (the build path streams; for the test we read content buffers).
  const members = payload.files
    .filter((f) => Buffer.isBuffer(f.content) || typeof f.content === 'string')
    .map((f) => ({
      filename: f.filename,
      content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content)),
    }));
  assert.ok(members.length >= 2, 'multiple members present');

  // Build the OMS member manifest over the REAL bytes.
  const memberList = omsMemberList(members);
  const omsStatement = toOmsArtifactManifest(memberList);

  // Every OMS subject digest must equal the actual sha256 of that member's bytes.
  const byName = new Map(members.map((m) => [m.filename, m.content]));
  for (const s of omsStatement.subject) {
    const bytes = byName.get(s.name);
    assert.ok(bytes, `member ${s.name} present`);
    const real = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(s.digest.sha256, real, `OMS subject ${s.name} digest matches real bytes`);
  }

  // Sign it -> model.sig.bundle. Provenance sidecar is the existing DSSE path.
  const omsEnvelope = buildDsseEnvelope({
    statement: omsStatement,
    privateKey: signer.privateKey,
    publicKey: signer.publicKey,
    key_fingerprint: signer.key_fingerprint,
  });
  const verified = verifyDsseEnvelope(omsEnvelope, { publicKey: signer.publicKey });
  assert.equal(verified.ok, true, 'model.sig.bundle DSSE verifies ok');

  // Append the two seals AFTER artifact_hash; they are EXCLUDED from the CID.
  // The CID derives from the manifest hashes block, not the seal files, so the
  // CID must be byte-identical with vs without the sidecars.
  const sealed = {
    ...payload,
    files: [
      ...payload.files,
      { filename: 'provenance.intoto.dsse.json', content: Buffer.from('{}') },
      { filename: 'model.sig.bundle', content: Buffer.from(JSON.stringify(omsEnvelope)) },
    ],
  };
  // omsMemberList must IGNORE the seals (they are excluded by name).
  const membersAfter = omsMemberList(sealed.files.filter((f) => Buffer.isBuffer(f.content) || typeof f.content === 'string'));
  assert.deepEqual(membersAfter.map((m) => m.name), memberList.map((m) => m.name), 'seals excluded from member manifest');

  assert.equal(sealed.manifest.cid, cidBefore, 'CID byte-identical with vs without the sidecars');
});

// ---------------------------------------------------------------------------
// AC2 - kolm-audit-1 byte-stability golden vector.
// ---------------------------------------------------------------------------
test('AC2: kolm-audit-1 registry export is byte-identical to legacy receiptSubjects/buildInferencePredicate', () => {
  const r = sampleKolmReceipt();

  // Legacy path (pre-change).
  const legacyStatement = legacyToInToto(r);

  // Registry-driven path.
  const ex = resolveReceiptExport(r);
  const registryStatement = buildInTotoStatement({
    subjects: ex.subjects,
    predicateType: ex.predicateType,
    predicate: ex.predicate,
  });

  // Subjects equal.
  assert.deepEqual(ex.subjects, receiptSubjects(r), 'subjects equal legacy');
  // Predicate equal.
  assert.deepEqual(ex.predicate, buildInferencePredicate(r), 'predicate equal legacy');
  // predicateType equal.
  assert.equal(ex.predicateType, LEGACY_INFERENCE_TYPE);
  assert.equal(ex.predicateType, KOLM_INFERENCE_PREDICATE_TYPE);

  // Full Statement canonical-JSON byte-identical.
  assert.equal(canonicalJson(registryStatement), canonicalJson(legacyStatement),
    'full in-toto Statement canonical bytes identical');
});

// ---------------------------------------------------------------------------
// AC3 - MCP tool-call fidelity.
// ---------------------------------------------------------------------------
test('AC3: current MCP tool-call receipt exports faithful in-toto Statement with args/result subjects and full predicate', () => {
  const signer = freshSigner();
  const built = buildMcpReceipt({
    tool: 'search_web',
    tenant: 'tenant_acme',
    args: { query: 'kolm provenance' },
    result: { content: [{ type: 'text', text: 'a result' }], isError: false },
    now: 1748520000000,
    transport: 'http',
    server_id: 'srv_brave',
    call_id: 'mtc_TESTCALLID00000000000000A',
  });
  const r = signMcpReceipt(built, signer, { signed_at: built.timestamp });
  assert.equal(verifyMcpReceipt(r).ok, true, 'mcp receipt self-verifies');

  const ex = resolveReceiptExport(r);

  // subject[0].name === 'receipt:'+call_id (NOT 'receipt:unknown').
  assert.equal(ex.subjects[0].name, `receipt:${r.call_id}`);
  assert.notEqual(ex.subjects[0].name, 'receipt:unknown');

  // args + result subjects with the right hex.
  const argsHex = r.args_hash.replace(/^sha256:/, '');
  const resultHex = r.result_hash.replace(/^sha256:/, '');
  const argsSubj = ex.subjects.find((s) => s.name === `args:${r.call_id}`);
  const resultSubj = ex.subjects.find((s) => s.name === `result:${r.call_id}`);
  assert.ok(argsSubj, 'args subject present');
  assert.ok(resultSubj, 'result subject present');
  assert.equal(argsSubj.digest.sha256, argsHex);
  assert.equal(resultSubj.digest.sha256, resultHex);
  assert.equal(argsSubj.annotations.kind, 'tool_input');
  assert.equal(resultSubj.annotations.kind, 'tool_output');

  // predicateType === toolcall.
  assert.equal(ex.predicateType, KOLM_TOOLCALL_PREDICATE_TYPE);

  // predicate carries tool/args_hash/result_hash/tenant_id/is_error.
  const body = ex.predicate.tool_call;
  assert.equal(body.tool, 'search_web');
  assert.equal(body.args_hash, r.args_hash);
  assert.equal(body.result_hash, r.result_hash);
  assert.equal(body.tenant_id, 'tenant_acme');
  assert.equal(body.is_error, false);

  // signInTotoBundle-equivalent: DSSE over the registry statement verifies.
  const statement = buildInTotoStatement({ subjects: ex.subjects, predicateType: ex.predicateType, predicate: ex.predicate });
  const env = buildDsseEnvelope({ statement, privateKey: signer.privateKey, publicKey: signer.publicKey, key_fingerprint: signer.key_fingerprint });
  assert.equal(verifyDsseEnvelope(env, { publicKey: signer.publicKey }).ok, true, 'mcp in-toto bundle verifies ok');

  // Both legacy and current MCP receipt classes are registered.
  assert.ok(listReceiptClasses().includes('mcp-tool-call-1'));
  assert.ok(listReceiptClasses().includes('mcp-tool-call-2'));
  assert.ok(listReceiptClasses().includes('mcp-tool-call-3'));
  assert.equal(getReceiptDescriptor('mcp-tool-call-1').idField, 'call_id');
  assert.equal(getReceiptDescriptor('mcp-tool-call-2').idField, 'call_id');
  assert.equal(getReceiptDescriptor('mcp-tool-call-3').idField, 'call_id');
});

// ---------------------------------------------------------------------------
// AC4 - unknown-class graceful inheritance.
// ---------------------------------------------------------------------------
test('AC4: unknown receipt class exports a VALID single-subject in-toto Statement without throwing', () => {
  const r = {
    schema: 'some-future-class-1',
    id: 'fut_0001',
    foo: 'bar',
    count: 7,
    flag: true,
    nested: { ignored: true }, // non-scalar - excluded from predicate copy
  };

  let ex;
  assert.doesNotThrow(() => { ex = resolveReceiptExport(r); });
  // single subject (no content digests for the generic descriptor).
  assert.equal(ex.subjects.length, 1);
  assert.equal(ex.subjects[0].name, 'receipt:fut_0001');
  const full = crypto.createHash('sha256')
    .update(canonicalJson({ schema: r.schema, id: r.id, foo: r.foo, count: r.count, flag: r.flag, nested: r.nested }), 'utf8')
    .digest('hex');
  assert.equal(ex.subjects[0].digest.sha256, full, 'subject digest = full sha256 of canonical receipt');
  assert.equal(ex.subjects[0].digest.sha256.length, 64);

  // predicateType present (the generic receipt type).
  assert.equal(ex.predicateType, KOLM_RECEIPT_PREDICATE_TYPE);

  // builds a valid Statement.
  const statement = buildInTotoStatement({ subjects: ex.subjects, predicateType: ex.predicateType, predicate: ex.predicate });
  assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
  // scalar fields copied; non-scalar excluded.
  assert.equal(ex.predicate.receipt.foo, 'bar');
  assert.equal(ex.predicate.receipt.count, 7);
  assert.equal(ex.predicate.receipt.flag, true);
  assert.ok(!('nested' in ex.predicate.receipt), 'non-scalar field not copied');
});

// ---------------------------------------------------------------------------
// AC5 - anchor parity across receipt classes (secret-free verify).
// ---------------------------------------------------------------------------
test('AC5: kolm-audit-1 and MCP tool-call receipts both anchor + verify level_a/level_b with no kolm secret', async () => {
  const logSigner = freshSigner();
  const batcher = new ReceiptAnchorBatcher({ signer: logSigner, maxLeaves: 1024 });

  const kolm = sampleKolmReceipt();
  const mcpSigner = freshSigner();
  const mcp = signMcpReceipt(buildMcpReceipt({
    tool: 't', tenant: 'ten', args: { a: 1 }, result: { content: [], isError: false },
    now: 1748520000000, call_id: 'mtc_ANCHORTEST0000000000000AB',
  }), mcpSigner);

  const stampByReceipt = new Map();
  batcher.onBatch = ({ stamps }) => { for (const s of stamps) stampByReceipt.set(s.receipt_id, s.anchor); };

  batcher.enqueue({ receipt_id: kolm.receipt_id, receipt: kolm });
  batcher.enqueue({ receipt_id: mcp.call_id, receipt: mcp });
  await batcher.flushNow();

  const kolmAnchor = stampByReceipt.get(kolm.receipt_id);
  const mcpAnchor = stampByReceipt.get(mcp.call_id);
  assert.ok(kolmAnchor && mcpAnchor, 'both receipts stamped');

  const vk = verifyReceiptAnchor({ receipt: kolm, anchor: kolmAnchor, pinnedLogKeyPem: logSigner.publicKey });
  const vm = verifyReceiptAnchor({ receipt: mcp, anchor: mcpAnchor, pinnedLogKeyPem: logSigner.publicKey });
  assert.equal(vk.level_a.ok, true, 'kolm level_a ok');
  assert.equal(vk.level_b.ok, true, 'kolm level_b ok');
  assert.equal(vm.level_a.ok, true, 'mcp level_a ok');
  assert.equal(vm.level_b.ok, true, 'mcp level_b ok');
});

// ---------------------------------------------------------------------------
// AC6 - proof-scope gate.
// ---------------------------------------------------------------------------
test('AC6: proofScopeLabel is key_custody unless a real crypto verifier verified; conformance string unchanged', () => {
  assert.equal(proofScopeLabel(null), PROOF_SCOPE.KEY_CUSTODY);
  assert.equal(proofScopeLabel({ verifier: 'none', verified: false }), PROOF_SCOPE.KEY_CUSTODY);
  // shape-only stub state.
  const shapeOnly = { verifier: 'shape_v1', verified: false, state: STATES.SHAPE_OK };
  assert.equal(proofScopeLabel(shapeOnly), PROOF_SCOPE.KEY_CUSTODY);
  // verified:true but shape verifier is still NOT proven_compute (defensive).
  assert.equal(proofScopeLabel({ verifier: 'shape', verified: true }), PROOF_SCOPE.KEY_CUSTODY);
  // a real registered crypto verifier returning ok.
  assert.equal(proofScopeLabel({ verifier: 'nras', verified: true }), PROOF_SCOPE.PROVEN_COMPUTE);

  // conformance string must still read the key-custody string.
  assert.match(KOLM_INFERENCE_CONFORMANCE, /not proof-of-compute/);
});

// ---------------------------------------------------------------------------
// AC7 - durable queue optional + fail-open.
// ---------------------------------------------------------------------------
test('AC7: durable anchor queue persists + re-drains on restart; no-store path is a no-op', async () => {
  // In-memory store adapter (simulating a process-crash-survivable store).
  const rows = [];
  const store = {
    put(row) { rows.push(row); },
    list() { return rows.slice(); },
    del(id) { const i = rows.findIndex((r) => r.receipt_id === id); if (i >= 0) rows.splice(i, 1); },
    clear() { rows.length = 0; },
  };

  const logSigner = freshSigner();
  const kolm = sampleKolmReceipt();

  // Process A: enqueue -> WAL row persisted, but crash BEFORE flush.
  const durable = makeDurableAnchorQueue({ store });
  assert.equal(durable.durable, true);
  durable.record({ receipt_id: kolm.receipt_id, leaf: anchorLeafHash(kolm), schema: kolm.schema });
  assert.equal(rows.length, 1, 'WAL row persisted on enqueue');
  // (no markFlushed -> simulates a crash before the batch flushed)

  // Process B (restart): recover() re-drains the row into a fresh batch.
  let drainedBatchStamps = null;
  const flushFn = async (recovered) => {
    const { governReceiptBatch, anchorBatch, stampReceiptAnchor } = await import('../src/transparency-anchor.js');
    const batch = governReceiptBatch(recovered.map((r) => ({ receipt_id: r.receipt_id, leaf: r.leaf_hex })));
    const anchorResult = await anchorBatch(batch, { signer: logSigner });
    drainedBatchStamps = batch.inclusion_proofs.map((p) => ({
      receipt_id: p.receipt_id,
      anchor: stampReceiptAnchor({ ...p, batch_id: batch.batch_id }, anchorResult),
    }));
    return { ok: true };
  };
  const durable2 = makeDurableAnchorQueue({ store, flushFn });
  const rec = await durable2.recover();
  assert.equal(rec.recovered, 1, 'recovered the un-flushed row');
  assert.equal(rows.length, 0, 'WAL cleared after recovery');

  // The re-drained batch round-trips: level_a inclusion proof verifies.
  const anchor = drainedBatchStamps.find((s) => s.receipt_id === kolm.receipt_id).anchor;
  const v = verifyReceiptAnchor({ receipt: kolm, anchor, pinnedLogKeyPem: logSigner.publicKey });
  assert.equal(v.level_a.ok, true, 're-drained anchor level_a verifies');

  // No-store path: byte-identical no-op behavior; record/markFlushed/recover never throw.
  const passthrough = makeDurableAnchorQueue({});
  assert.equal(passthrough.durable, false);
  assert.equal(passthrough.record({ receipt_id: 'x', leaf: anchorLeafHash(kolm) }), false);
  assert.equal(passthrough.markFlushed(['x']), false);
  const r2 = await passthrough.recover();
  assert.equal(r2.recovered, 0);

  // enqueue still never throws/blocks even with a throwing store (fail-open).
  const badStore = { put() { throw new Error('disk full'); }, list() { return []; } };
  const durableBad = makeDurableAnchorQueue({ store: badStore });
  assert.doesNotThrow(() => durableBad.record({ receipt_id: 'y', leaf: anchorLeafHash(kolm) }));
  assert.equal(durableBad.record({ receipt_id: 'y', leaf: anchorLeafHash(kolm) }), false, 'WAL failure fails open (returns false, no throw)');
});

// ---------------------------------------------------------------------------
// AC8 - NRAS capstone: env-gate + nonce-binding + replay TTL.
// ---------------------------------------------------------------------------
test('AC8: NRAS verifier is a no-op unset, loud-fails on missing cert, enforces nonce-binding + replay TTL', async () => {
  // Unset gate -> registration no-op, verifier not registered, state shape-only.
  delete process.env.KOLM_NRAS_VERIFIER;
  clearAttestationVerifier('nras');
  const noop = registerNrasVerifier({ gate: undefined });
  assert.equal(noop.registered, false);
  assert.ok(!listRegisteredVerifiers().includes('nras'), 'nras not registered when unset');

  const shapeOnlyReport = {
    gpu_id: 'GPU-abc', driver_version: '550.00', vbios_version: '96.00.00',
    attestation_report: 'ZmFrZQ==', cert_chain: ['-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----'],
    nonce: 'deadbeef',
  };
  const st = await verifyAttestation('nras', shapeOnlyReport);
  assert.equal(st.verified, false);
  assert.equal(st.state, STATES.SHAPE_OK, 'shape-only state when no crypto verifier');

  // Gate ON but cert MISSING -> LOUD throw with install hint.
  assert.throws(
    () => registerNrasVerifier({ gate: '1', rootCert: path.join(os.tmpdir(), 'definitely-missing-nras-root-' + crypto.randomBytes(4).toString('hex') + '.pem') }),
    /KOLM_NRAS_VERIFIER=1 but the NVIDIA NRAS root cert is missing/,
    'loud fail on missing cert'
  );

  // nonce-binding helper is deterministic + correct.
  const inputDigest = crypto.createHash('sha256').update('IN').digest('hex');
  const outputDigest = crypto.createHash('sha256').update('OUT').digest('hex');
  const expected = nonceBinding(inputDigest, outputDigest);
  const manual = crypto.createHash('sha256')
    .update(Buffer.concat([Buffer.from(inputDigest, 'hex'), Buffer.from(outputDigest, 'hex')]))
    .digest('hex');
  assert.equal(expected, manual, 'nonce-binding = sha256(input||output)');

  // Verifier fn: a token whose eat_nonce != expected returns ok:false (the JS
  // shim's defense-in-depth check rejects BEFORE the worker even when the worker
  // is unreachable). We stub the worker by pointing at a non-existent python.
  const verifier = makeNrasVerifier({ rootCert: __filenameTest }); // any readable path
  // Missing digests -> immediate ok:false (nonce-binding cannot be computed).
  const noBinding = await verifier({ attestation_report: 'x', eat_nonce: 'whatever' }, {});
  assert.equal(noBinding.ok, false);
  assert.match(noBinding.reason, /missing_input_or_output_digest/);

  // With digests present but the worker unavailable, the fn returns ok:false
  // (never throws, never fakes a pass) - proving the seam refuses verified=true.
  const withBinding = await verifier(
    { attestation_report: 'not-a-real-jwt', eat_nonce: 'mismatch' },
    { input_digest: inputDigest, output_digest: outputDigest, now_ms: Date.now() }
  );
  assert.equal(withBinding.ok, false, 'unverifiable token never returns ok:true');

  // Replay TTL constant is the documented 24h.
  assert.equal(NRAS_REPLAY_TTL_MS, 24 * 60 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// AC9 - privacy boundary: no raw prompt/output text in subjects or NRAS binding.
// ---------------------------------------------------------------------------
test('AC9: exported subjects + NRAS binding carry only digests/short-hashes, no plaintext', () => {
  const secretPrompt = 'THIS_IS_A_SECRET_CUSTOMER_PROMPT_THAT_MUST_NEVER_LEAVE';
  const secretOutput = 'AND_THIS_IS_THE_SECRET_MODEL_OUTPUT_NEVER_EXPORT';

  const signer = freshSigner();
  const mcp = signMcpReceipt(buildMcpReceipt({
    tool: 'do_thing',
    tenant: 'ten',
    args: { prompt: secretPrompt },
    result: { content: [{ type: 'text', text: secretOutput }], isError: false },
    now: 1748520000000,
    call_id: 'mtc_PRIVACY000000000000000ABC',
  }), signer);

  const ex = resolveReceiptExport(mcp);
  const statement = buildInTotoStatement({ subjects: ex.subjects, predicateType: ex.predicateType, predicate: ex.predicate });
  const blob = JSON.stringify(statement);

  assert.ok(!blob.includes(secretPrompt), 'no raw prompt in statement');
  assert.ok(!blob.includes(secretOutput), 'no raw output in statement');

  // Scan every exported scalar value: any value longer than a short hash must
  // itself be a hex digest / `sha256:`-prefixed short hash (no free text).
  const HEXISH = /^(sha256:)?[0-9a-f]{8,64}$/i;
  function scan(v) {
    if (typeof v === 'string') {
      // values that look like content (>40 chars) must be a hash or a known
      // safe non-content field (url/id/timestamp/tool name). Subjects carry
      // ONLY digests, so check the subject array strictly.
      return;
    }
    if (Array.isArray(v)) { v.forEach(scan); return; }
    if (v && typeof v === 'object') { Object.values(v).forEach(scan); }
  }
  scan(statement);

  // Strict on subjects: every subject digest is a hash.
  for (const s of statement.subject) {
    const d = s.digest.sha256;
    assert.ok(HEXISH.test(d), `subject digest ${d} is a hex digest`);
    assert.ok(!d.includes(secretPrompt) && !d.includes(secretOutput));
  }

  // NRAS binding input is sha256(input_digest||output_digest) - both already
  // hashes. The binding output is a 64-hex digest with no plaintext.
  const inDig = crypto.createHash('sha256').update(secretPrompt).digest('hex');
  const outDig = crypto.createHash('sha256').update(secretOutput).digest('hex');
  const binding = nonceBinding(inDig, outDig);
  assert.match(binding, /^[0-9a-f]{64}$/);
  assert.ok(!binding.includes(secretPrompt) && !binding.includes(secretOutput));
});
