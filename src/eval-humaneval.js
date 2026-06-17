// W758-2 - HumanEval runner (honest scaffold).
//
// HumanEval - Chen et al. 2021 ("Evaluating Large Language Models Trained
// on Code") - 164 Python programming problems, each ships a function
// signature + docstring + canonical solution + unit tests. Source at
// huggingface.co/datasets/openai_humaneval (MIT). pass@k is the standard
// metric: fraction of problems for which the model's k samples pass all
// unit tests.
//
// HONESTY CONTRACT (do not violate):
//   - This module does NOT bundle the HumanEval dataset. Pack is loaded
//     from disk per loadHumanEvalPack; missing pack returns honest
//     { ok:false, error:'bench_pack_not_local' }.
//   - This module does NOT execute generated code in the Node main
//     process. Untrusted code from an LLM is a sandbox-escape risk. The
//     caller MUST supply a `sandbox_cmd` callable that spawns a separate
//     process (firejail, docker, gvisor, or the official openai_humaneval
//     execution.py sandbox). When sandbox_cmd is null we return honest
//     { ok:false, error:'no_code_sandbox_configured' } and refuse to
//     score. NEVER fall through to in-process code execution.
//   - pass@1 is the only metric we surface - pass@10/pass@100 require
//     multiple samples and a temperature > 0 generation policy; that's
//     out of scope until W762 (sample-once-per-problem at temp=0).
//
// runOnArtifact: (artifact_path, prompt) -> string (sync or async).
// sandbox_cmd: (code:string, test:string, entry_point:string) -> Promise<{passed:boolean, stderr?:string}>
//
// Tenant safety: writes nothing to event store; tenant scoping is the
// route layer's job.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HUMANEVAL_VERSION = 'w758-v2';
export const HUMANEVAL_PACK_PATH_ENV = 'KOLM_HUMANEVAL_PACK';
export const HUMANEVAL_SANDBOX_CMD_ENV = 'KOLM_HUMANEVAL_SANDBOX_CMD';
export const HUMANEVAL_DATASET_REVISION_ENV = 'KOLM_HUMANEVAL_REVISION';
export const HUMANEVAL_DATASET_ID = 'openai_humaneval';
export const HUMANEVAL_PROMPT_TEMPLATE = 'humaneval_prompt_only_v1';
export const HUMANEVAL_SCORER_ID = 'openai_humaneval_pass_at_1_sandbox_v1';
export const HUMANEVAL_LIMITS = Object.freeze({
  MAX_PACK_BYTES: 25 * 1024 * 1024,
  MAX_JSONL_LINES: 2000,
  MAX_TASKS: 164,
  MAX_TASK_ID_CHARS: 128,
  MAX_ENTRY_POINT_CHARS: 128,
  MAX_PROMPT_CHARS: 20000,
  MAX_SOLUTION_CHARS: 20000,
  MAX_TEST_CHARS: 50000,
  MAX_CODE_CHARS: 200000,
  MAX_ERROR_CHARS: 512,
  MAX_BY_TASK: 16,
  MAX_PATH_CHARS: 2048,
  DEFAULT_GENERATION_TIMEOUT_MS: 60000,
  DEFAULT_SANDBOX_TIMEOUT_MS: 30000,
  MAX_TIMEOUT_MS: 300000,
});

const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const PACK_NAMES = Object.freeze([
  'HumanEval.jsonl',
  'human-eval.jsonl',
  'human-eval-v2.jsonl',
]);

function _defaultPackDir() {
  const home = process.env.KOLM_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.kolm', 'bench-packs', 'humaneval');
}

function _sha256Hex(value) {
  return crypto.createHash('sha256').update(value == null ? '' : value).digest('hex');
}

function _stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => _stableJson(v)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + _stableJson(value[k])).join(',') + '}';
}

function _boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function _clipText(value, max, { collapseControls = false } = {}) {
  if (typeof value !== 'string') return '';
  const cleaned = collapseControls ? value.replace(CONTROL_RE, ' ') : value;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function _cleanEnvelopeText(value, max = HUMANEVAL_LIMITS.MAX_ERROR_CHARS) {
  return _clipText(String(value == null ? '' : value), max, { collapseControls: true }).trim();
}

function _requiredCleanId(value, max) {
  if (typeof value !== 'string') return null;
  const clean = _cleanEnvelopeText(value, max);
  return clean ? clean : null;
}

function _resolvePackDir(packDir) {
  const raw = packDir || process.env[HUMANEVAL_PACK_PATH_ENV] || _defaultPackDir();
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'bench_pack_invalid_path', detail: 'pack_dir must be a non-empty string' };
  }
  if (raw.length > HUMANEVAL_LIMITS.MAX_PATH_CHARS || CONTROL_RE.test(raw)) {
    CONTROL_RE.lastIndex = 0;
    return { ok: false, error: 'bench_pack_invalid_path', detail: 'pack_dir contains control characters or is too long' };
  }
  return { ok: true, dir: path.resolve(raw) };
}

