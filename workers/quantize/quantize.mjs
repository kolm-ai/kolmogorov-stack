#!/usr/bin/env node
// workers/quantize/quantize.mjs
//
// Wave 195 (Q+5): isolated kolm quantization worker. Lives in its own
// package so the heavy ML deps (bitsandbytes, auto-gptq, optimum, torch,
// accelerate) NEVER land in the root kolm install. The root CLI invokes
// this worker only when the tenant explicitly opts in via
// `kolm quantize --local-worker`.
//
// Modes:
//   --doctor           print toolchain readiness and exit
//   (default)          read --in / --out / --method and either invoke
//                      scripts/quantize.py when present + deps satisfied,
//                      or emit an honest "not_yet_wired" manifest naming
//                      what is missing.
//
// Supported methods (W614 expansion — full SOTA quant menu, per-method doctor):
//   int4    bitsandbytes 4-bit weight quantization (NF4 + double, convenience baseline)
//   int8    bitsandbytes 8-bit weight quantization (LLM.int8)
//   gptq    auto-gptq post-training quantization (4-bit, calibration-based)
//   awq     AutoAWQ activation-aware weight quantization (4-bit, near-FP16 accuracy)
//   aqlm    AQLM (Egiazarian 2024) additive quantization, near-lossless 2-bit
//   quip    QuIP# (Tseng 2024) sub-2-bit with incoherence preprocessing (E8 lattice)
//   exl2    ExLlamaV2 EXL2 runtime-optimized variable-bit quantization
//   exl3    ExLlamaV2 EXL3 next-gen format (better compression than EXL2)
//   hqq     HQQ (Mobius Labs 2024) calibration-free half-quadratic quantization
//   qat     EfficientQAT (Chen 2024) quantization-aware training (block-wise)
//
// Honest-scope contract:
//   * kolm ships the Node entrypoint + dep detection + the real python
//     script (scripts/quantize.py — W336 P2 fix; W614 expanded to all 10
//     methods). The customer still must create the venv and pip install
//     workers/quantize/requirements.txt because kolm does NOT pip install
//     on the customer's behalf (the heavy ML deps would otherwise leak
//     into the root install).
//   * Per-method readiness: each method has its OWN Python dep set, and
//     the worker only refuses methods whose deps are missing. e.g. a tenant
//     with only bitsandbytes + hqq installed can run int4/int8/hqq even
//     without auto-gptq/autoawq/aqlm/quip-sharp/exllamav2/efficient_qat.
//   * If the venv is missing, the worker emits a manifest naming the
//     missing pieces and exits 2 (W253 ML#9 — CI must fail loud).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const VALID_METHODS = ['int4', 'int8', 'gptq', 'awq', 'aqlm', 'quip', 'exl2', 'exl3', 'hqq', 'qat'];

// W784 — third-party quant-method plugin discovery hook. Returns the array of
// extra method names contributed by ~/.kolm/plugins/<name>/ with kind
// "quantization". Caller treats them as opaque (the plugin's entry script is
// responsible for the actual quantization). Best-effort: failure to load
// plugins is logged via env KOLM_PLUGIN_DEBUG only — never blocks core methods.
async function w784QuantPluginMethods() {
  try {
    const mod = await import('../../src/plugins.js');
    const env = mod.forgeQuantizationPlugins();
    if (!env || !env.ok) return [];
    return (env.plugins || []).map((p) => p.name);
  } catch (e) {
    if (process.env.KOLM_PLUGIN_DEBUG) {
      console.error('[w784-quant-plugin-discovery] ' + (e && e.message ? e.message : e));
    }
    return [];
  }
}
// Eager discovery at boot — surfaces the count via env for downstream
// observability; the actual dispatch path runs in scripts/quantize.py.
w784QuantPluginMethods().then((m) => {
  if (m.length) process.env.KOLM_PLUGIN_QUANT_METHODS = m.join(',');
});
const WORKER_NAME    = 'kolm-quantize-worker';
const WORKER_VERSION = '0.1.0';

const args = parseArgs(process.argv.slice(2));
const wantJson = args.json === true;

