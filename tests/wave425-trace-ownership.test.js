// Wave 425 — Trace capture + workflow trace tenant ownership lock-in.
//
// Audit item P1-1 from .agent/docs/w415-outstanding-diffs-from-prior-feedback-2026-05-19.md
// flagged that src/trace-capture.js, src/compile-ir.js, and the /v1/trace/*
// + /v1/ir/compile routes are authenticated but do NOT verify tenant
// ownership. Any authenticated user holding (or guessing) a trace_id could
// read, export, or compile another tenant's workflow trace.
//
// W425 closes the gap by:
//   (a) stamping tenant_id on every appended span and refusing cross-tenant
//       writes to an already-owned trace,
//   (b) accepting a tenant_id filter on readTrace/chain/stats that returns
//       empty / tenant_mismatch for foreign-tenant traces,
//   (c) propagating tenant_id through compileIr.traceToIr/tracesToIr and
//       stamping it on the resulting IR,
//   (d) requiring req.tenant_record on /v1/trace/* and /v1/ir/compile and
//       passing req.tenant_record.id down into the helpers.
//
// Tests assert BEHAVIOR (HTTP, file contents, function returns) — not page
// copy. Per-test tmpdirs isolate KOLM_HOME / data so the dev box's real
// ~/.kolm is never touched. Run with --test-concurrency=1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function _mkTmp(label = 'w425t') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_HOME: process.env.KOLM_HOME,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
    KOLM_DISABLE_RATE_LIMIT: process.env.KOLM_DISABLE_RATE_LIMIT,
    KOLM_DB_PATH: process.env.KOLM_DB_PATH,
    DEFAULT_TENANT: process.env.DEFAULT_TENANT,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
  };
}

function _setEnv(tmp) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = tmp;
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_RECIPE_RECEIPT_SECRET = 'wave425-trace-ownership-secret-32+chars';
  process.env.KOLM_DB_PATH = path.join(tmp, 'kolm.sqlite');
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

// ---------------------------------------------------------------------------
// #1 STATIC SOURCE — trace-capture appendSpan stamps tenant_id from caller
// ---------------------------------------------------------------------------
test('W425 #1 (static-source) — trace-capture appendSpan stamps tenant_id', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'trace-capture.js'), 'utf8'
  );
  // The append path must read tenant_id from the incoming span.
  assert.ok(/span\.tenant_id/.test(src),
    'appendSpan must reference span.tenant_id');
  // The enriched record persisted to the jsonl must include tenant_id.
  assert.ok(/tenant_id:\s*(effective_tenant_id|.*tenant)/.test(src),
    'enriched span record must persist a tenant_id field');
  // A cross-tenant write to an already-owned trace must throw.
  assert.ok(/tenant_id mismatch/.test(src),
    'appendSpan must refuse cross-tenant writes with a tenant_id mismatch error');
});

// ---------------------------------------------------------------------------
// #2 STATIC SOURCE — readTrace/chain/stats accept tenant_id and filter
// ---------------------------------------------------------------------------
test('W425 #2 (static-source) — readTrace/chain/stats accept tenant_id filter', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'trace-capture.js'), 'utf8'
  );
  // Each read API must accept tenant_id with a null default.
  assert.ok(/readTrace\(trace_id,\s*tenant_id\s*=\s*null\)/.test(src),
    'readTrace must accept tenant_id with null default');
  assert.ok(/chain\(trace_id,\s*tenant_id\s*=\s*null\)/.test(src),
    'chain must accept tenant_id with null default');
  assert.ok(/stats\(trace_id,\s*tenant_id\s*=\s*null\)/.test(src),
    'stats must accept tenant_id with null default');
  // The filter must surface tenant_mismatch downstream.
  assert.ok(/tenant_mismatch/.test(src),
    'tenant_mismatch reason must be reachable in the read path');
});

