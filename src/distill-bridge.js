// src/distill-bridge.js
//
// W364 - wires the two router distill endpoints (the specialist arm of
// /v1/distill/from-captures and /v1/specialists/auto-distill) to the
// real workers/distill/distill.mjs entrypoint.
//
// Behavior:
//   * spawns the worker as a detached child process (same pattern as the
//     W338 quantize worker fix)
//   * tracks job state in the src/jobs.js per-file registry so the
//     /v1/jobs/:id endpoint reflects status; appends worker stdout/stderr
//     to the registered log path
//   * the actual ML pipeline ('full' mode) only runs when the worker's
//     own --doctor reports python+torch ready. Otherwise it falls through
//     to 'collect' mode which still produces a manifest + training pairs.
//   * tenants always get { job_id, status, poll_url } - never 503.
//
// Configuration knobs (all optional):
//   KOLM_DISTILL_WORKER_CMD       full path to distill.mjs (default: workers/distill/distill.mjs)
//   KOLM_DISTILL_TEACHER          vendor:model passed to the worker
//                                  (default: 'anthropic:claude-opus-4-7' when
//                                  ANTHROPIC_API_KEY set; otherwise the worker
//                                  runs in --mode=stub)
//   KOLM_DISTILL_MAX_ROWS         cap teacher calls (default: 200)
//   KOLM_DISTILL_TMP_DIR          working dir for spec/seeds/out (default: os.tmpdir())
//   KOLM_DISTILL_SPAWN            override the spawn function (tests)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as jobs from './jobs.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_WORKER = path.join(ROOT, 'workers', 'distill', 'distill.mjs');

function pickTeacher() {
  if (process.env.KOLM_DISTILL_TEACHER) return process.env.KOLM_DISTILL_TEACHER;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic:claude-opus-4-7';
  if (process.env.OPENAI_API_KEY) return 'openai:gpt-4o-mini';
  return null;
}

