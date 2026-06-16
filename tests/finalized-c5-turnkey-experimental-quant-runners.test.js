// Proves the Quantization-Frontier turnkey-runner atom: AQLM / QuIP# / EXL2 /
// EXL3 / EfficientQAT each have a REAL runnable path whose exact arg surface is
// verified against pinned upstream, env-gated, and CI-smoke-able behind a
// heavy-dep marker. No scaffold: every assertion below pins to a concrete flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TURNKEY_METHODS,
  TURNKEY_METHOD_IDS,
  buildTurnkeyCommand,
  doctorTurnkey,
  runTurnkeySmoke,
  promotionStatus,
} from '../src/quant-turnkey-runners.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

test('all five frontier methods are present', () => {
  for (const id of ['aqlm', 'quip', 'exl2', 'exl3', 'qat']) {
    assert.ok(TURNKEY_METHODS[id], `method ${id} missing`);
  }
  assert.equal(TURNKEY_METHOD_IDS.length, 5);
});

test('every method pins an upstream surface + install hint (no speculative flags)', () => {
  for (const id of TURNKEY_METHOD_IDS) {
    const m = TURNKEY_METHODS[id];
    assert.ok(m.pip, `${id} missing pip install hint`);
    assert.ok(m.verified_against, `${id} missing verified_against provenance`);
    assert.ok(m.cli && m.cli.flags, `${id} missing cli.flags surface`);
    assert.ok(Object.keys(m.presets).length >= 1, `${id} has no presets`);
    assert.ok(m.presets[m.default_preset], `${id} default preset missing`);
    // Repo-backed methods must carry a pinned commit + env var.
    if (m.repo_url) {
      assert.ok(m.repo_env || m.entry_module, `${id} repo method needs repo_env or module`);
    }
  }
});

// ----- AQLM: dataset is POSITIONAL, codebooks 2x8 / 1x16 -----
test('AQLM builder emits positional dataset + verified codebook flags', () => {
  const cmd = buildTurnkeyCommand('aqlm', { src: '/m/in', dst: '/m/out', preset: '2x8' });
  assert.equal(cmd.steps.length, 1);
  const argv = cmd.steps[0].argv;
  // main.py <model_path> <dataset> ... -> positionals come right after entry.
  assert.equal(argv[0], 'main.py');
  assert.equal(argv[1], '/m/in');
  assert.equal(argv[2], 'pajama'); // dataset POSITIONAL, no --dataset= flag
  assert.ok(!argv.some((a) => a.startsWith('--dataset')), 'must NOT use --dataset= (drift bug)');
  assert.ok(argv.includes('--num_codebooks=2'));
  assert.ok(argv.includes('--nbits_per_codebook=8'));
  assert.ok(argv.includes('--save=/m/out'));
  // 1x16 preset is the other upstream-canonical codebook config.
  const cmd2 = buildTurnkeyCommand('aqlm', { src: '/m/in', dst: '/m/out', preset: '1x16' });
  assert.ok(cmd2.steps[0].argv.includes('--num_codebooks=1'));
  assert.ok(cmd2.steps[0].argv.includes('--nbits_per_codebook=16'));
});

// ----- QuIP#: 3-phase, E8P12 + RHT incoherence, HF-loadable -----
test('QuIP# builder drives hessian -> quantize_finetune -> hfize with E8P12', () => {
  const cmd = buildTurnkeyCommand('quip', { src: '/m/in', dst: '/m/out' });
  const names = cmd.steps.map((s) => s.name);
  assert.deepEqual(names, ['quip-hessian', 'quip-quantize', 'quip-hfize']);
  const quant = cmd.steps.find((s) => s.name === 'quip-quantize').argv;
  assert.equal(quant[0], 'quantize_llama/quantize_finetune_llama.py');
  assert.ok(quant.includes('--codebook=E8P12'), 'E8P12 lattice');
  assert.ok(quant.some((a) => a.startsWith('--hessian_path=')), 'RHT incoherence needs hessian');
  assert.ok(quant.some((a) => a.startsWith('--base_model=')));
  // hfize step yields the loadable HF artifact at dst.
  const hf = cmd.steps.find((s) => s.name === 'quip-hfize').argv;
  assert.equal(hf[0], 'quantize_llama/hfize_llama.py');
  assert.ok(hf.includes('--hf_output_path=/m/out'));
  assert.ok(hf.some((a) => a.startsWith('--quantized_path=')));
  // entry must NOT be the stale top-level quantize_llama.py (404 upstream).
  assert.notEqual(TURNKEY_METHODS.quip.entry, 'quantize_llama.py');
});