// ---------------------------------------------------------------------------
// #3 STATIC SOURCE — compile-ir handles tenant_id
// ---------------------------------------------------------------------------
test('W425 #3 (static-source) — compile-ir traceToIr handles tenant_id', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'compile-ir.js'), 'utf8'
  );
  // traceToIr must thread tenant_id from opts into readTrace.
  assert.ok(/opts\.tenant_id/.test(src),
    'traceToIr must read tenant_id from opts');
  assert.ok(/readTrace\(trace_id,\s*tenant_id\)/.test(src),
    'traceToIr must pass tenant_id into traceCapture.readTrace');
  // Cross-tenant compile attempts must throw a tenant_mismatch error.
  assert.ok(/tenant_mismatch/.test(src),
    'compile-ir must raise tenant_mismatch on cross-tenant access');
  // The IR returned must carry the tenant_id stamp.
  assert.ok(/ir\.tenant_id\s*=\s*tenant_id/.test(src),
    'compile-ir must stamp tenant_id on the emitted IR');
});

// ---------------------------------------------------------------------------
// #4 STATIC SOURCE — router gates trace + ir routes on req.tenant_record
// ---------------------------------------------------------------------------
test('W425 #4 (static-source) — router /v1/trace/* + /v1/ir/compile gate on req.tenant_record', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'router.js'), 'utf8'
  );
  // Find the trace + ir-compile block (roughly 6960-7030 in current tree).
  const idxBegin = src.indexOf("// ----- trace -----");
  const idxEnd   = src.indexOf("r.post('/v1/ir/stats'");
  assert.ok(idxBegin > 0 && idxEnd > idxBegin,
    'trace + ir-compile block must be findable in router.js');
  const block = src.slice(idxBegin, idxEnd);

  // All four trace routes + ir/compile must require req.tenant_record and
  // emit the auth-required envelope.
  const gateRegex = /if\s*\(\s*!req\.tenant_record\s*\)\s*return\s+res\.status\(401\)\.json\(\{\s*ok:\s*false,\s*error:\s*'auth required'\s*\}\)/g;
  const gates = block.match(gateRegex) || [];
  assert.ok(gates.length >= 5,
    `expected >=5 tenant_record gates (stats, chain, export, append, ir/compile), got ${gates.length}`);

  // Helper calls must thread req.tenant_record.id down into trace-capture.
  assert.ok(/traceCapture\.stats\(tid,\s*req\.tenant_record\.id\)/.test(block),
    'stats route must pass req.tenant_record.id to traceCapture.stats');
  assert.ok(/traceCapture\.chain\(tid,\s*req\.tenant_record\.id\)/.test(block),
    'chain route must pass req.tenant_record.id to traceCapture.chain');
  assert.ok(/traceCapture\.readTrace\(tid,\s*req\.tenant_record\.id\)/.test(block),
    'export route must pass req.tenant_record.id to traceCapture.readTrace');
  // append must force the span.tenant_id binding, not trust the body.
  assert.ok(/span\.tenant_id\s*=\s*req\.tenant_record\.id/.test(block),
    'append route must force span.tenant_id = req.tenant_record.id');
  // ir/compile must build a scopedOpts that includes tenant_id from auth.
  assert.ok(/tenant_id:\s*req\.tenant_record\.id/.test(block),
    'ir/compile route must include tenant_id: req.tenant_record.id in opts');
});

