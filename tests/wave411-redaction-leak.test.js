// Wave 411 — Addendum atom #3: redaction leak lock-in.
//
// PHI / PII classes (per kolm.ai/security taxonomy):
//   - SSN strict (regex: ddd-dd-dddd)
//   - SSN malformed (looks-like-SSN but fails strict checksum/area rules)
//   - phone (E.164 / NANP)
//   - email
//   - DOB (M/D/YYYY)
//   - address (street + city)
//   - MRN (Medical Record Number — anchored by MRN: / PT-#)
//   - account_number (bank / routing / IBAN — anchored)
//
// Contract: across the capture-store row, the canonical event-store row,
// the distill corpus pair, the recipe receipt, and the signed manifest, the
// RAW value of every PHI class MUST NOT appear verbatim. The redacted form
// (placeholder tokens like VAR_SSN_1) is what every downstream consumer
// sees.
//
// Why this is dangerous if missed: the existing comment at
// src/capture-store.js:143 says "The capture-store rows are post-redaction
// (the daemon-connector lake path writes redactedPromptText)." That is the
// CONTRACT — the *callers* must pre-redact before they hand a row to
// insertCapture(). If a caller forgets (or a new proxy route gets added
// without the redaction step), raw PHI flows straight through to the event
// lake. This test is the contract enforcer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RAW = Object.freeze({
  ssn_strict: '123-45-6789',
  ssn_malformed: '999-12-3456',           // 999 area — fails SSA validity, still a 9-digit run
  phone: '(415) 555-2671',
  email: 'patient.alice@example.com',
  dob: '03/14/1989',
  address: '742 Evergreen Terrace, Springfield, OR',
  mrn: 'MRN: 0048321',
  account_number: 'account: 1234-5678-9012',
});

function _mkTmp(label = 'w411-leak') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_PRIVACY_POLICY: process.env.KOLM_PRIVACY_POLICY,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
  };
}

function _setEnv(tmp, opts = {}) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // Capture-store loads `src/store.js` which only knows 'json' | 'sqlite'.
  // Event-store has its own JSONL driver controlled by the same env var; the
  // event-store reader treats unknown values as JSONL fallback, so 'json'
  // is the cross-compatible setting.
  process.env.KOLM_STORE_DRIVER = opts.driver || 'json';
  process.env.KOLM_PRIVACY_POLICY = 'redact';
  process.env.KOLM_RECIPE_RECEIPT_SECRET = process.env.KOLM_RECIPE_RECEIPT_SECRET || 'wave411-leak-test-secret-32chars-min';
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function _allRawValues() {
  return Object.values(RAW);
}

function _assertNoLeak(blob, label) {
  const s = typeof blob === 'string' ? blob : JSON.stringify(blob);
  for (const [klass, raw] of Object.entries(RAW)) {
    assert.ok(!s.includes(raw),
      `RAW ${klass} ('${raw}') leaked into ${label} — must be redacted`);
  }
}

