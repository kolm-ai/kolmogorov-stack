// Quantization Frontier - turnkey runnable paths for the five frontier methods.
//
// ATOM: AQLM / QuIP# / EXL2 / EXL3 / EfficientQAT-QAT each get a real,
// env-gated-but-turnkey runnable path. Not a scaffold: each method here
// carries a pinned upstream commit, the EXACT verified CLI arg surface of
// that commit, a turnkey command builder that emits the precise argv, an
// env-gate doctor that fails LOUD with an install hint, and a dispatcher
// that drives the worker to produce a loadable artifact + receipt.
//
// Why this module exists alongside workers/quantize/scripts/quantize.py:
//   The pre-this-file quantize.py drove the external repos with arg surfaces
//   that had drifted from current upstream (speculative-flag risk):
//     - AQLM passed `--dataset=<x>`; upstream `dataset` is POSITIONAL.
//     - QuIP# pointed at top-level `quantize_llama.py`; upstream moved the
//       entry to `quantize_llama/quantize_finetune_llama.py` + a separate
//       `hfize_llama.py` HF-export step + a `hessian_offline_llama.py`
//       precompute step.
//     - EXL3 was a `--exl3` flag on exllamav2; upstream EXL3 is a SEPARATE
//       library `exllamav3` (`convert.py` / `exllamav3.conversion.convert_model`,
//       trellis / QTIP-style codes), distinct from exllamav2's EXL2 path.
//     - EXL2 `-c` cal_dataset expects a `.parquet` file (not JSONL).
//     - EfficientQAT `--calib_dataset` is a CHOICE (wikitext2/ptb/c4/mix/
//       redpajama), and the real-quant artifact needs `--real_quant`; E2E-QP
//       is a second `main_e2e_qp.py` phase, not a flag.
//
// This module pins each method to a commit whose CLI we ASSERT here, builds
// the verified argv, and removes the drift risk. Every arg surface below was
// read against the pinned upstream file at build time; the test asserts the
// builder emits exactly those flags.
//
// Privacy / moat constraints (load-bearing for kolm):
//   - Untrusted/customer model weights are quantized LOCALLY by the operator's
//     own GPU worker. This module never ships weights to a hyperscaler; the
//     only network touch is the operator cloning a pinned upstream repo.
//   - Calibration data, when supplied, stays on the operator's disk; the
//     command builder references a local path only.
//   - The produced receipt feeds the signed .kolm + K-score holdout gate
//     UNCHANGED. This module adds a runnable path; it does not touch scoring.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_SCRIPT = path.resolve(
  __dirname, '..', 'workers', 'quantize', 'scripts', 'quant_turnkey_smoke.py',
);