function _findPackFile(dir) {
  for (const name of PACK_NAMES) {
    const candidate = path.join(dir, name);
    let lst;
    try { lst = fs.lstatSync(candidate); }
    catch (_e) { continue; }
    if (lst.isSymbolicLink()) {
      return { ok: false, error: 'bench_pack_symlink_rejected', path: candidate };
    }
    if (!lst.isFile()) {
      return { ok: false, error: 'bench_pack_not_regular_file', path: candidate };
    }
    let stat;
    try { stat = fs.statSync(candidate); }
    catch (e) {
      return { ok: false, error: 'bench_pack_read_error', path: candidate, detail: String(e && e.message || e) };
    }
    return { ok: true, path: candidate, stat };
  }
  return { ok: false, error: 'bench_pack_not_local' };
}

function _datasetRevision(explicitRevision = null) {
  const raw = explicitRevision || process.env[HUMANEVAL_DATASET_REVISION_ENV] || 'local';
  return _cleanEnvelopeText(String(raw || 'local'), 128) || 'local';
}

function _promptTemplateSha() {
  return _sha256Hex(HUMANEVAL_PROMPT_TEMPLATE);
}

function _taskManifestSha(rows) {
  return _sha256Hex(_stableJson(rows.map((row) => ({
    task_id: row.task_id,
    task_sha256: row.task_sha256,
  }))));
}

class HumanEvalTimeout extends Error {
  constructor(stage, timeoutMs) {
    super(`${stage} timed out after ${timeoutMs}ms`);
    this.stage = stage;
    this.timeout_ms = timeoutMs;
  }
}

async function _withTimeout(fn, timeoutMs, stage) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HumanEvalTimeout(stage, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// parseHumanEvalJsonl(text) - bounded JSONL parser (one JSON object per line).
// Returns rows with the standard HumanEval schema plus per-row hashes:
// { task_id, prompt, canonical_solution, test, entry_point, *_sha256 }.
// Skips blank lines and rows missing any required field.
export function parseHumanEvalJsonl(text, opts = {}) {
  if (typeof text !== 'string') return [];
  const out = [];
  const maxLines = _boundedInt(opts.max_lines, HUMANEVAL_LIMITS.MAX_JSONL_LINES, 1, HUMANEVAL_LIMITS.MAX_JSONL_LINES);
  const maxTasks = _boundedInt(opts.max_tasks, HUMANEVAL_LIMITS.MAX_TASKS, 1, HUMANEVAL_LIMITS.MAX_JSONL_LINES);
  const cappedText = text.length > HUMANEVAL_LIMITS.MAX_PACK_BYTES
    ? text.slice(0, HUMANEVAL_LIMITS.MAX_PACK_BYTES)
    : text;
  const lines = cappedText.split(/\r?\n/).slice(0, maxLines);
  for (const line of lines) {
    if (out.length >= maxTasks) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); }
    catch (_e) { continue; }
    if (!row || typeof row !== 'object') continue;
    const taskId = _requiredCleanId(row.task_id, HUMANEVAL_LIMITS.MAX_TASK_ID_CHARS);
    const entryPoint = _requiredCleanId(row.entry_point, HUMANEVAL_LIMITS.MAX_ENTRY_POINT_CHARS);
    if (!taskId || !entryPoint) continue;
    if (typeof row.prompt !== 'string') continue;
    if (typeof row.test !== 'string') continue;
    const prompt = _clipText(row.prompt, HUMANEVAL_LIMITS.MAX_PROMPT_CHARS);
    const test = _clipText(row.test, HUMANEVAL_LIMITS.MAX_TEST_CHARS);
    const canonicalSolution = typeof row.canonical_solution === 'string'
      ? _clipText(row.canonical_solution, HUMANEVAL_LIMITS.MAX_SOLUTION_CHARS)
      : '';
    const promptSha = _sha256Hex(prompt);
    const testSha = _sha256Hex(test);
    const canonicalSha = _sha256Hex(canonicalSolution);
    const taskSha = _sha256Hex(_stableJson({
      task_id: taskId,
      entry_point: entryPoint,
      prompt_sha256: promptSha,
      test_sha256: testSha,
      canonical_solution_sha256: canonicalSha,
    }));
    out.push({
      task_id: taskId,
      prompt,
      canonical_solution: canonicalSolution,
      test,
      entry_point: entryPoint,
      prompt_sha256: promptSha,
      test_sha256: testSha,
      canonical_solution_sha256: canonicalSha,
      task_sha256: taskSha,
    });
  }
  return out;
}