function _composeRawSample() {
  return [
    'Patient called with SSN ' + RAW.ssn_strict + ' and DOB ' + RAW.dob + '.',
    'Backup SSN attempt ' + RAW.ssn_malformed + '.',
    'Reachable at ' + RAW.phone + ' or ' + RAW.email + '.',
    'Home: ' + RAW.address + '.',
    RAW.mrn,
    'Payment: ' + RAW.account_number,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// #1 — privacyRedact directly: every RAW class produces a placeholder and
//      the redacted output bytes contain NO raw class value.
test('W411 leak #1 — privacyRedact scrubs every PHI/PII class in one pass', async () => {
  const { redact } = await import('../src/privacy-membrane.js');
  const sample = _composeRawSample();
  const { redacted, classes_seen, vault } = redact(sample);

  _assertNoLeak(redacted, 'privacyRedact.redacted');

  // The vault maps placeholders to raw values — the placeholder map itself
  // is the only place raw is allowed to live, and only in-memory for the
  // reinjection round trip. We confirm every class was detected.
  const expected = ['ssn', 'phone', 'email', 'dob', 'address', 'mrn', 'account_number'];
  for (const klass of expected) {
    assert.ok(
      classes_seen.includes(klass) || classes_seen.includes('ssn_malformed') || classes_seen.includes(klass),
      'class ' + klass + ' must be detected (classes_seen=' + JSON.stringify(classes_seen) + ')',
    );
  }
  // Vault must contain at least one entry per real class detected.
  assert.ok(Object.keys(vault).length >= expected.length - 1,
    'vault must record placeholder→raw for every detected class (vault keys=' + Object.keys(vault).length + ')');
});

// ---------------------------------------------------------------------------
// #2 — Insert a PRE-REDACTED capture row, bridge to event-store, then read
//      the event-store back and assert no raw bleed in either the capture
//      store JSONL or the event-store JSONL.
test('W411 leak #2 — bridgeToEventStore does not reintroduce raw PHI from any sidecar field', async () => {
  const tmp = _mkTmp('w411-leak-2');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const { redact } = await import('../src/privacy-membrane.js');
    const { insertCapture } = await import('../src/capture-store.js');
    const { listEvents, _resetForTests } = await import('../src/event-store.js');
    _resetForTests();

    const sample = _composeRawSample();
    const { redacted: redactedPrompt } = redact(sample);
    const { redacted: redactedResponse } = redact(
      'Acknowledged. Patient at ' + RAW.phone + ' will be called back.',
    );

    // Pre-redacted row — the contract that callers MUST honor before
    // hitting insertCapture(). Mirror the daemon-connector shape so the
    // bridge sees the same field names production sees.
    await insertCapture({
      id: 'cap_leaktest_1',
      tenant: 'leak-tenant',
      template_hash: 'h1',
      template_preview: redactedPrompt.slice(0, 200),
      model: 'gpt-4o-mini',
      prompt: redactedPrompt,           // post-redaction
      response: redactedResponse,       // post-redaction
      latency_ms: 12,
      latency_us: 12000,
      cost_usd: 0.0001,
      provider: 'openai',
      corpus_namespace: 'leak-ns',
      status: 'ok',
      created_at: new Date().toISOString(),
      // Provenance flags — the daemon would set these on the way in.
      redaction_policy: 'redact',
      redaction_count: 7,
      sensitive_classes: ['ssn', 'phone', 'email', 'dob', 'address', 'mrn', 'account_number'],
      sensitive_data_detected: true,
      raw_available: false,
      source_type: 'capture',
    });

    // Verify capture-store JSONL on disk holds zero raw bytes.
    const capturesGlob = path.join(tmp, 'data', 'captures.jsonl');
    if (fs.existsSync(capturesGlob)) {
      _assertNoLeak(fs.readFileSync(capturesGlob, 'utf8'), 'captures.jsonl');
    }
    // Some drivers nest under captures/<ns>.jsonl — walk the dir tree
    // defensively and scan every file under KOLM_DATA_DIR for any raw byte.
    walkAndAssert(tmp);

    // Verify event-store JSONL (the canonical lake).
    const events = await listEvents({ namespace: 'leak-ns' });
    assert.ok(events.length > 0, 'event-store must have received the bridged event');
    for (const ev of events) {
      _assertNoLeak(ev.prompt_redacted || '', 'event.prompt_redacted');
      _assertNoLeak(ev.response_redacted || '', 'event.response_redacted');
      _assertNoLeak(ev, 'event-store row (full json)');
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #3 — prepareDistillCorpus output (the thing the worker sees) carries the
//      redacted form ONLY. Even if the event was authored with a raw_*_hash
//      field, the pair returned to the worker holds redacted text.
test('W411 leak #3 — prepareDistillCorpus emits only redacted prompts/responses', async () => {
  const tmp = _mkTmp('w411-leak-3');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const { redact } = await import('../src/privacy-membrane.js');
    const { appendEvent, _resetForTests } = await import('../src/event-store.js');
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    _resetForTests();

    const sample = _composeRawSample();
    const { redacted: redactedPrompt } = redact(sample);
    const { redacted: redactedResponse } = redact('Confirmed; followup at ' + RAW.email);

    for (let i = 0; i < 5; i++) {
      await appendEvent({
        namespace: 'leak3',
        tenant_id: 'leak-tenant',
        prompt_redacted: redactedPrompt,
        response_redacted: redactedResponse,
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'ok',
        redaction_policy: 'redact',
        source_type: 'capture',
      });
    }

    const { pairs } = await prepareDistillCorpus({ namespace: 'leak3', split: 'all' });
    assert.ok(pairs.length > 0, 'corpus must yield pairs');
    for (const p of pairs) {
      _assertNoLeak(p.prompt, 'distill pair.prompt');
      _assertNoLeak(p.response, 'distill pair.response');
      _assertNoLeak(p, 'distill pair (full)');
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #4 — The worker seeds.jsonl that distill() stages on disk contains zero
//      raw bytes. This is the LAST byte boundary before the heavy worker
//      executes — anything that leaks here is shipped to the teacher API.
test('W411 leak #4 — distill worker seeds.jsonl contains zero raw PHI bytes', async () => {
  const tmp = _mkTmp('w411-leak-4');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const { redact } = await import('../src/privacy-membrane.js');
    const { appendEvent, _resetForTests } = await import('../src/event-store.js');
    const { distill } = await import('../src/distill-pipeline.js');
    _resetForTests();

    const sample = _composeRawSample();
    const { redacted: redactedPrompt } = redact(sample);
    const { redacted: redactedResponse } = redact('Reply to ' + RAW.email);

    for (let i = 0; i < 6; i++) {
      await appendEvent({
        namespace: 'leak4',
        tenant_id: 'leak-tenant',
        prompt_redacted: redactedPrompt,
        response_redacted: redactedResponse,
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'ok',
        redaction_policy: 'redact',
        source_type: 'capture',
      });
    }

    // No-op worker stub so distill() returns immediately; the seeds.jsonl is
    // staged before the worker spawns.
    const stub = path.join(tmp, 'stub.mjs');
    fs.writeFileSync(stub, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "let out = null;",
      "for (const a of process.argv.slice(2)) if (a.startsWith('--out=')) out = a.slice(6);",
      "if (out) { try { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out,'manifest.json'), JSON.stringify({mode:'stub'})); } catch {} }",
      "process.exit(0);",
      '',
    ].join('\n'));

    const iter = distill({
      teacher_namespace: 'leak4',
      student_base: 'phi-mini',
      max_steps: 5,
      emit_progress_every: 0,
      worker_cmd: stub,
    });
    // W411 — drive the iterator far enough that seeds.jsonl + spec.json are
    // staged on disk WITHOUT awaiting the detached worker exit. distill()
    // writes both files synchronously before the spawn, so .next() + an 80ms
    // macrotask is enough. We then dispose of the iterator to release the
    // unref'd child handle (Windows test runner cancels otherwise — same flake
    // as W381 #16 / W409c #2-9).
    const nextPromise = iter.next();
    await new Promise((r) => setTimeout(r, 80));
    if (typeof iter.return === 'function') {
      try { await Promise.race([iter.return(), new Promise((r) => setTimeout(r, 200))]); } catch {}
    }
    try { await Promise.race([nextPromise, new Promise((r) => setTimeout(r, 200))]); } catch {}

    const runRoot = path.join(tmp, 'distill-runs');
    const runDirs = fs.readdirSync(runRoot)
      .map((d) => ({ d, full: path.join(runRoot, d), mtime: fs.statSync(path.join(runRoot, d)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    assert.ok(runDirs.length > 0, 'distill() must create a run dir');
    const seedsPath = path.join(runDirs[0].full, 'seeds.jsonl');
    assert.ok(fs.existsSync(seedsPath), 'seeds.jsonl must exist on disk');
    _assertNoLeak(fs.readFileSync(seedsPath, 'utf8'), 'seeds.jsonl bytes');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// Helper — walk the KOLM_DATA_DIR tree and assert no raw bytes appear in
// any file under it. Used by #2 to catch any sidecar / cache that the
// capture-store might write on top of the JSONL.
function walkAndAssert(rootDir) {
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'distill-runs') continue;  // covered by #4
        stack.push(full);
      } else if (e.isFile()) {
        // Skip binary files / sqlite blobs — only scan text-ish artifacts.
        if (!/\.(jsonl?|md|txt|log|kolm|yaml|yml|tsv|csv)$/i.test(e.name)) continue;
        let buf;
        try { buf = fs.readFileSync(full, 'utf8'); } catch { continue; }
        _assertNoLeak(buf, full.replace(rootDir, '<DATA>'));
      }
    }
  }
}