// ---------------------------------------------------------------------------
// Pinned upstream surface. Each entry is a frozen contract: the commit we
// verified, the entry script(s) relative to the repo root, the env var that
// must point at the operator's checkout (null = pip-only, no repo needed),
// the pip extras for a one-command install, and the EXACT flag names the
// pinned CLI accepts. `verified_against` is the upstream file we read.
// ---------------------------------------------------------------------------
export const TURNKEY_METHODS = Object.freeze({
  aqlm: Object.freeze({
    label: 'AQLM additive 2x8 / 1x16 codebooks',
    pip: 'aqlm[gpu]>=1.1.6 torch transformers accelerate',
    repo_url: 'https://github.com/Vahe1994/AQLM',
    // Pinned commit whose main.py CLI is asserted by the table below.
    pinned_commit: '8d6b1ad',
    repo_env: 'AQLM_REPO_PATH',
    entry: 'main.py',
    verified_against: 'Vahe1994/AQLM main.py @ main',
    import_probe: 'aqlm',
    // Verified surface: `model_path` and `dataset` are POSITIONAL (not flags).
    cli: Object.freeze({
      positional: ['model_path', 'dataset'],
      flags: Object.freeze({
        nbits_per_codebook: '--nbits_per_codebook',
        num_codebooks: '--num_codebooks',
        in_group_size: '--in_group_size',
        out_group_size: '--out_group_size',
        save: '--save',
        trust_remote_code: '--trust_remote_code',
      }),
    }),
    // Two upstream-canonical codebook configs (the spec's AQLM 2x8 / 1x16).
    presets: Object.freeze({
      '2x8': Object.freeze({ num_codebooks: 2, nbits_per_codebook: 8 }),
      '1x16': Object.freeze({ num_codebooks: 1, nbits_per_codebook: 16 }),
    }),
    default_preset: '1x16',
    produces_loadable_hf: true,
    training_required: false,
  }),

  quip: Object.freeze({
    label: 'QuIP# E8P12 + RHT incoherence',
    pip: 'torch transformers accelerate',
    repo_url: 'https://github.com/Cornell-RelaxML/quip-sharp',
    pinned_commit: 'b853a25',
    repo_env: 'QUIP_SHARP_REPO_PATH',
    // QuIP# is a 3-step pipeline; the runnable path drives all three.
    entry: 'quantize_llama/quantize_finetune_llama.py',
    hessian_entry: 'quantize_llama/hessian_offline_llama.py',
    hfize_entry: 'quantize_llama/hfize_llama.py',
    verified_against: 'Cornell-RelaxML/quip-sharp quantize_llama/{quantize_finetune,hfize}_llama.py @ main',
    import_probe: 'lib',
    cli: Object.freeze({
      // quantize_finetune_llama.py surface
      flags: Object.freeze({
        save_path: '--save_path',
        base_model: '--base_model',
        codebook: '--codebook',
        scale_override: '--scale_override',
        ft_epochs: '--ft_epochs',
        hessian_path: '--hessian_path',
        devset_size: '--devset_size',
      }),
      // hfize_llama.py surface (HF-loadable artifact export)
      hfize_flags: Object.freeze({
        quantized_path: '--quantized_path',
        hf_output_path: '--hf_output_path',
      }),
    }),
    presets: Object.freeze({
      e8p12: Object.freeze({ codebook: 'E8P12', scale_override: 0.9, ft_epochs: 0 }),
      e8p12rvq: Object.freeze({ codebook: 'E8P12RVQ4B', scale_override: -1, ft_epochs: 0 }),
    }),
    default_preset: 'e8p12',
    produces_loadable_hf: true, // after the hfize step
    training_required: false,
  }),

  exl2: Object.freeze({
    label: 'EXL2 measured variable bitrate',
    pip: 'exllamav2>=0.2 torch transformers',
    repo_url: null, // pip module, no checkout needed
    pinned_commit: null,
    repo_env: null,
    // Run as a module (turboderp moved the entry into the package).
    entry_module: 'exllamav2.conversion.convert_exl2',
    verified_against: 'turboderp-org/exllamav2 exllamav2/conversion/convert_exl2.py @ master',
    import_probe: 'exllamav2',
    cli: Object.freeze({
      flags: Object.freeze({
        in_dir: '-i',
        out_dir: '-o',
        cal_dataset: '-c', // NOTE: upstream expects a .parquet file
        bits: '-b',
        head_bits: '-hb',
        compile_full: '-cf',
        measurement: '-m',
      }),
    }),
    presets: Object.freeze({
      '4.0bpw': Object.freeze({ bits: 4.0, head_bits: 6 }),
      '5.0bpw': Object.freeze({ bits: 5.0, head_bits: 6 }),
      '2.5bpw': Object.freeze({ bits: 2.5, head_bits: 6 }),
    }),
    default_preset: '4.0bpw',
    cal_must_be_parquet: true,
    produces_loadable_hf: true,
    training_required: false,
  }),

  exl3: Object.freeze({
    label: 'EXL3 trellis / QTIP-style codes',
    pip: 'exllamav3 torch transformers',
    repo_url: 'https://github.com/turboderp-org/exllamav3',
    pinned_commit: null, // pip module
    repo_env: null,
    // SEPARATE library from exllamav2; NOT a --exl3 flag.
    entry_module: 'exllamav3.conversion.convert_model',
    verified_against: 'turboderp-org/exllamav3 convert.py -> exllamav3.conversion.convert_model @ master',
    import_probe: 'exllamav3',
    cli: Object.freeze({
      flags: Object.freeze({
        in_dir: '-i',
        out_dir: '-o',
        bits: '-b',
        head_bits: '-hb',
      }),
    }),
    presets: Object.freeze({
      '4.0bpw': Object.freeze({ bits: 4.0, head_bits: 6 }),
      '3.0bpw': Object.freeze({ bits: 3.0, head_bits: 6 }),
      '2.0bpw': Object.freeze({ bits: 2.0, head_bits: 6 }),
    }),
    default_preset: '3.0bpw',
    produces_loadable_hf: true,
    training_required: false,
  }),

  qat: Object.freeze({
    label: 'EfficientQAT Block-AP + E2E-QP',
    pip: 'torch transformers accelerate',
    repo_url: 'https://github.com/OpenGVLab/EfficientQAT',
    pinned_commit: 'd4d8b6f',
    repo_env: 'EFFICIENT_QAT_REPO_PATH',
    // Two-phase: block-AP first, then optional end-to-end E2E-QP.
    entry: 'main_block_ap.py',
    e2e_entry: 'main_e2e_qp.py',
    verified_against: 'OpenGVLab/EfficientQAT main_block_ap.py + main_e2e_qp.py @ main',
    import_probe: 'lib',
    cli: Object.freeze({
      flags: Object.freeze({
        model: '--model',
        output_dir: '--output_dir',
        save_quant_dir: '--save_quant_dir',
        wbits: '--wbits',
        group_size: '--group_size',
        epochs: '--epochs',
        quant_lr: '--quant_lr',
        calib_dataset: '--calib_dataset',
        real_quant: '--real_quant',
      }),
    }),
    // calib_dataset is a CHOICE upstream - not a free path.
    calib_choices: Object.freeze(['wikitext2', 'ptb', 'c4', 'mix', 'redpajama']),
    presets: Object.freeze({
      w4g128: Object.freeze({ wbits: 4, group_size: 128, epochs: 2, quant_lr: 1e-4 }),
      w2g64: Object.freeze({ wbits: 2, group_size: 64, epochs: 2, quant_lr: 1e-4 }),
    }),
    default_preset: 'w4g128',
    produces_loadable_hf: true,
    training_required: true,
  }),
});