// ---------------------------------------------------------------------------
// #5 BEHAVIOR — 2 tenants write traces; tenant A read returns only A's spans
// ---------------------------------------------------------------------------
test('W425 #5 (behavior) — cross-tenant read returns empty / tenant_mismatch', async (t) => {
  const saved = _snapEnv();
  const tmp = _mkTmp();
  _setEnv(tmp);
  t.after(() => {
    _restoreEnv(saved);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} // deliberate: cleanup
  });

  const traceCapture = await import('../src/trace-capture.js');
  const compileIr = await import('../src/compile-ir.js');

  // Tenant A writes a trace with a USER_INPUT + LLM_CALL pair.
  const traceIdA = traceCapture.newTraceId();
  const spanIdAInput = traceCapture.newSpanId();
  const spanIdALlm = traceCapture.newSpanId();
  await traceCapture.appendSpan({
    ...traceCapture.userInputSpan({
      trace_id: traceIdA,
      span_id: spanIdAInput,
      parent_span_id: null,
      role: 'user',
      text: 'tenant A prompt',
      channel: 'cli',
    }),
    tenant_id: 'tenant_A_w425',
  });
  await traceCapture.appendSpan({
    ...traceCapture.llmCallSpan({
      trace_id: traceIdA,
      span_id: spanIdALlm,
      parent_span_id: spanIdAInput,
      vendor: 'openai',
      model: 'gpt-4o-mini',
      prompt: 'tenant A prompt',
      response: 'tenant A reply',
      tokens_in: 5,
      tokens_out: 5,
      latency_ms: 10,
      cost_usd: 0.0001,
    }),
    tenant_id: 'tenant_A_w425',
  });

  // Tenant B writes a separate trace.
  const traceIdB = traceCapture.newTraceId();
  const spanIdBInput = traceCapture.newSpanId();
  await traceCapture.appendSpan({
    ...traceCapture.userInputSpan({
      trace_id: traceIdB,
      span_id: spanIdBInput,
      parent_span_id: null,
      role: 'user',
      text: 'tenant B prompt',
      channel: 'cli',
    }),
    tenant_id: 'tenant_B_w425',
  });

  // Tenant A reads its own trace — sees both spans, every span tagged with A.
  const aSpansAsA = await traceCapture.readTrace(traceIdA, 'tenant_A_w425');
  assert.equal(aSpansAsA.length, 2,
    'tenant A reading its own trace sees 2 spans');
  for (const s of aSpansAsA) {
    assert.equal(s.tenant_id, 'tenant_A_w425',
      'every span tenant A reads is owned by tenant A');
  }

  // Tenant B reads tenant A's trace — sees [] (cross-tenant fence).
  const aSpansAsB = await traceCapture.readTrace(traceIdA, 'tenant_B_w425');
  assert.deepEqual(aSpansAsB, [],
    'tenant B reading tenant A\'s trace returns empty');

  // Tenant A reads tenant B's trace — also sees [].
  const bSpansAsA = await traceCapture.readTrace(traceIdB, 'tenant_A_w425');
  assert.deepEqual(bSpansAsA, [],
    'tenant A reading tenant B\'s trace returns empty');

  // Unfiltered read sees the underlying spans (parity check, no fence).
  const aSpansRaw = await traceCapture.readTrace(traceIdA);
  assert.equal(aSpansRaw.length, 2,
    'unfiltered readTrace returns all spans');

  // chain() with foreign tenant returns ok=false + reason='tenant_mismatch'.
  const chainBOnA = await traceCapture.chain(traceIdA, 'tenant_B_w425');
  assert.equal(chainBOnA.ok, false,
    'cross-tenant chain check fails');
  assert.equal(chainBOnA.reason, 'tenant_mismatch',
    'cross-tenant chain check carries reason=tenant_mismatch');

  // stats() with foreign tenant returns a zeroed envelope + reason.
  const statsBOnA = await traceCapture.stats(traceIdA, 'tenant_B_w425');
  assert.equal(statsBOnA.total_spans, 0,
    'cross-tenant stats reports zero spans');
  assert.equal(statsBOnA.reason, 'tenant_mismatch',
    'cross-tenant stats carries reason=tenant_mismatch');

  // compile-ir on foreign tenant must throw tenant_mismatch.
  await assert.rejects(
    async () => compileIr.traceToIr(traceIdA, { tenant_id: 'tenant_B_w425' }),
    /tenant_mismatch/,
    'traceToIr must refuse cross-tenant compile with tenant_mismatch'
  );

  // compile-ir on the owning tenant succeeds and the IR carries tenant_id.
  const compiled = await compileIr.traceToIr(traceIdA, { tenant_id: 'tenant_A_w425' });
  assert.ok(compiled && compiled.ir,
    'owning-tenant compile returns an IR');
  assert.equal(compiled.ir.tenant_id, 'tenant_A_w425',
    'IR carries the owning tenant_id stamp');

  // appendSpan refuses cross-tenant write to an already-owned trace.
  await assert.rejects(
    async () => traceCapture.appendSpan({
      ...traceCapture.userInputSpan({
        trace_id: traceIdA,
        span_id: traceCapture.newSpanId(),
        parent_span_id: spanIdAInput,
        role: 'user',
        text: 'attacker injection',
        channel: 'cli',
      }),
      tenant_id: 'tenant_B_w425',
    }),
    /tenant_id mismatch/,
    'appendSpan must refuse cross-tenant write to an owned trace'
  );
});