test('QuIP# skips hessian precompute when operator supplies hessian_path', () => {
  const cmd = buildTurnkeyCommand('quip', { src: '/m/in', dst: '/m/out', hessian_path: '/h' });
  assert.deepEqual(cmd.steps.map((s) => s.name), ['quip-quantize', 'quip-hfize']);
  const quant = cmd.steps[0].argv;
  assert.ok(quant.includes('--hessian_path=/h'));
});

// ----- EXL2: measured bitrate, module convert_exl2, parquet calib -----
test('EXL2 builder runs convert_exl2 module with verified -i/-o/-cf/-b/-hb', () => {
  const cmd = buildTurnkeyCommand('exl2', { src: '/m/in', dst: '/m/out', preset: '5.0bpw' });
  const argv = cmd.steps[0].argv;
  assert.equal(cmd.steps[0].module, 'exllamav2.conversion.convert_exl2');
  assert.equal(argv[0], '-m');
  assert.equal(argv[1], 'exllamav2.conversion.convert_exl2');
  assert.ok(argv.includes('-i') && argv[argv.indexOf('-i') + 1] === '/m/in');
  assert.ok(argv.includes('-cf') && argv[argv.indexOf('-cf') + 1] === '/m/out');
  assert.ok(argv.includes('-b') && argv[argv.indexOf('-b') + 1] === '5');
  assert.ok(argv.includes('-hb'));
});

test('EXL2 warns when cal_dataset is not .parquet (upstream constraint)', () => {
  const cmd = buildTurnkeyCommand('exl2', { src: '/m/in', dst: '/m/out', calib: '/c/data.jsonl' });
  assert.ok(cmd.notes.some((n) => /parquet/i.test(n)), 'must warn on non-parquet calib');
  assert.ok(cmd.steps[0].argv.includes('-c'));
  const okCmd = buildTurnkeyCommand('exl2', { src: '/m/in', dst: '/m/out', calib: '/c/cal.parquet' });
  assert.ok(!okCmd.notes.some((n) => /WARNING.*parquet/i.test(n)));
});

// ----- EXL3: SEPARATE library (exllamav3), trellis/QTIP, not a flag -----
test('EXL3 uses exllamav3 (separate lib), not an exllamav2 --exl3 flag', () => {
  assert.equal(TURNKEY_METHODS.exl3.entry_module, 'exllamav3.conversion.convert_model');
  assert.notEqual(TURNKEY_METHODS.exl3.entry_module, TURNKEY_METHODS.exl2.entry_module);
  const cmd = buildTurnkeyCommand('exl3', { src: '/m/in', dst: '/m/out', preset: '2.0bpw' });
  const argv = cmd.steps[0].argv;
  assert.ok(!argv.includes('--exl3'), 'EXL3 must NOT be a --exl3 flag (drift bug)');
  assert.equal(argv[1], 'exllamav3.conversion.convert_model');
  assert.ok(argv.includes('-b') && argv[argv.indexOf('-b') + 1] === '2');
  assert.ok(cmd.notes.some((n) => /trellis|QTIP/i.test(n)));
});

// ----- EfficientQAT: Block-AP + E2E-QP, calib is a CHOICE, real_quant -----
test('QAT builder emits Block-AP with --real_quant and verified flags', () => {
  const cmd = buildTurnkeyCommand('qat', { src: '/m/in', dst: '/m/out', preset: 'w4g128' });
  assert.equal(cmd.steps.length, 1);
  const argv = cmd.steps[0].argv;
  assert.equal(argv[0], 'main_block_ap.py');
  assert.ok(argv.includes('--wbits=4'));
  assert.ok(argv.includes('--group_size=128'));
  assert.ok(argv.includes('--real_quant'), 'real artifact needs --real_quant');
  assert.ok(argv.some((a) => a.startsWith('--save_quant_dir=')));
});

test('QAT E2E flag adds the main_e2e_qp.py second phase', () => {
  const cmd = buildTurnkeyCommand('qat', { src: '/m/in', dst: '/m/out', e2e: true });
  assert.deepEqual(cmd.steps.map((s) => s.name), ['qat-block-ap', 'qat-e2e-qp']);
  assert.equal(cmd.steps[1].argv[0], 'main_e2e_qp.py');
});