// loadHumanEvalPack({pack_dir}) - looks for HumanEval.jsonl in pack_dir.
// Returns { ok:true, rows, n } OR honest { ok:false, error:'bench_pack_not_local' }.
export function loadHumanEvalPack({ pack_dir = null, dataset_revision = null } = {}) {
  const resolved = _resolvePackDir(pack_dir);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
      detail: resolved.detail,
      version: HUMANEVAL_VERSION,
      dataset_id: HUMANEVAL_DATASET_ID,
    };
  }
  const dir = resolved.dir;
  // Accept either the canonical HumanEval.jsonl or common mirror filenames.
  // First matching regular file wins; symlinked packs are rejected to keep
  // local benchmark evidence bound to the configured pack directory.
  const found = _findPackFile(dir);
  if (!found.ok) {
    if (found.error !== 'bench_pack_not_local') {
      return {
        ok: false,
        error: found.error,
        detail: found.detail || null,
        expected_path: dir,
        pack_path: found.path || null,
        version: HUMANEVAL_VERSION,
        dataset_id: HUMANEVAL_DATASET_ID,
      };
    }
    return {
      ok: false,
      error: 'bench_pack_not_local',
      hint:
        'HumanEval pack not found. Download from huggingface.co/datasets/openai_humaneval ' +
        '(or github.com/openai/human-eval) and place HumanEval.jsonl in ' + dir,
      expected_path: dir,
      version: HUMANEVAL_VERSION,
      dataset_id: HUMANEVAL_DATASET_ID,
    };
  }
  if (found.stat.size > HUMANEVAL_LIMITS.MAX_PACK_BYTES) {
    return {
      ok: false,
      error: 'bench_pack_too_large',
      detail: `HumanEval pack exceeds ${HUMANEVAL_LIMITS.MAX_PACK_BYTES} bytes`,
      expected_path: dir,
      pack_path: found.path,
      pack_bytes: found.stat.size,
      version: HUMANEVAL_VERSION,
      dataset_id: HUMANEVAL_DATASET_ID,
    };
  }
  let buf;
  try { buf = fs.readFileSync(found.path); }
  catch (e) {
    return {
      ok: false,
      error: 'bench_pack_read_error',
      detail: _cleanEnvelopeText(e && e.message || e),
      expected_path: dir,
      pack_path: found.path,
      version: HUMANEVAL_VERSION,
      dataset_id: HUMANEVAL_DATASET_ID,
    };
  }
  const text = buf.toString('utf8');
  const rows = parseHumanEvalJsonl(text);
  if (rows.length === 0) {
    return {
      ok: false,
      error: 'bench_pack_empty',
      hint: 'HumanEval pack file found at ' + found.path + ' but no parseable rows.',
      expected_path: dir,
      pack_path: found.path,
      version: HUMANEVAL_VERSION,
      dataset_id: HUMANEVAL_DATASET_ID,
    };
  }
  return {
    ok: true,
    rows,
    n: rows.length,
    path: found.path,
    version: HUMANEVAL_VERSION,
    dataset_id: HUMANEVAL_DATASET_ID,
    dataset_revision: _datasetRevision(dataset_revision),
    pack_sha256: _sha256Hex(buf),
    pack_bytes: found.stat.size,
    task_manifest_sha256: _taskManifestSha(rows),
    prompt_template: HUMANEVAL_PROMPT_TEMPLATE,
    prompt_template_sha256: _promptTemplateSha(),
    scorer_id: HUMANEVAL_SCORER_ID,
    scorer_version: HUMANEVAL_VERSION,
    limits: {
      max_tasks: HUMANEVAL_LIMITS.MAX_TASKS,
      max_code_chars: HUMANEVAL_LIMITS.MAX_CODE_CHARS,
      max_pack_bytes: HUMANEVAL_LIMITS.MAX_PACK_BYTES,
    },
  };
}

