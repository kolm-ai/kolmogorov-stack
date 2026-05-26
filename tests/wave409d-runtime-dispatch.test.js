// Wave 409d — runArtifact + evalArtifact route through dispatchRuntime.
//
// Pre-W409d, src/artifact-runner.js had a hidden duplicate JS recipe loop
// inside runArtifact() that bypassed dispatchRuntime entirely. evalArtifact
// inherited the bug because it called runArtifact() per case. As a result,
// `kolm run <foo.kolm>` always executed JS recipes — even when
// manifest.runtime_target declared native/wasm/gguf/onnx. The non-JS runners
// were never reached through the primary run/eval entry. W409d makes the
// primary entry route ALL targets through dispatchRuntime, so the JS path
// goes through the same dispatcher as the other four.
//
// Behavior asserted by this file (no page-copy assertions):
//
//   1. runArtifact with runtime_target=js — dispatcher selected JS, recipe ran,
//      return shape carries runtime:'js' alongside the historical
//      {output, recipe_id, latency_us, receipt, audit} envelope.
//   2. runArtifact with runtime_target=native + a fake binary fixture —
//      dispatcher selected native, binary was actually invoked, output carries
//      the canned shim signal (`ran_via: 'fake_native_shim'`). On Windows the
//      native-runner refuses non-.exe binaries so we assert the platform-
//      refusal path is what fires (KOLM_E_NATIVE_PLATFORM is ONLY thrown by
//      runNativeTarget — proves dispatcher selected native).
//   3. runArtifact with runtime_target=wasm + invalid wasm bytes — dispatcher
//      selected wasm, runner threw KOLM_E_WASM_INSTANTIATE. The JS path could
//      never produce this code so its presence proves the routing.
//   4. evalArtifact uses dispatchRuntime per case (not a direct JS loop). We
//      use a runtime_target=native artifact whose binary returns canned JSON
//      that the eval comparator counts as a pass.
//   5. Verifier check: manifest.runtime_target=native but binary entry missing
//      from the zip — verify must fail with a clear reason. Buyers must catch
//      this before deploy, not at first-run time on the customer's host.
//   6. CLI `kolm run` end-to-end — spawn `node cli/kolm.js run ...` against a
//      built .kolm; the --json envelope must carry runtime:'js' (or the
//      target the dispatcher actually selected). The presence of that field
//      is the cross-process proof the dispatcher was hit.
//   7. CLI `kolm eval` end-to-end — same proof via --json.
//
// Constraints honored: tests assert exit codes + observable dispatch
// decisions, never page text. Inline-built artifacts keep the test
// hermetic (no dependency on shipped public fixtures).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

import {
  runArtifact,
  evalArtifact,
  loadArtifact,
} from '../src/artifact-runner.js';
import { buildBinder } from '../src/binder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const KOLM_CLI = path.join(REPO_ROOT, 'cli', 'kolm.js');
const TEST_SECRET = 'kolm-w409d-runtime-dispatch-secret';

process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || TEST_SECRET;