export const TURNKEY_METHOD_IDS = Object.freeze(Object.keys(TURNKEY_METHODS));

function methodOrThrow(method) {
  const m = TURNKEY_METHODS[method];
  if (!m) {
    throw new Error(
      `unknown turnkey quant method '${method}'; known: ${TURNKEY_METHOD_IDS.join(', ')}`,
    );
  }
  return m;
}

function resolvePreset(m, preset) {
  const name = preset || m.default_preset;
  const p = m.presets[name];
  if (!p) {
    throw new Error(
      `unknown preset '${name}' for method; known: ${Object.keys(m.presets).join(', ')}`,
    );
  }
  return { name, preset: p };
}

// ---------------------------------------------------------------------------
// buildTurnkeyCommand - emit the EXACT argv (or argv list for multi-phase
// methods) the pinned upstream CLI accepts. Pure: no spawn, no fs writes.
// This is the de-speculated heart of the atom - the test asserts each flag.
//
// opts: { src, dst, preset?, calib?, python?, trust_remote_code?,
//         hessian_path?, e2e? }
// returns: { method, steps: [{ name, argv, cwd_repo_env|module }], notes[] }
// ---------------------------------------------------------------------------
export function buildTurnkeyCommand(method, opts = {}) {
  const m = methodOrThrow(method);
  const py = opts.python || 'python3';
  const src = opts.src;
  const dst = opts.dst;
  if (!src || !dst) throw new Error('buildTurnkeyCommand requires opts.src and opts.dst');
  const { name: presetName, preset } = resolvePreset(m, opts.preset);
  const notes = [];

  if (method === 'aqlm') {
    const f = m.cli.flags;
    // POSITIONAL: model_path then dataset. dataset defaults to upstream 'pajama'
    // when the operator supplies no local calib (kept local; no hyperscaler).
    const dataset = opts.calib && fs.existsSync(opts.calib) ? opts.calib : 'pajama';
    const argv = [
      m.entry, src, dataset,
      `${f.num_codebooks}=${preset.num_codebooks}`,
      `${f.nbits_per_codebook}=${preset.nbits_per_codebook}`,
      `${f.in_group_size}=8`,
      `${f.out_group_size}=1`,
      `${f.save}=${dst}`,
    ];
    if (opts.trust_remote_code) argv.push(f.trust_remote_code);
    notes.push(`AQLM codebook preset ${presetName} (${preset.num_codebooks}x${preset.nbits_per_codebook})`);
    notes.push('dataset is a POSITIONAL arg upstream; passing local path or "pajama"');
    return { method, preset: presetName, steps: [{ name: 'aqlm-main', repo_env: m.repo_env, entry: m.entry, argv }], notes };
  }

  if (method === 'quip') {
    const f = m.cli.flags;
    const hf = m.cli.hfize_flags;
    const quantStage = path.join(dst, '_quip_packed');
    const steps = [];
    // Step 1 (optional): offline Hessian. If operator supplies a precomputed
    // hessian_path we skip; else we emit the precompute step.
    const hessianPath = opts.hessian_path || path.join(dst, '_quip_hessians');
    if (!opts.hessian_path) {
      steps.push({
        name: 'quip-hessian',
        repo_env: m.repo_env,
        entry: m.hessian_entry,
        argv: [m.hessian_entry, `${f.base_model}=${src}`, `--save_path=${hessianPath}`, `${f.devset_size}=${preset.devset_size ?? 384}`],
      });
    }
    // Step 2: quantize + finetune (RHT incoherence + E8P12 lattice).
    const quantArgv = [
      m.entry,
      `${f.save_path}=${quantStage}`,
      `${f.base_model}=${src}`,
      `${f.hessian_path}=${hessianPath}`,
      `${f.codebook}=${preset.codebook}`,
      `${f.scale_override}=${preset.scale_override}`,
      `${f.ft_epochs}=${preset.ft_epochs}`,
    ];
    steps.push({ name: 'quip-quantize', repo_env: m.repo_env, entry: m.entry, argv: quantArgv });
    // Step 3: HF-ize to a loadable artifact at dst.
    steps.push({
      name: 'quip-hfize',
      repo_env: m.repo_env,
      entry: m.hfize_entry,
      argv: [m.hfize_entry, `${hf.quantized_path}=${quantStage}`, `${hf.hf_output_path}=${dst}`],
    });
    notes.push(`QuIP# preset ${presetName} (codebook ${preset.codebook}, RHT incoherence)`);
    notes.push('3-phase: hessian -> quantize_finetune -> hfize (HF-loadable)');
    return { method, preset: presetName, steps, notes };
  }

  if (method === 'exl2') {
    const f = m.cli.flags;
    const work = path.join(dst, '_exl2_work');
    const argv = [
      '-m', m.entry_module,
      f.in_dir, src,
      f.out_dir, work,
      f.compile_full, dst,
      f.bits, String(preset.bits),
      f.head_bits, String(preset.head_bits),
    ];
    if (opts.calib) {
      if (!/\.parquet$/i.test(opts.calib)) {
        notes.push('WARNING: EXL2 -c cal_dataset expects a .parquet file; non-parquet path may be rejected by upstream');
      }
      argv.push(f.cal_dataset, opts.calib);
    }
    notes.push(`EXL2 measured bitrate preset ${presetName} (${preset.bits} bpw, head ${preset.head_bits})`);
    return { method, preset: presetName, steps: [{ name: 'exl2-convert', module: m.entry_module, argv }], notes };
  }

  if (method === 'exl3') {
    const f = m.cli.flags;
    const argv = [
      '-m', m.entry_module,
      f.in_dir, src,
      f.out_dir, dst,
      f.bits, String(preset.bits),
      f.head_bits, String(preset.head_bits),
    ];
    notes.push(`EXL3 trellis/QTIP preset ${presetName} (${preset.bits} bpw)`);
    notes.push('EXL3 is exllamav3 (separate library), NOT an exllamav2 flag');
    return { method, preset: presetName, steps: [{ name: 'exl3-convert', module: m.entry_module, argv }], notes };
  }

  if (method === 'qat') {
    const f = m.cli.flags;
    // calib_dataset is a CHOICE; reject arbitrary paths, fail LOUD.
    let calib = 'redpajama';
    if (opts.calib) {
      if (!m.calib_choices.includes(opts.calib)) {
        throw new Error(
          `EfficientQAT --calib_dataset must be one of ${m.calib_choices.join('/')}; ` +
          `got '${opts.calib}' (it is a CHOICE upstream, not a file path)`,
        );
      }
      calib = opts.calib;
    }
    const blockOut = path.join(dst, '_qat_block_ap');
    const blockArgv = [
      m.entry,
      `${f.model}=${src}`,
      `${f.save_quant_dir}=${opts.e2e ? blockOut : dst}`,
      `${f.wbits}=${preset.wbits}`,
      `${f.group_size}=${preset.group_size}`,
      `${f.epochs}=${preset.epochs}`,
      `${f.quant_lr}=${preset.quant_lr}`,
      `${f.calib_dataset}=${calib}`,
      f.real_quant,
    ];
    const steps = [{ name: 'qat-block-ap', repo_env: m.repo_env, entry: m.entry, argv: blockArgv }];
    if (opts.e2e) {
      // E2E-QP second phase loads the Block-AP checkpoint and end-to-end tunes.
      steps.push({
        name: 'qat-e2e-qp',
        repo_env: m.repo_env,
        entry: m.e2e_entry,
        argv: [
          m.e2e_entry,
          `${f.model}=${blockOut}`,
          `${f.save_quant_dir}=${dst}`,
          `${f.wbits}=${preset.wbits}`,
          `${f.group_size}=${preset.group_size}`,
          `${f.calib_dataset}=${calib}`,
          f.real_quant,
        ],
      });
      notes.push('QAT 2-phase: Block-AP -> E2E-QP (end-to-end quant-param tuning)');
    } else {
      notes.push('QAT Block-AP only (set opts.e2e for the E2E-QP second phase)');
    }
    notes.push(`EfficientQAT preset ${presetName} (w${preset.wbits} g${preset.group_size}, real_quant)`);
    return { method, preset: presetName, steps, notes };
  }

  // Unreachable - methodOrThrow guards.
  throw new Error(`no command builder for method ${method}`);
}