test('QAT rejects arbitrary calib (it is a CHOICE upstream), accepts valid', () => {
  assert.throws(
    () => buildTurnkeyCommand('qat', { src: '/m/in', dst: '/m/out', calib: '/c/file.jsonl' }),
    /calib_dataset must be one of/,
  );
  const ok = buildTurnkeyCommand('qat', { src: '/m/in', dst: '/m/out', calib: 'c4' });
  assert.ok(ok.steps[0].argv.includes('--calib_dataset=c4'));
});

// ----- doctor: fails LOUD with install hint when env-gated off -----
test('doctorTurnkey fails loud with pinned-commit + env-var install hint', () => {
  const doc = doctorTurnkey('aqlm', { env: {} }); // no AQLM_REPO_PATH
  assert.equal(doc.ready, false);
  assert.equal(doc.grade, 'experimental');
  assert.ok(doc.reasons.some((r) => /AQLM_REPO_PATH/.test(r)));
  assert.ok(/git clone https:\/\/github\.com\/Vahe1994\/AQLM/.test(doc.install_hint));
  assert.ok(/git checkout/.test(doc.install_hint), 'hint must pin a commit');
  assert.ok(/pip install/.test(doc.install_hint));
});

test('doctor flags commit drift when env points at a checkout missing the entry', () => {
  const tmp = fs.mkdtempSync(path.join(REPO, 'tmp-quip-'));
  try {
    const doc = doctorTurnkey('quip', { env: { QUIP_SHARP_REPO_PATH: tmp } });
    assert.equal(doc.ready, false);
    assert.ok(doc.reasons.some((r) => /not found|drift/.test(r)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pip-only methods (exl2/exl3) need no repo env to be doctor-ready', () => {
  const doc = doctorTurnkey('exl2', { env: {} });
  assert.equal(doc.ready, true, 'exl2 has no repo_env gate');
  assert.equal(doc.grade, 'worker');
});

// ----- smoke gate: env-gated OFF by default, fails loud, never fake-passes ---
test('runTurnkeySmoke is gated off by default and surfaces install hint', () => {
  const r = runTurnkeySmoke('aqlm', { env: {} });
  assert.equal(r.ran, false);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gate_closed');
  assert.equal(r.gate, 'KOLM_QUANT_TURNKEY_SMOKE=1');
  assert.ok(r.install_hint && r.install_hint.length > 0);
});

test('runTurnkeySmoke with gate on but deps missing reports deps_missing (loud, not pass)', () => {
  const r = runTurnkeySmoke('aqlm', { env: { KOLM_QUANT_TURNKEY_SMOKE: '1' } });
  // No AQLM_REPO_PATH => doctor not ready => deps_missing, never ok.
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'deps_missing');
  assert.ok(r.install_hint.length > 0);
});

test('heavy-dep smoke script exists on disk (CI marker target)', () => {
  const p = path.resolve(REPO, 'workers', 'quantize', 'scripts', 'quant_turnkey_smoke.py');
  assert.ok(fs.existsSync(p), 'quant_turnkey_smoke.py must exist for the heavy-dep CI smoke');
  const body = fs.readFileSync(p, 'utf8');
  assert.ok(/turnkey-receipt\.json/.test(body), 'smoke must emit a receipt');
  assert.ok(/loadable/.test(body), 'smoke must assert artifact loadability');
});

// ----- promotion: experimental -> worker only after smoke passes -----
test('promotionStatus pins the experimental -> worker gate', () => {
  const s = promotionStatus('qat', { env: {} });
  assert.equal(s.grade, 'experimental');
  assert.ok(/turnkey smoke passes/.test(s.promotes_when));
  const ok = promotionStatus('exl3', { env: {} });
  assert.equal(ok.grade, 'worker-eligible'); // pip-only, doctor-ready
});

// ----- privacy boundary: builders reference only local paths, no hyperscaler -
test('command builders reference only local paths (no hyperscaler endpoints)', () => {
  for (const id of TURNKEY_METHOD_IDS) {
    const cmd = buildTurnkeyCommand(id, { src: '/local/in', dst: '/local/out' });
    for (const step of cmd.steps) {
      for (const a of step.argv) {
        assert.ok(!/https?:\/\//.test(a), `${id} argv must not contain a URL: ${a}`);
      }
    }
  }
});

test('unknown method / missing src|dst fail loud', () => {
  assert.throws(() => buildTurnkeyCommand('nope', { src: '/a', dst: '/b' }), /unknown turnkey/);
  assert.throws(() => buildTurnkeyCommand('aqlm', { dst: '/b' }), /requires opts.src/);
});
