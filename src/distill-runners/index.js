// src/distill-runners/index.js
//
// W921 Run / Serve & Deploy - remote distill-job RUNNERS (Modal + RunPod).
//
// Additive, deterministic LAUNCH-SPEC builders for running a kolm distill job on
// a rented GPU. These are PURE spec generators (no network, no API calls): they
// turn a recipe + a GPU request into the exact remote-launch descriptor the
// orchestrator (or the CLI lane) submits. Keeping the spec deterministic means
// the same recipe always produces the same launch plan, so a run is
// reproducible and auditable BEFORE any GPU is rented.
//
// Why a separate module from src/cloud/runpod.js: that module owns SERVING pod
// provisioning (a running OpenAI endpoint). This one owns TRAINING job launch
// (a one-shot distill run that writes a .kolm artifact and exits). They share
// the RunPod vocabulary but solve different problems and never the same wire.
//
// Surface:
//   GPU_CATALOG                     canonical GPU class -> {vram_gb, family, ...}
//   selectGpuForJob(recipe, opts)   recipe VRAM need -> smallest GPU that fits
//   buildModalLaunchSpec(...)       Modal app/function launch descriptor
//   buildRunpodLaunchSpec(...)      RunPod job launch descriptor
//   planRemoteDistill(...)          top-level: provider + GPU + spec + env
//
// Verify offline: `node src/distill-runners/index.js --self-test`.

export const DISTILL_RUNNERS_VERSION = 'distill-runners-v1';

function _isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Canonical GPU classes the runners can request, smallest -> largest VRAM.
// vram_gb is the usable HBM; train_headroom is the fraction we leave free for
// optimizer state + activations + grad-checkpointing slack.
export const GPU_CATALOG = Object.freeze([
  { id: 'L4',        vram_gb: 24,  family: 'ada',      modal: 'L4',        runpod: 'NVIDIA L4' },
  { id: 'A10G',      vram_gb: 24,  family: 'ampere',   modal: 'A10G',      runpod: 'NVIDIA A10G' },
  { id: 'RTX4090',   vram_gb: 24,  family: 'ada',      modal: null,        runpod: 'NVIDIA GeForce RTX 4090' },
  { id: 'L40S',      vram_gb: 48,  family: 'ada',      modal: 'L40S',      runpod: 'NVIDIA L40S' },
  { id: 'A100-40GB', vram_gb: 40,  family: 'ampere',   modal: 'A100-40GB', runpod: 'NVIDIA A100 40GB PCIe' },
  { id: 'A100-80GB', vram_gb: 80,  family: 'ampere',   modal: 'A100-80GB', runpod: 'NVIDIA A100 80GB PCIe' },
  { id: 'H100',      vram_gb: 80,  family: 'hopper',   modal: 'H100',      runpod: 'NVIDIA H100 80GB HBM3' },
  { id: 'H200',      vram_gb: 141, family: 'hopper',   modal: 'H200',      runpod: 'NVIDIA H200' },
  { id: 'B200',      vram_gb: 180, family: 'blackwell',modal: 'B200',      runpod: 'NVIDIA B200' },
]);

// LoRA distill VRAM model (deterministic): base weights at bf16 + LoRA optimizer
// + activations. Rough but conservative - used to pick the smallest GPU that
// fits. Full-finetune is much larger; we expose a `full_finetune` multiplier.
export function estimateDistillVramGb({ params_b, full_finetune = false, batch_size = 1, seq_len = 2048, teacher_resident = false, teacher_params_b = 0 } = {}) {
  if (!_isFiniteNumber(params_b) || params_b <= 0) return null;
  // Student base weights bf16 (~2 bytes/param).
  let gb = params_b * 2;
  if (full_finetune) {
    // AdamW: weights + grad + 2 optimizer moments ~ 4x weights in fp32-ish terms.
    gb = params_b * 2 * 4;
  } else {
    // LoRA: base weights frozen + small adapter optimizer state + grad-ckpt.
    gb = params_b * 2 + Math.max(0.5, params_b * 0.15);
  }
  // Activations scale with batch*seq (grad-checkpointing keeps this modest).
  gb += (batch_size * seq_len / 2048) * Math.max(1, params_b * 0.08);
  // Teacher resident on the same GPU (on-policy / contrastive distill).
  if (teacher_resident && _isFiniteNumber(teacher_params_b) && teacher_params_b > 0) {
    gb += teacher_params_b * 0.55; // INT4-served teacher
  }
  return Math.round(gb * 10) / 10;
}