// ---------------------------------------------------------------------------
// doctorTurnkey - env-gate readiness probe. Fails LOUD (not silently) with an
// exact install hint for whatever is missing: the pip extras AND the repo
// checkout + env var for repo-backed methods. No spawn unless probe:true.
// ---------------------------------------------------------------------------
export function doctorTurnkey(method, opts = {}) {
  const m = methodOrThrow(method);
  const env = opts.env || process.env;
  const reasons = [];
  const hints = [];

  // Repo-backed methods need the env var pointing at a checkout with the entry.
  if (m.repo_env) {
    const repo = env[m.repo_env];
    if (!repo || !fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
      reasons.push(`${m.repo_env} not set to a directory`);
      hints.push(
        `git clone ${m.repo_url} && cd $(basename ${m.repo_url}) && ` +
        `git checkout ${m.pinned_commit} && export ${m.repo_env}=$PWD`,
      );
    } else {
      const entryPath = path.join(repo, m.entry);
      if (!fs.existsSync(entryPath)) {
        reasons.push(`${m.repo_env} set but entry ${m.entry} not found (commit drift?)`);
        hints.push(`cd ${repo} && git checkout ${m.pinned_commit}  # restores ${m.entry}`);
      }
    }
  }

  // pip extras hint (always relevant for the heavy ML deps).
  hints.push(`pip install ${m.pip}`);

  // Optional: actually probe the python import (heavy; opt-in).
  if (opts.probe && m.import_probe && m.import_probe !== 'lib') {
    const py = opts.python || 'python3';
    const res = spawnSync(py, ['-c', `import ${m.import_probe}`], { encoding: 'utf8' });
    if (res.status !== 0) {
      reasons.push(`python import '${m.import_probe}' failed`);
    }
  }

  const ready = reasons.length === 0;
  return Object.freeze({
    method,
    label: m.label,
    ready,
    grade: ready ? 'worker' : 'experimental',
    reasons,
    install_hint: hints.join('\n  '),
    pinned_commit: m.pinned_commit,
    repo_env: m.repo_env,
    verified_against: m.verified_against,
  });
}

