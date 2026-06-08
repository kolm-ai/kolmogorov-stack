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
//     score. NEVER fall through to eval().
//   - pass@1 is the only metric we surface - pass@10/pass@100 require
//     multiple samples and a temperature > 0 generation policy; that's
//     out of scope until W762 (sample-once-per-problem at temp=0).
//
// runOnArtifact: (artifact_path, prompt) -> string (sync or async).
// sandbox_cmd: (code:string, test:string, entry_point:string) -> Promise<{passed:boolean, stderr?:string}>
//
// Tenant safety: writes nothing to event store; tenant scoping is the
// route layer's job.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HUMANEVAL_VERSION = 'w758-v1';
export const HUMANEVAL_PACK_PATH_ENV = 'KOLM_HUMANEVAL_PACK';
export const HUMANEVAL_SANDBOX_CMD_ENV = 'KOLM_HUMANEVAL_SANDBOX_CMD';

function _defaultPackDir() {
  const home = process.env.KOLM_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.kolm', 'bench-packs', 'humaneval');
}

// parseHumanEvalJsonl(text) - JSONL parser (one JSON object per line).
// Returns rows with the standard HumanEval schema: { task_id, prompt,
// canonical_solution, test, entry_point }. Skips blank lines and rows
// missing any required field.
export function parseHumanEvalJsonl(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); }
    catch (_e) { continue; }
    if (!row || typeof row !== 'object') continue;
    if (typeof row.task_id !== 'string') continue;
    if (typeof row.prompt !== 'string') continue;
    if (typeof row.test !== 'string') continue;
    if (typeof row.entry_point !== 'string') continue;
    out.push({
      task_id: row.task_id,
      prompt: row.prompt,
      canonical_solution: typeof row.canonical_solution === 'string' ? row.canonical_solution : '',
      test: row.test,
      entry_point: row.entry_point,
    });
  }
  return out;
}

// loadHumanEvalPack({pack_dir}) - looks for HumanEval.jsonl in pack_dir.
// Returns { ok:true, rows, n } OR honest { ok:false, error:'bench_pack_not_local' }.
export function loadHumanEvalPack({ pack_dir = null } = {}) {
  const dir = pack_dir || process.env[HUMANEVAL_PACK_PATH_ENV] || _defaultPackDir();
  // Accept either the canonical HumanEval.jsonl or human-eval-v2.jsonl
  // filename (the openai/human-eval repo ships the former; some mirrors
  // include the v2 suffix). First match wins.
  const candidates = [
    path.join(dir, 'HumanEval.jsonl'),
    path.join(dir, 'human-eval.jsonl'),
    path.join(dir, 'human-eval-v2.jsonl'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    return {
      ok: false,
      error: 'bench_pack_not_local',
      hint:
        'HumanEval pack not found. Download from huggingface.co/datasets/openai_humaneval ' +
        '(or github.com/openai/human-eval) and place HumanEval.jsonl in ' + dir,
      expected_path: dir,
      version: HUMANEVAL_VERSION,
    };
  }
  let text;
  try { text = fs.readFileSync(found, 'utf8'); }
  catch (e) {
    return {
      ok: false,
      error: 'bench_pack_read_error',
      detail: String(e && e.message || e),
      expected_path: dir,
      version: HUMANEVAL_VERSION,
    };
  }
  const rows = parseHumanEvalJsonl(text);
  if (rows.length === 0) {
    return {
      ok: false,
      error: 'bench_pack_empty',
      hint: 'HumanEval pack file found at ' + found + ' but no parseable rows.',
      expected_path: dir,
      version: HUMANEVAL_VERSION,
    };
  }
  return { ok: true, rows, n: rows.length, path: found, version: HUMANEVAL_VERSION };
}

// _extractCode(raw) - pull out python code from a model response. Models
// commonly wrap in ```python ... ``` fences; we strip those. If no fence
// is present we use the raw text. We do NOT try to repair syntax - that
// would mask real model errors.
export function extractCodeFromResponse(raw) {
  if (typeof raw !== 'string') return '';
  // Prefer the first fenced block when present.
  const fence = raw.match(/```(?:python|py)?\s*\n([\s\S]*?)\n```/i);
  if (fence) return fence[1];
  return raw;
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
  const pack = loadHumanEvalPack({ pack_dir });
  if (!pack.ok) return pack;
  const rows = (typeof n_samples === 'number' && n_samples > 0)
    ? pack.rows.slice(0, n_samples)
    : pack.rows;
  if (rows.length === 0) {
    return { ok: false, error: 'bench_pack_empty', version: HUMANEVAL_VERSION };
  }
  let passed = 0;
  const by_task = [];
  for (const row of rows) {
    let raw;
    try { raw = await runOnArtifact(artifact_path, row.prompt); }
    catch (e) {
      if (by_task.length < 16) {
        by_task.push({
          task_id: row.task_id,
          passed: false,
          stage: 'generation',
          error: String(e && e.message || e),
        });
      }
      continue;
    }
    const code = extractCodeFromResponse(raw);
    // The sandbox composes (code + '\n' + test + '\n' + check(<entry_point>)).
    // Sandbox is responsible for the actual exec env - Node side never
    // imports or eval()s the result.
    let verdict;
    try { verdict = await sandbox_cmd(code, row.test, row.entry_point); }
    catch (e) {
      verdict = { passed: false, stderr: String(e && e.message || e), stage: 'sandbox_invocation' };
    }
    const ok = !!(verdict && verdict.passed === true);
    if (ok) passed += 1;
    if (by_task.length < 16) {
      by_task.push({
        task_id: row.task_id,
        passed: ok,
        stage: ok ? 'pass' : (verdict && verdict.stage) || 'test_fail',
        stderr: verdict && verdict.stderr ? String(verdict.stderr).slice(0, 400) : null,
      });
    }
  }
  const pass_at_1 = rows.length > 0 ? Number((passed / rows.length).toFixed(4)) : 0;
  return {
    ok: true,
    version: HUMANEVAL_VERSION,
    n: rows.length,
    passed,
    pass_at_1,
    by_task,
    pack_path: pack.path || (pack_dir || process.env[HUMANEVAL_PACK_PATH_ENV] || _defaultPackDir()),
  };
}