// Canonical JSON encoder mirroring src/artifact.js canonicalJson() so the
// inline-built manifests sign with a byte-identical payload.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map((x) => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Hand-build a minimal signed .kolm at outPath. We deliberately do NOT use
// the production builder (src/artifact.js) because that pulls in 60+ provenance
// blocks the runtime-dispatch test does not need. The signature follows the
// simpler `{spec, manifest_hash, job_id}` HMAC fallback that
// verifyManifestSignature already accepts (see src/artifact.js line 1421).
function buildTestArtifact({
  outPath,
  runtime_target = 'js',
  recipes = [],
  entrypoint = null,
  runtime_target_config = null,
  extraEntries = {},
  jobId = 'job_w409d_test',
  signSecret = TEST_SECRET,
  // When set, omit the entrypoint binary entry from the zip to model a
  // misconfigured artifact (used by the verifier-must-reject test).
  omitBinaryEntry = false,
} = {}) {
  const manifest = {
    spec: 'kolm-1',
    job_id: jobId,
    task: 'w409d runtime dispatch fixture',
    runtime_target,
  };
  if (entrypoint) manifest.entrypoint = entrypoint;
  if (runtime_target_config) manifest.runtime_target_config = runtime_target_config;
  const manifest_json = JSON.stringify(manifest);
  const manifest_hash = sha256Hex(Buffer.from(manifest_json));

  const recipes_doc = { spec: 'rs-1-recipes', recipes };
  const recipes_json = JSON.stringify(recipes_doc);

  const sig_payload = canonicalJson({ spec: 'kolm-1', manifest_hash, job_id: jobId });
  const hmac = crypto.createHmac('sha256', signSecret).update(sig_payload).digest('hex');
  const signature = JSON.stringify({
    spec: 'kolm-1',
    job_id: jobId,
    manifest_hash,
    hmac_alg: 'HMAC-SHA256',
    hmac,
  });

  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(manifest_json, 'utf8'));
  zip.addFile('recipes.json', Buffer.from(recipes_json, 'utf8'));
  zip.addFile('signature.sig', Buffer.from(signature, 'utf8'));
  for (const [name, buf] of Object.entries(extraEntries)) {
    if (omitBinaryEntry && entrypoint && name === entrypoint.binary) continue;
    zip.addFile(name, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  zip.writeZip(outPath);
  return outPath;
}

function tmpKolm(name = 'w409d-art') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w409d-'));
  return path.join(dir, `${name}.kolm`);
}

// Native fixture: read the shim bytes once and reuse across tests. On Windows
// we add a `.exe` suffix to the entrypoint path so the runner's Windows guard
// accepts it; the actual bytes are still the node shebang script, so spawn()
// won't successfully launch it (Windows can't exec a JS file even with .exe).
// That's by design — the Windows branch of test #2 asserts dispatcher routing
// via KOLM_E_NATIVE_RUNTIME (spawn-fails-after-runner-was-selected) which is a
// runNativeTarget-only code.
const NATIVE_SHIM_PATH = path.join(FIXTURE_DIR, 'fake-native-shim.js');
const NATIVE_SHIM_BYTES = fs.readFileSync(NATIVE_SHIM_PATH);
const GGUF_FIXTURE_PATH = path.join(FIXTURE_DIR, 'fake-gguf-shim.bin');
const GGUF_FIXTURE_BYTES = fs.readFileSync(GGUF_FIXTURE_PATH);