/**
 * Pick the smallest GPU in the catalog that fits the job's VRAM need (with a
 * 15% headroom). Honors an explicit opts.gpu override + a provider filter
 * (modal/runpod): a GPU not offered by the provider is skipped.
 *
 * @returns {{gpu:object|null, est_vram_gb:number|null, fits:boolean, reason:string}}
 */
export function selectGpuForJob(recipe = {}, opts = {}) {
  const provider = (opts.provider || 'runpod').toLowerCase();
  const params_b = _isFiniteNumber(opts.params_b) ? opts.params_b
    : (_isFiniteNumber(recipe.student_params_b) ? recipe.student_params_b
      : (_isFiniteNumber(recipe.params_b) ? recipe.params_b : null));
  const est = estimateDistillVramGb({
    params_b,
    full_finetune: Boolean(recipe.full_finetune || opts.full_finetune),
    batch_size: recipe.batch_size || opts.batch_size || 1,
    seq_len: recipe.max_seq_len || recipe.seq_len || opts.seq_len || 2048,
    teacher_resident: Boolean(recipe.teacher_resident || opts.teacher_resident),
    teacher_params_b: recipe.teacher_params_b || opts.teacher_params_b || 0,
  });

  // Explicit override.
  if (opts.gpu) {
    const g = GPU_CATALOG.find((x) => x.id.toLowerCase() === String(opts.gpu).toLowerCase());
    if (g) return { gpu: g, est_vram_gb: est, fits: est == null || est <= g.vram_gb * 0.85, reason: `explicit gpu ${g.id}` };
    return { gpu: null, est_vram_gb: est, fits: false, reason: `unknown gpu '${opts.gpu}'` };
  }

  if (est == null) {
    // Unknown size -> default to a roomy GPU rather than guessing small.
    const fallback = GPU_CATALOG.find((g) => g.id === 'A100-80GB' && g[provider]);
    return { gpu: fallback || null, est_vram_gb: null, fits: true, reason: 'unknown student size; defaulting to A100-80GB' };
  }

  const need = est / 0.85; // 15% headroom
  for (const g of GPU_CATALOG) {
    if (!g[provider]) continue; // provider does not offer this GPU id
    if (g.vram_gb >= need) {
      return { gpu: g, est_vram_gb: est, fits: true, reason: `smallest ${provider} GPU fitting ${est}GB need: ${g.id} (${g.vram_gb}GB)` };
    }
  }
  // Nothing fits -> return the largest the provider offers, flagged not-fitting.
  const largest = [...GPU_CATALOG].reverse().find((g) => g[provider]);
  return { gpu: largest || null, est_vram_gb: est, fits: false, reason: `no ${provider} GPU fits ${est}GB; largest is ${largest ? largest.id : 'none'}` };
}

/** Common environment the remote distill child needs (deterministic order). */
function _buildJobEnv({ recipe = {}, artifactOut = '/workspace/out', extraEnv = {} } = {}) {
  const env = {
    KOLM_DISTILL_RECIPE: recipe.id || recipe.name || 'inline',
    KOLM_OUT_DIR: artifactOut,
    KOLM_NONINTERACTIVE: '1',
  };
  if (recipe.student) env.KOLM_STUDENT = String(recipe.student);
  if (recipe.teacher) env.KOLM_TEACHER = String(recipe.teacher);
  if (recipe.mode) env.KOLM_DISTILL_MODE = String(recipe.mode);
  for (const [k, v] of Object.entries(extraEnv)) env[k] = String(v);
  return env;
}