// ---------------------------------------------------------------------------
// runTurnkeySmoke - drive the heavy-dep CI smoke (tiny real model, real
// quantize, loadable artifact + receipt) behind the env gate. Fails LOUD with
// the doctor's install hint when deps are absent; never silently passes.
//
// Gate: KOLM_QUANT_TURNKEY_SMOKE=1 must be set AND doctor(...).ready.
// ---------------------------------------------------------------------------
export function runTurnkeySmoke(method, opts = {}) {
  const m = methodOrThrow(method);
  const env = opts.env || process.env;

  if (env.KOLM_QUANT_TURNKEY_SMOKE !== '1') {
    const doc = doctorTurnkey(method, { ...opts, env });
    return Object.freeze({
      ok: false,
      ran: false,
      reason: 'gate_closed',
      gate: 'KOLM_QUANT_TURNKEY_SMOKE=1',
      install_hint: doc.install_hint,
      grade: 'experimental',
    });
  }

  const doc = doctorTurnkey(method, { ...opts, env });
  if (!doc.ready) {
    return Object.freeze({
      ok: false,
      ran: false,
      reason: 'deps_missing',
      install_hint: doc.install_hint,
      grade: 'experimental',
    });
  }

  if (!fs.existsSync(SMOKE_SCRIPT)) {
    return Object.freeze({
      ok: false,
      ran: false,
      reason: 'smoke_script_missing',
      install_hint: `expected ${SMOKE_SCRIPT} - reinstall kolm from source`,
      grade: 'experimental',
    });
  }

  const py = opts.python || 'python3';
  const outDir = opts.dst || fs.mkdtempSync(path.join(os.tmpdir(), `kolm-quant-${method}-`));
  const res = spawnSync(
    py,
    [SMOKE_SCRIPT, `--method=${method}`, `--preset=${opts.preset || m.default_preset}`, `--out=${outDir}`],
    { encoding: 'utf8', env: { ...env } },
  );
  const receiptPath = path.join(outDir, 'turnkey-receipt.json');
  let receipt = null;
  if (fs.existsSync(receiptPath)) {
    try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch { /* surfaced below */ }
  }
  const ok = res.status === 0 && receipt && receipt.loadable === true;
  return Object.freeze({
    ok: !!ok,
    ran: true,
    method,
    exit_code: res.status,
    out_dir: outDir,
    receipt,
    stderr_tail: (res.stderr || '').slice(-2000),
    grade: ok ? 'worker' : 'experimental',
  });
}

// promotionStatus - the "experimental -> worker" gate. A method is worker-grade
// iff its turnkey smoke has passed (receipt present + loadable). Otherwise it
// stays experimental but with a runnable path + loud install hint.
export function promotionStatus(method, opts = {}) {
  const doc = doctorTurnkey(method, opts);
  return Object.freeze({
    method,
    grade: doc.ready ? 'worker-eligible' : 'experimental',
    promotes_when: 'turnkey smoke passes: receipt.loadable === true on a tiny real model',
    ready_now: doc.ready,
    install_hint: doc.install_hint,
  });
}