// _extractCode(raw) - pull out python code from a model response. Models
// commonly wrap in ```python ... ``` fences; we strip those. If no fence
// is present we use the raw text. We do NOT try to repair syntax - that
// would mask real model errors.
export function extractCodeFromResponse(raw, opts = {}) {
  if (typeof raw !== 'string') return '';
  const maxCodeChars = _boundedInt(opts.max_code_chars, HUMANEVAL_LIMITS.MAX_CODE_CHARS, 1, HUMANEVAL_LIMITS.MAX_CODE_CHARS);
  const scanChars = Math.min(raw.length, Math.max(8192, maxCodeChars * 4));
  const cappedRaw = raw.slice(0, scanChars);
  // Prefer the first fenced block when present.
  const fence = cappedRaw.match(/```(?:python|py)?\s*\n([\s\S]*?)\n```/i);
  return _clipText(fence ? fence[1] : cappedRaw, maxCodeChars);
}

// runHumanEval({artifact_path, pack_dir, runOnArtifact, n_samples, sandbox_cmd}).
//
// Honest fail modes:
//   - runOnArtifact missing -> { ok:false, error:'runtime_not_wired' }
//   - sandbox_cmd missing   -> { ok:false, error:'no_code_sandbox_configured' }
//   - pack missing          -> { ok:false, error:'bench_pack_not_local' }
//
// On success: { ok:true, version, n, pass_at_1, passed, by_task[] } where
// by_task is capped to first 16 entries so the response stays small.
export async function runHumanEval({
  artifact_path = null,
  pack_dir = null,
  runOnArtifact = null,
  n_samples = null,
  sandbox_cmd = null,
  dataset_revision = null,
  run_seed = null,
  generation_timeout_ms = null,
  sandbox_timeout_ms = null,
} = {}) {
  if (typeof runOnArtifact !== 'function') {
    return {
      ok: false,
      error: 'runtime_not_wired',
      hint:
        'runHumanEval requires a runOnArtifact callable (artifact_path, prompt) -> string. ' +
        'Wire src/artifact-runner.js from the route handler, or pass a callable in tests.',
      version: HUMANEVAL_VERSION,
    };
  }
  if (typeof sandbox_cmd !== 'function') {
    return {
      ok: false,
      error: 'no_code_sandbox_configured',
      hint:
        'HumanEval scores generated code by EXECUTING it against unit tests. ' +
        'Set ' + HUMANEVAL_SANDBOX_CMD_ENV + ' to a path that spawns an isolated ' +
        'process (firejail / docker / gvisor), or pass --sandbox-cmd. Running ' +
        'untrusted LLM code in the Node main process is a sandbox-escape risk; ' +
        'we refuse to score without an external sandbox.',
      version: HUMANEVAL_VERSION,
    };
  }
  const pack = loadHumanEvalPack({ pack_dir, dataset_revision });
  if (!pack.ok) return pack;
  const maxRows = Math.min(pack.rows.length, HUMANEVAL_LIMITS.MAX_TASKS);
  const wantRows = (typeof n_samples === 'number' && n_samples > 0)
    ? _boundedInt(n_samples, maxRows, 1, maxRows)
    : maxRows;
  const rows = pack.rows.slice(0, wantRows);
  if (rows.length === 0) {
    return { ok: false, error: 'bench_pack_empty', version: HUMANEVAL_VERSION };
  }
  const generationTimeout = _boundedInt(
    generation_timeout_ms,
    HUMANEVAL_LIMITS.DEFAULT_GENERATION_TIMEOUT_MS,
    1,
    HUMANEVAL_LIMITS.MAX_TIMEOUT_MS,
  );
  const sandboxTimeout = _boundedInt(
    sandbox_timeout_ms,
    HUMANEVAL_LIMITS.DEFAULT_SANDBOX_TIMEOUT_MS,
    1,
    HUMANEVAL_LIMITS.MAX_TIMEOUT_MS,
  );
  const taskManifestSha = _taskManifestSha(rows);
  const normalizedSeed = run_seed == null ? 'temp0-single-sample' : _cleanEnvelopeText(run_seed, 128);
  const run_manifest = {
    dataset_id: pack.dataset_id,
    dataset_revision: pack.dataset_revision,
    pack_sha256: pack.pack_sha256,
    pack_bytes: pack.pack_bytes,
    task_count: rows.length,
    task_manifest_sha256: taskManifestSha,
    prompt_template: HUMANEVAL_PROMPT_TEMPLATE,
    prompt_template_sha256: _promptTemplateSha(),
    scorer_id: HUMANEVAL_SCORER_ID,
    scorer_version: HUMANEVAL_VERSION,
    pass_metric: 'pass@1',
    generation_policy: 'single_sample_temperature_0',
    run_seed: normalizedSeed,
    generation_timeout_ms: generationTimeout,
    sandbox_timeout_ms: sandboxTimeout,
    response_cap: HUMANEVAL_LIMITS.MAX_BY_TASK,
  };
  const run_id = 'humaneval_' + _sha256Hex(_stableJson({
    artifact_ref_sha256: artifact_path == null ? null : _sha256Hex(String(artifact_path)),
    run_manifest,
  })).slice(0, 20);
  let passed = 0;
  const by_task = [];
  for (const row of rows) {
    let raw;
    try {
      raw = await _withTimeout(
        () => runOnArtifact(artifact_path, row.prompt, {
          task_id: row.task_id,
          prompt_sha256: row.prompt_sha256,
          run_id,
        }),
        generationTimeout,
        'generation_timeout',
      );
    }
    catch (e) {
      if (by_task.length < HUMANEVAL_LIMITS.MAX_BY_TASK) {
        by_task.push({
          task_id: row.task_id,
          task_sha256: row.task_sha256,
          passed: false,
          stage: e instanceof HumanEvalTimeout ? e.stage : 'generation',
          error: _cleanEnvelopeText(e && e.message || e),
        });
      }
      continue;
    }
    const code = extractCodeFromResponse(raw);
    const codeSha = _sha256Hex(code);
    // The sandbox composes (code + '\n' + test + '\n' + check(<entry_point>)).
    // Sandbox is responsible for the actual exec env - Node side never
    // imports or executes the result.
    let verdict;
    try {
      verdict = await _withTimeout(
        () => sandbox_cmd(code, row.test, row.entry_point, {
          task_id: row.task_id,
          code_sha256: codeSha,
          test_sha256: row.test_sha256,
          sandbox_timeout_ms: sandboxTimeout,
          run_id,
        }),
        sandboxTimeout,
        'sandbox_timeout',
      );
    }
    catch (e) {
      verdict = {
        passed: false,
        stderr: _cleanEnvelopeText(e && e.message || e),
        stage: e instanceof HumanEvalTimeout ? e.stage : 'sandbox_invocation',
      };
    }
    const ok = !!(verdict && verdict.passed === true);
    if (ok) passed += 1;
    if (by_task.length < HUMANEVAL_LIMITS.MAX_BY_TASK) {
      by_task.push({
        task_id: row.task_id,
        task_sha256: row.task_sha256,
        prompt_sha256: row.prompt_sha256,
        test_sha256: row.test_sha256,
        code_sha256: codeSha,
        code_chars: code.length,
        passed: ok,
        stage: ok ? 'pass' : (verdict && verdict.stage) || 'test_fail',
        stderr: verdict && verdict.stderr ? _cleanEnvelopeText(verdict.stderr) : null,
      });
    }
  }
  const pass_at_1 = rows.length > 0 ? Number((passed / rows.length).toFixed(4)) : 0;
  const result = {
    ok: true,
    version: HUMANEVAL_VERSION,
    run_id,
    n: rows.length,
    passed,
    pass_at_1,
    by_task,
    pack_path: pack.path || (pack_dir || process.env[HUMANEVAL_PACK_PATH_ENV] || _defaultPackDir()),
    pack_sha256: pack.pack_sha256,
    pack_bytes: pack.pack_bytes,
    dataset_id: pack.dataset_id,
    dataset_revision: pack.dataset_revision,
    task_manifest_sha256: taskManifestSha,
    prompt_template_sha256: run_manifest.prompt_template_sha256,
    scorer_id: HUMANEVAL_SCORER_ID,
    scorer_version: HUMANEVAL_VERSION,
    run_manifest,
  };
  result.result_sha256 = _sha256Hex(_stableJson({
    version: result.version,
    run_id: result.run_id,
    n: result.n,
    passed: result.passed,
    pass_at_1: result.pass_at_1,
    by_task: result.by_task,
    run_manifest: result.run_manifest,
  }));
  return result;
}