// Materialize the in-memory captures into a seeds.jsonl + minimal spec.json
// so the existing worker entrypoint (which is file-driven) can consume them
// unchanged.
//
// W430 (audit P1-6) - preserve the 7 training-metadata fields that W411 P0 #2
// pinned in src/distill-pipeline.js:153-173 (source_type, tenant_id, approved,
// redaction_policy, holdout_only, fixed_output, event_id). The previous shape
// `{id, input, output}` stripped every audit-relevant attribute on its way to
// the worker, which silently undid the W411 metadata-preservation guarantee
// for any tenant whose distill ran through the bridge (the entire
// /v1/distill/from-captures + /v1/specialists/auto-distill surface). The
// worker's readSeeds() at workers/distill/distill.mjs:443 accepts any extra
// fields verbatim, so threading them through is safe - it just makes the
// receipt match the training input.
//
// W430 fail-closed parity - match the W411 P0 #8 holdout chokepoint at
// src/distill-pipeline.js:190-195: a row flagged holdout_only=true MUST
// never reach the worker as a training seed. The bridge's whole corpus IS
// the train split (there is no holdout/train split here - the bridge is the
// curated train side), so we strip holdout_only rows defensively before the
// JSONL write. Counted on the job record meta so the receipt is honest.
function writeWorkerInputs({ tmpDir, namespace, captures, baseModel }) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const seedsPath = path.join(tmpDir, 'seeds.jsonl');
  const specPath  = path.join(tmpDir, 'spec.json');
  const outDir    = path.join(tmpDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  let holdout_excluded = 0;
  const rows = captures.map((c, i) => {
    const input = c.variable_input || c.prompt || c.input || '';
    const output = c.response || c.output || '';
    // W430 - forward the 7 named metadata fields verbatim when present. We
    // never invent values; absent fields stay absent so the receipt reflects
    // ground truth. The worker treats extra fields as opaque (readSeeds is
    // shape-tolerant), and train.jsonl/holdout.jsonl carry them through.
    const row = {
      id: c.id || c.event_id || `cap_${i + 1}`,
      input,
      output,
    };
    if (c.event_id !== undefined) row.event_id = c.event_id;
    if (c.source_type !== undefined) row.source_type = c.source_type;
    if (c.tenant_id !== undefined) row.tenant_id = c.tenant_id;
    if (c.approved !== undefined) row.approved = c.approved;
    if (c.redaction_policy !== undefined) row.redaction_policy = c.redaction_policy;
    if (c.holdout_only !== undefined) row.holdout_only = c.holdout_only;
    if (c.fixed_output !== undefined) row.fixed_output = c.fixed_output;
    return row;
  }).filter((r) => {
    if (!r.input || !r.output) return false;
    if (r.holdout_only === true) { holdout_excluded += 1; return false; }
    return true;
  });
  fs.writeFileSync(seedsPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(specPath, JSON.stringify({
    job_id: `distill_${Date.now()}_${namespace}`,
    namespace,
    student_base: baseModel,
    system: '',
  }, null, 2));
  return { seedsPath, specPath, outDir, pair_count: rows.length, holdout_excluded };
}

// Public entrypoint. Spawns the worker, returns the job record (queued -> running).
export async function startDistillJob({
  tenant,
  namespace,
  captures,
  baseModel = 'Qwen/Qwen2.5-0.5B',
  targetSize = null,
  source = 'distill_bridge',
  spawnOverride = null,
  workerCmd = null,
} = {}) {
  if (!Array.isArray(captures) || captures.length === 0) {
    throw new Error('startDistillJob: captures required');
  }
  const worker = workerCmd
    || process.env.KOLM_DISTILL_WORKER_CMD
    || DEFAULT_WORKER;
  const tmpRoot = process.env.KOLM_DISTILL_TMP_DIR || os.tmpdir();
  const tmpDir = path.join(tmpRoot, `kolm-distill-${crypto.randomBytes(6).toString('hex')}`);
  const teacher = pickTeacher();
  // Mode picks: 'stub' when no teacher key (still produces a manifest),
  // 'collect' when a teacher is configured (real teacher calls + pair
  // collection), 'full' when KOLM_DISTILL_FULL=1 (and python+torch ready
  // - the worker self-degrades to collect if not).
  let mode;
  if (process.env.KOLM_DISTILL_FULL === '1' && teacher) mode = 'full';
  else if (teacher) mode = 'collect';
  else mode = 'stub';

  const { seedsPath, specPath, outDir, pair_count, holdout_excluded } = writeWorkerInputs({
    tmpDir, namespace, captures, baseModel,
  });

  // Register the job FIRST so the log path exists before we spawn.
  // W430 - surface holdout_excluded on the job record so the receipt audit
  // can prove the W411 P0 #8 chokepoint fired even on the bridge path.
  const rec = jobs.create({
    kind: 'distill',
    pid: 0,
    meta: {
      tenant,
      namespace,
      source,
      base_model: baseModel,
      target_size: targetSize,
      mode,
      teacher: teacher || null,
      pair_count,
      holdout_excluded: holdout_excluded || 0,
      tmp_dir: tmpDir,
      out_dir: outDir,
    },
  });

  // Spawn the worker. detached:true + closed stdin so the child outlives
  // the request lifecycle. Stdout/stderr piped into the job's log path.
  const args = [
    worker,
    `--spec=${specPath}`,
    `--seeds=${seedsPath}`,
    `--out=${outDir}`,
    `--mode=${mode}`,
    `--student-base=${baseModel}`,
    '--allow-unknown-student-base',
    `--max-rows=${Number(process.env.KOLM_DISTILL_MAX_ROWS || 200)}`,
  ];
  if (teacher) args.push(`--teacher=${teacher}`);

  const logOut = fs.openSync(rec.log_path, 'a');
  const realSpawn = spawnOverride || process.env.KOLM_DISTILL_SPAWN || spawn;
  const spawnFn = typeof realSpawn === 'function' ? realSpawn : spawn;
  let child;
  try {
    child = spawnFn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logOut, logOut],
      env: { ...process.env, KOLM_JOB_ID: rec.id },
      windowsHide: true,
    });
  } catch (e) {
    fs.closeSync(logOut);
    jobs.update(rec.id, { status: 'failed', meta: { ...rec.meta, error: String(e.message || e) } });
    throw e;
  }
  // Some test doubles return a plain object; only call detach helpers
  // when they exist on the real ChildProcess.
  try { fs.closeSync(logOut); } catch (_) {} // deliberate: cleanup
  if (typeof child.unref === 'function') child.unref();
  const pid = child.pid || 0;
  jobs.update(rec.id, { pid, status: 'running' });
  // Background watcher: when the child exits, mark the job completed/failed.
  if (typeof child.on === 'function') {
    child.on('exit', (code, signal) => {
      try {
        const status = code === 0 ? 'completed' : 'failed';
        const patch = {
          status,
          meta: { ...rec.meta, exit_code: code, signal: signal || null, finished_at: new Date().toISOString() },
        };
        // Best-effort manifest hand-off so the job record points at the artifact.
        try {
          const manifestPath = path.join(outDir, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            patch.meta.manifest_path = manifestPath;
          }
        } catch (_) {} // deliberate: cleanup
        jobs.update(rec.id, patch);
      } catch (_) {} // deliberate: cleanup
    });
  }
  return { ...rec, pid, status: 'running' };
}

export default { startDistillJob };