/**
 * Build a Modal launch spec. Modal apps declare a function with a gpu= request,
 * an image, a timeout, and the command. This emits the descriptor the launcher
 * serializes into a `modal run` invocation (no network here).
 */
export function buildModalLaunchSpec({ recipe = {}, gpu, image = 'kolm/distill:latest', timeout_s = 3600, command, artifactOut = '/workspace/out', extraEnv = {} } = {}) {
  const sel = gpu && gpu.modal ? gpu : selectGpuForJob(recipe, { provider: 'modal', gpu: gpu && gpu.id }).gpu;
  const modalGpu = sel && sel.modal ? sel.modal : 'A100-80GB';
  const cmd = Array.isArray(command) && command.length ? command
    : ['python', '-m', 'workers.distill.distill', '--recipe', recipe.id || 'inline', '--out-dir', artifactOut];
  return Object.freeze({
    provider: 'modal',
    version: DISTILL_RUNNERS_VERSION,
    app_name: `kolm-distill-${(recipe.id || 'job').replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
    function: {
      gpu: modalGpu,
      image,
      timeout: Math.max(60, Math.floor(timeout_s)),
      command: cmd,
      env: _buildJobEnv({ recipe, artifactOut, extraEnv }),
    },
    gpu_id: sel ? sel.id : null,
    est_vram_gb: sel ? estimateDistillVramGb({ params_b: recipe.student_params_b || recipe.params_b }) : null,
  });
}

/**
 * Build a RunPod job launch spec. RunPod runs a one-shot container with a GPU
 * type id, an image, a command, env, and a disk request. Pure descriptor; the
 * launcher (or src/cloud/runpod.js) submits it.
 */
export function buildRunpodLaunchSpec({ recipe = {}, gpu, image = 'kolm/distill:latest', timeout_s = 3600, command, artifactOut = '/workspace/out', container_disk_gb = 50, volume_gb = 0, extraEnv = {} } = {}) {
  const sel = gpu && gpu.runpod ? gpu : selectGpuForJob(recipe, { provider: 'runpod', gpu: gpu && gpu.id }).gpu;
  const runpodGpu = sel && sel.runpod ? sel.runpod : 'NVIDIA A100 80GB PCIe';
  const cmd = Array.isArray(command) && command.length ? command
    : ['python', '-m', 'workers.distill.distill', '--recipe', recipe.id || 'inline', '--out-dir', artifactOut];
  return Object.freeze({
    provider: 'runpod',
    version: DISTILL_RUNNERS_VERSION,
    name: `kolm-distill-${(recipe.id || 'job').replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
    gpu_type_id: runpodGpu,
    gpu_count: _isFiniteNumber(recipe.gpu_count) ? recipe.gpu_count : 1,
    image_name: image,
    docker_args: cmd.join(' '),
    container_disk_in_gb: Math.max(20, Math.floor(container_disk_gb)),
    volume_in_gb: Math.max(0, Math.floor(volume_gb)),
    timeout_s: Math.max(60, Math.floor(timeout_s)),
    env: _buildJobEnv({ recipe, artifactOut, extraEnv }),
    gpu_id: sel ? sel.id : null,
    est_vram_gb: sel ? estimateDistillVramGb({ params_b: recipe.student_params_b || recipe.params_b }) : null,
  });
}

/**
 * Top-level planner: pick the provider + GPU and build the launch spec.
 *
 * @param {{recipe:object, provider?:'modal'|'runpod'|'auto', gpu?:string,
 *          image?:string, timeout_s?:number}} args
 * @returns {{ok:boolean, provider:string, gpu:object|null, fits:boolean,
 *            spec:object|null, reason:string, version:string}}
 */
export function planRemoteDistill({ recipe = {}, provider = 'auto', gpu, image, timeout_s = 3600, extraEnv = {} } = {}) {
  let prov = (provider || 'auto').toLowerCase();
  if (prov === 'auto') {
    // Prefer RunPod (broader catalog incl. 4090); Modal when explicitly Modal.
    prov = 'runpod';
  }
  if (prov !== 'modal' && prov !== 'runpod') {
    return { ok: false, provider: prov, gpu: null, fits: false, spec: null, reason: `unknown provider '${provider}'`, version: DISTILL_RUNNERS_VERSION };
  }
  const sel = selectGpuForJob(recipe, { provider: prov, gpu });
  const spec = prov === 'modal'
    ? buildModalLaunchSpec({ recipe, gpu: sel.gpu, image, timeout_s, extraEnv })
    : buildRunpodLaunchSpec({ recipe, gpu: sel.gpu, image, timeout_s, extraEnv });
  return {
    ok: Boolean(sel.gpu) && sel.fits,
    provider: prov,
    gpu: sel.gpu,
    fits: sel.fits,
    spec,
    reason: sel.reason,
    version: DISTILL_RUNNERS_VERSION,
  };
}

/** Multi-line dry-run banner for a remote distill plan. */
export function formatRemoteDistillReport(plan) {
  if (!plan || typeof plan !== 'object') return '(no plan)';
  return [
    `remote distill plan (${plan.version})`,
    `  provider   : ${plan.provider}`,
    `  gpu        : ${plan.gpu ? plan.gpu.id + ' (' + plan.gpu.vram_gb + 'GB)' : '(none)'}`,
    `  fits       : ${plan.fits}`,
    `  reason     : ${plan.reason}`,
    `  image      : ${plan.spec ? (plan.spec.image || plan.spec.image_name || plan.spec.function?.image) : ''}`,
  ].join('\n');
}

export default {
  DISTILL_RUNNERS_VERSION,
  GPU_CATALOG,
  estimateDistillVramGb,
  selectGpuForJob,
  buildModalLaunchSpec,
  buildRunpodLaunchSpec,
  planRemoteDistill,
  formatRemoteDistillReport,
};

// Tiny self-test for offline verification (node src/distill-runners/index.js --self-test).
const _entryArg = (process.argv[1] || '').replace(/\\/g, '/');
const _isEntry = _entryArg.endsWith('distill-runners/index.js') ||
  import.meta.url.replace(/\\/g, '/').endsWith(_entryArg);
if (_isEntry) {
  if (process.argv.includes('--self-test')) {
    const assert = (c, m) => { if (!c) { throw new Error('self-test fail: ' + m); } };
    const v = estimateDistillVramGb({ params_b: 7 });
    assert(v > 14 && v < 30, 'lora 7B vram in range, got ' + v);
    const sel = selectGpuForJob({ student_params_b: 7 }, { provider: 'runpod' });
    assert(sel.gpu && sel.fits, 'a runpod GPU fits 7B');
    const big = selectGpuForJob({ student_params_b: 400, full_finetune: true }, { provider: 'runpod' });
    assert(big.gpu, 'returns a GPU even for huge job');
    const modal = buildModalLaunchSpec({ recipe: { id: 'trinity-2000', student: 'Qwen/Qwen3-8B', student_params_b: 8 } });
    assert(modal.provider === 'modal' && modal.function.gpu, 'modal spec has a gpu');
    assert(modal.function.env.KOLM_STUDENT === 'Qwen/Qwen3-8B', 'modal env carries student');
    const rp = buildRunpodLaunchSpec({ recipe: { id: 'trinity-2000', student_params_b: 8 } });
    assert(rp.provider === 'runpod' && rp.gpu_type_id, 'runpod spec has gpu_type_id');
    const plan = planRemoteDistill({ recipe: { id: 'x', student_params_b: 14 }, provider: 'runpod' });
    assert(plan.ok && plan.spec, 'plan ok for 14B');
    const bad = planRemoteDistill({ recipe: {}, provider: 'nope' });
    assert(!bad.ok, 'unknown provider not ok');
    console.log('src/distill-runners/index.js self-test: OK');
  }
}