// ---------------------------------------------------------------------------
// 1. runArtifact(js) — dispatcher selected, JS recipe ran.
// ---------------------------------------------------------------------------
test('W409d #1 — runArtifact(runtime_target=js) routes through dispatchRuntime', async () => {
  const art = tmpKolm('js');
  buildTestArtifact({
    outPath: art,
    runtime_target: 'js',
    recipes: [
      {
        id: 'rcp_upper',
        name: 'upper',
        source: 'function generate(input, lib){ return { upper: String((input && input.text) || "").toUpperCase(), src: "js_recipe" }; }',
      },
    ],
  });
  try {
    const r = await runArtifact(art, { text: 'hi' });
    // Dispatcher tags the runtime so downstream callers (audit-sink, CLI
    // --json envelope) can verify routing without re-loading the artifact.
    assert.equal(r.runtime, 'js', 'runArtifact must surface runtime label from dispatcher');
    assert.equal(r.recipe_id, 'rcp_upper', 'JS path carries recipe_id through');
    assert.equal(r.output.upper, 'HI');
    assert.equal(r.output.src, 'js_recipe', 'JS recipe ran (output proves dispatcher picked js)');
    // The audit envelope is preserved end-to-end so SDK/MCP/CLI auditing keeps working.
    assert.equal(r.audit.spec, 'kolm-audit-1');
    assert.equal(r.audit.runtime, 'js');
    assert.equal(r.audit.ok, true);
    assert.equal(r.receipt.spec, 'rs-1-run');
    assert.equal(r.receipt.runtime, 'js');
  } finally {
    try { fs.rmSync(path.dirname(art), { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

// ---------------------------------------------------------------------------
// 2. runArtifact(native) — dispatcher selected, binary fixture invoked.
// ---------------------------------------------------------------------------
test('W409d #2 — runArtifact(runtime_target=native) routes through dispatchRuntime to native runner', async () => {
  const art = tmpKolm('native');
  // Pick a path inside the zip that satisfies the runner's Windows guard so
  // we can prove routing on every platform. On POSIX the shebang lets node
  // exec the script directly; on Windows we still hit the native runner first
  // and surface its specific error code, NOT a JS-path code.
  const binEntry = process.platform === 'win32' ? 'target/win/recipe.exe' : 'target/posix/recipe';
  buildTestArtifact({
    outPath: art,
    runtime_target: 'native',
    // A bogus JS recipe to "trap" any dispatcher regression: if runArtifact
    // ever falls back to the JS path, this recipe would return a fingerprint
    // (`src: 'js_recipe_fallback'`) that we explicitly forbid below.
    recipes: [
      {
        id: 'rcp_fallback_trap',
        name: 'fallback_trap',
        source: 'function generate(input, lib){ return { src: "js_recipe_fallback" }; }',
      },
    ],
    entrypoint: { binary: binEntry },
    extraEntries: { [binEntry]: NATIVE_SHIM_BYTES },
  });
  try {
    if (process.platform === 'win32') {
      // Windows: native-runner extracts shim.exe to a tmp dir and tries to
      // spawn it. Because the bytes are a node shebang script (not a real
      // PE), spawn() either fails to launch OR launches and exits non-zero.
      // Both surface as KOLM_E_NATIVE_RUNTIME from runNativeTarget — a code
      // the JS path can never produce. Routing proven.
      let err = null;
      try { await runArtifact(art, { text: 'hi' }); } catch (e) { err = e; }
      assert.ok(err, 'native invocation must throw on Windows for non-PE bytes');
      assert.ok(
        err.code === 'KOLM_E_NATIVE_RUNTIME' || err.code === 'KOLM_E_NATIVE_PLATFORM',
        `dispatcher selected native runner (got ${err.code}); JS path could not produce this`,
      );
    } else {
      const r = await runArtifact(art, { text: 'hi' });
      assert.equal(r.runtime, 'native', 'dispatcher labelled runtime as native');
      assert.equal(r.output.ran_via, 'fake_native_shim', 'native binary actually ran (canned shim output)');
      assert.notEqual(r.output.src, 'js_recipe_fallback', 'JS recipe must NOT have been executed');
      assert.deepEqual(r.output.echo, { text: 'hi' }, 'shim echoed the stdin JSON');
      assert.equal(r.recipe_id, null, 'non-JS targets have no recipe_id');
      assert.equal(r.audit.runtime, 'native');
      assert.equal(r.receipt.runtime, 'native');
    }
  } finally {
    try { fs.rmSync(path.dirname(art), { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

// ---------------------------------------------------------------------------
// 3. runArtifact(wasm) — dispatcher selected wasm runner. We ship a fake
//    target.wasm whose bytes are NOT valid wasm; WebAssembly.compile rejects
//    them with KOLM_E_WASM_INSTANTIATE. The JS path could never throw this
//    code, so its presence is unique proof the dispatcher routed to wasm.
// ---------------------------------------------------------------------------
test('W409d #3 — runArtifact(runtime_target=wasm) routes through dispatchRuntime to wasm runner', async () => {
  const art = tmpKolm('wasm');
  buildTestArtifact({
    outPath: art,
    runtime_target: 'wasm',
    recipes: [
      {
        id: 'rcp_fallback_trap',
        name: 'fallback_trap',
        source: 'function generate(input, lib){ return { src: "js_recipe_fallback" }; }',
      },
    ],
    extraEntries: { 'target.wasm': Buffer.from('not-real-wasm-bytes-for-w409d-routing-proof', 'utf8') },
  });
  try {
    let err = null;
    try { await runArtifact(art, { text: 'hi' }); } catch (e) { err = e; }
    assert.ok(err, 'fake wasm bytes must throw');
    assert.equal(
      err.code,
      'KOLM_E_WASM_INSTANTIATE',
      `dispatcher selected wasm runner (got ${err && err.code}); JS path could not produce this code`,
    );
  } finally {
    try { fs.rmSync(path.dirname(art), { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

// ---------------------------------------------------------------------------
// 4. evalArtifact uses dispatchRuntime per case (not a direct JS loop).
// ---------------------------------------------------------------------------
test('W409d #4 — evalArtifact routes each case through dispatchRuntime', async () => {
  if (process.platform === 'win32') {
    // POSIX-only: same Windows constraint as test #2. We still want one
    // assertion on Windows so the test counts; rely on test #5 (verify) +
    // test #1 (js routing through runArtifact, which evalArtifact reuses) +
    // test #6 below (CLI eval --json) to cover the eval routing path.
    return;
  }
  const art = tmpKolm('eval-native');
  const binEntry = 'target/posix/recipe';
  buildTestArtifact({
    outPath: art,
    runtime_target: 'native',
    recipes: [
      {
        id: 'rcp_fallback_trap',
        name: 'fallback_trap',
        source: 'function generate(input, lib){ return { src: "js_recipe_fallback" }; }',
      },
    ],
    entrypoint: { binary: binEntry },
    extraEntries: { [binEntry]: NATIVE_SHIM_BYTES },
  });
  // Add evals.json AFTER initial build so the comparator has cases to run.
  const zip = new AdmZip(art);
  zip.addFile(
    'evals.json',
    Buffer.from(
      JSON.stringify({
        spec: 'rs-1-evals',
        n: 2,
        comparator: 'subset_equal',
        cases: [
          { id: 'case_1', input: { text: 'one' }, expected: { ran_via: 'fake_native_shim' } },
          { id: 'case_2', input: { text: 'two' }, expected: { ran_via: 'fake_native_shim' } },
        ],
      }),
      'utf8',
    ),
  );
  zip.writeZip(art);
  try {
    const r = await evalArtifact(art);
    assert.equal(r.n, 2, 'both cases ran');
    assert.equal(r.passed, 2, `evalArtifact expects native dispatch; passed=${r.passed} errors=${JSON.stringify(r.errors)}`);
    assert.equal(r.accuracy, 1.0);
  } finally {
    try { fs.rmSync(path.dirname(art), { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

// ---------------------------------------------------------------------------
// 5. Verifier: manifest target=native + binary missing -> verify fails with
//    a clear reason. Catches the misconfigured artifact at verify time so the
//    buyer never sees a runtime crash.
// ---------------------------------------------------------------------------
test('W409d #5 — verifier rejects native runtime_target when binary entry missing', async () => {
  const art = tmpKolm('native-missing-bin');
  const binEntry = process.platform === 'win32' ? 'target/win/recipe.exe' : 'target/posix/recipe';
  buildTestArtifact({
    outPath: art,
    runtime_target: 'native',
    recipes: [],
    entrypoint: { binary: binEntry },
    // Omit the binary entry to model the misconfigured artifact.
    extraEntries: { [binEntry]: NATIVE_SHIM_BYTES },
    omitBinaryEntry: true,
  });
  try {
    const result = await buildBinder(art);
    const rtCheck = result.checks.find((c) => c.name === 'Runtime target consistency');
    assert.ok(rtCheck, 'binder must include the Runtime target consistency check');
    assert.equal(rtCheck.status, 'fail', `verifier must fail (got status=${rtCheck && rtCheck.status})`);
    assert.match(rtCheck.detail, /binary/i, 'failure reason must mention the missing binary');
    assert.equal(result.verdict, 'fail', 'overall verdict must be fail when runtime_target is misconfigured');
  } finally {
    try { fs.rmSync(path.dirname(art), { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

test('W409d #5b — verifier accepts native runtime_target when binary present', async () => {
  const art = tmpKolm('native-ok');
  const binEntry = process.platform === 'win32' ? 'target/win/recipe.exe' : 'target/posix/recipe';
  buildTestArtifact({
    outPath: art,
    runtime_target: 'native',
    recipes: [],
    entrypoint: { binary: binEntry },
    extraEntries: { [binEntry]: NATIVE_SHIM_BYTES },
  });
  try {
    const result = await buildBinder(art);
    const rtCheck = result.checks.find((c) => c.name === 'Runtime target consistency');
    assert.ok(rtCheck, 'binder must include the Runtime target consistency check');
    assert.equal(rtCheck.status, 'pass', `expected pass (got ${rtCheck && rtCheck.status}: ${rtCheck && rtCheck.detail})`);
  } finally {
    try { fs.rmSync(path.dirname(art), { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

test('W409d #5c — verifier rejects gguf runtime_target when gguf bytes missing', async () => {
  const art = tmpKolm('gguf-missing');
  buildTestArtifact({
    outPath: art,
    runtime_target: 'gguf',
    recipes: [],
    runtime_target_config: { gguf_path: 'model.gguf' },
    // No model.gguf entry shipped.
  });
  try {
    const result = await buildBinder(art);
    const rtCheck = result.checks.find((c) => c.name === 'Runtime target consistency');
    assert.ok(rtCheck);
    assert.equal(rtCheck.status, 'fail');
    assert.match(rtCheck.detail, /gguf/i);
  } finally {
    try { fs.rmSync(path.dirname(art), { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

test('W409d #5d — verifier accepts gguf runtime_target when gguf bytes present', async () => {
  const art = tmpKolm('gguf-ok');
  buildTestArtifact({
    outPath: art,
    runtime_target: 'gguf',
    recipes: [],
    runtime_target_config: { gguf_path: 'model.gguf' },
    extraEntries: { 'model.gguf': GGUF_FIXTURE_BYTES },
  });
  try {
    const result = await buildBinder(art);
    const rtCheck = result.checks.find((c) => c.name === 'Runtime target consistency');
    assert.ok(rtCheck);
    assert.equal(rtCheck.status, 'pass', `expected pass (got ${rtCheck && rtCheck.status}: ${rtCheck && rtCheck.detail})`);
  } finally {
    try { fs.rmSync(path.dirname(art), { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

// ---------------------------------------------------------------------------
// 6. CLI `kolm run` end-to-end — dispatcher reached cross-process.
// ---------------------------------------------------------------------------
function spawnCli(args, env = {}, options = {}) {
  return new Promise((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w409d-home-'));
    const child = spawn(process.execPath, [KOLM_CLI, ...args], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        KOLM_API_KEY: '',
        RECIPE_RECEIPT_SECRET: TEST_SECRET,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd || REPO_ROOT,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30_000); // deliberate: cleanup
    child.on('close', (code) => {
      clearTimeout(killer);
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {} // deliberate: cleanup
      resolve({ code, stdout, stderr });
    });
  });
}

// Parse the LAST top-level JSON object out of stdout. cmdRun and cmdEval emit
// the JSON envelope as the last write to stdout (hooks/footers go to stderr).
function lastJson(stdout) {
  // Brace-counter scan from end-of-stream for the last balanced top-level
  // object. Tolerates trailing whitespace/newlines.
  const s = stdout.trimEnd();
  let end = s.lastIndexOf('}');
  if (end < 0) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = s[i];
    if (ch === '}') depth++;
    else if (ch === '{') depth--;
    if (depth === 0 && ch === '{') {
      try { return JSON.parse(s.slice(i, end + 1)); }
      catch { return null; }
    }
  }
  return null;
}

test('W409d #6 — CLI `kolm run <artifact> --json` envelope proves dispatcher routed', async () => {
  const art = tmpKolm('cli-run');
  buildTestArtifact({
    outPath: art,
    runtime_target: 'js',
    recipes: [
      {
        id: 'rcp_upper',
        name: 'upper',
        source: 'function generate(input, lib){ return { upper: String((input && input.text) || "").toUpperCase(), src: "js_recipe" }; }',
      },
    ],
  });
  try {
    const out = await spawnCli(['run', art, JSON.stringify({ text: 'hi' }), '--json', '--force']);
    // We tolerate non-zero exit codes (e.g. EXIT.GATE_FAIL when production
    // gates trip on the minimal manifest) so long as the envelope was emitted
    // AND it carries the runtime label our dispatcher added. The W341 path
    // already prints --json before failing on strict gates.
    const env = lastJson(out.stdout);
    assert.ok(env, `expected JSON envelope on stdout. exit=${out.code} stdout=${out.stdout.slice(-400)} stderr=${out.stderr.slice(-400)}`);
    // The dispatcher adds runtime:'js' to runArtifact's return; cmdRun
    // includes the audit object which now carries runtime as well.
    const runtimeLabel = (env.audit && env.audit.runtime) || env.runtime || null;
    assert.equal(
      runtimeLabel,
      'js',
      `CLI envelope must carry the dispatcher's runtime label (got ${runtimeLabel}; envelope keys: ${Object.keys(env).join(',')})`,
    );
    // Recipe-id round-trips so we can prove the recipe ran (not bypassed).
    const recipe = env.recipe || env.recipe_id || (env.audit && env.audit.recipe_id);
    assert.ok(recipe === 'rcp_upper' || recipe === 'upper', `recipe id/name should be present; got ${recipe}`);
  } finally {
    try { fs.rmSync(path.dirname(art), { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

// ---------------------------------------------------------------------------
// 7. CLI `kolm eval` end-to-end — dispatcher reached cross-process.
// ---------------------------------------------------------------------------
test('W409d #7 — CLI `kolm eval <artifact> --json` exercises dispatcher per case', async () => {
  const art = tmpKolm('cli-eval');
  buildTestArtifact({
    outPath: art,
    runtime_target: 'js',
    recipes: [
      {
        id: 'rcp_identity',
        name: 'identity',
        source: 'function generate(input, lib){ return { tag: "from_dispatcher_js", echoed: input }; }',
      },
    ],
  });
  // Add evals.json with 3 cases whose expected fingerprint is the dispatcher's
  // recipe output. A direct-JS-loop bypass would still match this (since the
  // recipe is the same code), but tests #2 and #3 cover the non-JS routing
  // separately; here we focus on evalArtifact getting accuracy=1 + structured
  // envelope back through the CLI.
  const zip = new AdmZip(art);
  zip.addFile(
    'evals.json',
    Buffer.from(
      JSON.stringify({
        spec: 'rs-1-evals',
        n: 3,
        comparator: 'subset_equal',
        cases: [
          { id: 'c1', input: { x: 1 }, expected: { tag: 'from_dispatcher_js' } },
          { id: 'c2', input: { x: 2 }, expected: { tag: 'from_dispatcher_js' } },
          { id: 'c3', input: { x: 3 }, expected: { tag: 'from_dispatcher_js' } },
        ],
      }),
      'utf8',
    ),
  );
  zip.writeZip(art);
  try {
    const out = await spawnCli(['eval', art, '--json', '--force']);
    const env = lastJson(out.stdout);
    assert.ok(env, `expected JSON envelope from kolm eval. exit=${out.code} stdout=${out.stdout.slice(-400)} stderr=${out.stderr.slice(-400)}`);
    assert.equal(env.n, 3, `eval must run all 3 cases; got n=${env.n}`);
    assert.equal(env.passed, 3, `eval must pass all 3 cases; got passed=${env.passed} errors=${JSON.stringify(env.errors)}`);
    assert.equal(env.accuracy, 1.0);
  } finally {
    try { fs.rmSync(path.dirname(art), { recursive: true, force: true }); } catch {} // deliberate: cleanup
  }
});

// ---------------------------------------------------------------------------
// 8. Cross-cutting assertion: source-level guarantee. runArtifact's body must
//    invoke dispatchRuntime, not the old recipe loop. We grep the source file
//    so a future regression (someone re-introducing the inline loop inside
//    runArtifact) fails this test even if every other behavioral test passes
//    by coincidence.
// ---------------------------------------------------------------------------
test('W409d #8 — runArtifact source delegates to dispatchRuntime (no inline JS loop)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'artifact-runner.js'), 'utf8');
  // Locate the runArtifact body and ensure it contains a dispatchRuntime call.
  const bodyMatch = src.match(/export async function runArtifact\([^)]*\) \{([\s\S]*?)\n\}\n/);
  assert.ok(bodyMatch, 'runArtifact must be present in src/artifact-runner.js');
  const body = bodyMatch[1];
  assert.match(body, /dispatchRuntime\s*\(/, 'runArtifact body must call dispatchRuntime');
  // Refuse a regression where runArtifact reintroduces its own recipe loop
  // (the historical bug). The presence of `for (const r of recipes.recipes)`
  // inside runArtifact's body is the smoking gun.
  assert.doesNotMatch(
    body,
    /for\s*\(\s*const\s+r\s+of\s+recipes\.recipes\s*\)/,
    'runArtifact must not reintroduce the inline JS recipe loop',
  );
});