if (args.doctor) {
  const report = await doctor();
  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[${WORKER_NAME}] doctor report`);
    console.log(`  node_version:    ${report.node_version}`);
    console.log(`  python_ok:       ${report.python_ok}` + (report.python_version ? ` (${report.python_version})` : ''));
    console.log(`  torch_ok:        ${report.torch_ok}` + (report.torch_version ? ` (${report.torch_version})` : ''));
    console.log(`  transformers_ok: ${report.transformers_ok}` + (report.transformers_version ? ` (${report.transformers_version})` : ''));
    console.log(`  accelerate_ok:   ${report.accelerate_ok}`);
    console.log(`  bitsandbytes_ok: ${report.bitsandbytes_ok}`);
    console.log(`  auto_gptq_ok:    ${report.auto_gptq_ok}`);
    console.log(`  optimum_ok:      ${report.optimum_ok}`);
    console.log(`  autoawq_ok:      ${report.autoawq_ok}`);
    console.log(`  aqlm_ok:         ${report.aqlm_ok}`);
    console.log(`  quip_ok:         ${report.quip_ok}`);
    console.log(`  exllamav2_ok:    ${report.exllamav2_ok}`);
    console.log(`  hqq_ok:          ${report.hqq_ok}`);
    console.log(`  efficient_qat_ok:${report.efficient_qat_ok}`);
    console.log(`  ready_by_method: ${JSON.stringify(report.ready_by_method)}`);
    console.log(`  ready:           ${report.ready_for_quantize}`);
    if (report.hint) console.log(`  hint:            ${report.hint}`);
  }
  const doctorMethod = VALID_METHODS.includes(args.method) ? args.method : null;
  const ready = doctorMethod ? report.ready_by_method[doctorMethod] : report.ready_for_quantize;
  process.exit(ready ? 0 : 1);
}

const method = args.method || 'int4';
if (!VALID_METHODS.includes(method)) {
  fail(`unknown --method=${method}; expected one of [${VALID_METHODS.join(', ')}]`);
}

const inDir  = args.in  ? path.resolve(process.cwd(), args.in)  : null;
const outDir = args.out ? path.resolve(process.cwd(), args.out) : null;

const report = await doctor();
const pyScript = path.join(__dirname, 'scripts', 'quantize.py');
const pyScriptExists = fs.existsSync(pyScript);

if (!report.ready_by_method?.[method] || !pyScriptExists) {
  // Honest manifest: the Node substrate is present, but this method cannot
  // run until its Python stack is importable.
  const manifest = {
    worker: WORKER_NAME,
    worker_version: WORKER_VERSION,
    method,
    in:  inDir,
    out: outDir,
    ml_pipeline_run: false,
    api_status: pyScriptExists ? 'toolchain_not_ready' : 'not_yet_wired',
    python_script_present: pyScriptExists,
    missing_pieces: report.missing_by_method?.[method] || [],
    doctor: report,
    note: pyScriptExists
      ? `python stack missing for ${method}; install workers/quantize/requirements.txt in a venv`
      : 'scripts/quantize.py missing — reinstall workers/quantize/ from upstream',
    next: pyScriptExists
      ? 'cd workers/quantize && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'
      : 'restore workers/quantize/scripts/quantize.py from the kolm repo',
    finished_at: new Date().toISOString(),
  };
  if (outDir) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'quantize-manifest.json'), JSON.stringify(manifest, null, 2));
    } catch { /* swallow; the manifest still prints to stdout */ }
  }
  if (wantJson) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(`[${WORKER_NAME}] quantize ${method} not run.`);
    console.log(`  reason: ${manifest.note}`);
    console.log(`  next:   ${manifest.next}`);
  }
  // Wave 253 ML#9: exit non-zero (2) when the ML stack isn't ready and
  // --doctor wasn't passed. Pre-W253 we exited 0 with a scaffolding manifest,
  // which let CI green-light a "quantize" that didn't actually quantize. CI
  // should fail loud so the operator sees the gap. --doctor is the one
  // intentional "happy path with not-ready" mode — handled above and exits
  // with `ready_for_quantize ? 0 : 1` so doctor differs from default-mode 2.
  process.exit(2);
}

// Python ready + script present: invoke it. kolm does not interpret the
// script's output beyond exit code; the script writes its own quantized
// weights to --out.
console.log(`[${WORKER_NAME}] invoking python quantizer (method=${method})`);
// W719 — pass --mixed-precision profile path through to the python worker
// when set. Resolved relative to the calling CWD so a user can pass a
// relative profile path on the CLI.
const passthrough = [
  pyScript,
  `--method=${method}`,
  `--in=${inDir}`,
  `--out=${outDir}`,
];
if (args['mixed-precision']) {
  const mp = path.resolve(process.cwd(), args['mixed-precision']);
  passthrough.push(`--mixed-precision=${mp}`);
}
const res = spawnSync('python3', passthrough, { stdio: 'inherit' });
process.exit(res.status ?? 1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function doctor() {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  const python_ok = python.status === 0;
  const torch = probePythonModule('torch', '__version__', python_ok);
  const transformers = probePythonModule('transformers', '__version__', python_ok);
  const accelerate = probePythonModule('accelerate', '__version__', python_ok);
  const bitsandbytes = probePythonModule('bitsandbytes', '__version__', python_ok);
  const autoGptq = probePythonModule('auto_gptq', '__version__', python_ok);
  const optimum = probePythonModule('optimum', '__version__', python_ok);
  const autoawq = probePythonModule('awq', '__version__', python_ok);
  const aqlm = probePythonModule('aqlm', '__version__', python_ok);
  const quip = probePythonModule('quip_sharp', '__version__', python_ok);
  const exllamav2 = probePythonModule('exllamav2', '__version__', python_ok);
  const hqq = probePythonModule('hqq', '__version__', python_ok);
  const efficientQat = probePythonModule('efficient_qat', '__version__', python_ok);

  const baseOk = python_ok && torch.ok && transformers.ok && accelerate.ok;
  const ready_by_method = {
    int4: baseOk && bitsandbytes.ok,
    int8: baseOk && bitsandbytes.ok,
    gptq: baseOk && autoGptq.ok && optimum.ok,
    awq: baseOk && autoawq.ok,
    aqlm: baseOk && aqlm.ok,
    quip: baseOk && quip.ok,
    exl2: baseOk && exllamav2.ok,
    exl3: baseOk && exllamav2.ok,
    hqq: baseOk && hqq.ok,
    qat: baseOk && efficientQat.ok,
  };
  const missing_by_method = Object.fromEntries(
    Object.entries({
      int4: [
        ['python3', python_ok],
        ['torch', torch.ok],
        ['transformers', transformers.ok],
        ['accelerate', accelerate.ok],
        ['bitsandbytes', bitsandbytes.ok],
      ],
      int8: [
        ['python3', python_ok],
        ['torch', torch.ok],
        ['transformers', transformers.ok],
        ['accelerate', accelerate.ok],
        ['bitsandbytes', bitsandbytes.ok],
      ],
      gptq: [
        ['python3', python_ok],
        ['torch', torch.ok],
        ['transformers', transformers.ok],
        ['accelerate', accelerate.ok],
        ['auto-gptq', autoGptq.ok],
        ['optimum', optimum.ok],
      ],
      awq: [
        ['python3', python_ok],
        ['torch', torch.ok],
        ['transformers', transformers.ok],
        ['accelerate', accelerate.ok],
        ['autoawq', autoawq.ok],
      ],
      aqlm: [
        ['python3', python_ok],
        ['torch', torch.ok],
        ['transformers', transformers.ok],
        ['accelerate', accelerate.ok],
        ['aqlm', aqlm.ok],
      ],
      quip: [
        ['python3', python_ok],
        ['torch', torch.ok],
        ['transformers', transformers.ok],
        ['accelerate', accelerate.ok],
        ['quip-sharp', quip.ok],
      ],
      exl2: [
        ['python3', python_ok],
        ['torch', torch.ok],
        ['transformers', transformers.ok],
        ['accelerate', accelerate.ok],
        ['exllamav2', exllamav2.ok],
      ],
      exl3: [
        ['python3', python_ok],
        ['torch', torch.ok],
        ['transformers', transformers.ok],
        ['accelerate', accelerate.ok],
        ['exllamav2', exllamav2.ok],
      ],
      hqq: [
        ['python3', python_ok],
        ['torch', torch.ok],
        ['transformers', transformers.ok],
        ['accelerate', accelerate.ok],
        ['hqq', hqq.ok],
      ],
      qat: [
        ['python3', python_ok],
        ['torch', torch.ok],
        ['transformers', transformers.ok],
        ['accelerate', accelerate.ok],
        ['efficient_qat', efficientQat.ok],
      ],
    }).map(([methodName, deps]) => [methodName, deps.filter(([, ok]) => !ok).map(([name]) => name)])
  );
  const ready_for_quantize = Object.values(ready_by_method).some(Boolean);

  return {
    node_version: process.versions.node,
    python_ok,
    python_version: python_ok ? (python.stdout || '').trim() : null,
    torch_ok: torch.ok,
    torch_version: torch.version,
    transformers_ok: transformers.ok,
    transformers_version: transformers.version,
    accelerate_ok: accelerate.ok,
    accelerate_version: accelerate.version,
    bitsandbytes_ok: bitsandbytes.ok,
    bitsandbytes_version: bitsandbytes.version,
    auto_gptq_ok: autoGptq.ok,
    auto_gptq_version: autoGptq.version,
    optimum_ok: optimum.ok,
    optimum_version: optimum.version,
    autoawq_ok: autoawq.ok,
    autoawq_version: autoawq.version,
    aqlm_ok: aqlm.ok,
    aqlm_version: aqlm.version,
    quip_ok: quip.ok,
    quip_version: quip.version,
    exllamav2_ok: exllamav2.ok,
    exllamav2_version: exllamav2.version,
    hqq_ok: hqq.ok,
    hqq_version: hqq.version,
    efficient_qat_ok: efficientQat.ok,
    efficient_qat_version: efficientQat.version,
    ready_by_method,
    missing_by_method,
    ready_for_quantize,
    hint: ready_for_quantize
      ? null
      : 'install Python 3.10+ then: cd workers/quantize && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
  };
}

function probePythonModule(moduleName, versionAttr, python_ok) {
  if (!python_ok) return { ok: false, version: null };
  const code = `import ${moduleName}; print(getattr(${moduleName}, '${versionAttr}', 'unknown'))`;
  const res = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  return {
    ok: res.status === 0,
    version: res.status === 0 ? (res.stdout || '').trim() : null,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`[${WORKER_NAME}] ${msg}\n`);
  process.exit(2);
}
