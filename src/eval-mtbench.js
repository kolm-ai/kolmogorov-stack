// W758-3 - MT-Bench runner (honest scaffold).
//
// MT-Bench - Zheng et al. 2023 ("Judging LLM-as-a-Judge with MT-Bench and
// Chatbot Arena") - 80 multi-turn conversations across 8 categories.
// Source at github.com/lm-sys/FastChat (Apache-2.0); the official pack is
// shipped as a JSONL file (question.jsonl) where each row has 2 turns and
// an optional reference_answer for math/coding/reasoning categories.
//
// Scoring is GPT-4-as-judge: an external strong model rates each turn 1-10.
// We do NOT bundle a judge model. The caller MUST supply a `judge`
// callable; when missing we return an honest envelope. We NEVER silently
// fall through to length-as-score or any other proxy metric - that would
// fabricate authority for an unscored model.
//
// HONESTY CONTRACT (do not violate):
//   - Pack absent -> { ok:false, error:'bench_pack_not_local' }.
//   - runOnArtifact missing -> { ok:false, error:'runtime_not_wired' }.
//   - judge missing -> { ok:false, error:'no_judge_model_configured' }.
//   - We do NOT use response length, token count, or any heuristic as a
//     stand-in for the judge score. Either we score with the configured
//     judge or we surface honest absence.
//
// runOnArtifact: (artifact_path, prompt, conversation_history?) -> string.
// judge: (question_obj, turn_index, response, reference?) -> Promise<{score:number, rationale?:string}>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MTBENCH_VERSION = 'w758-v1';
export const MTBENCH_PACK_PATH_ENV = 'KOLM_MTBENCH_PACK';
export const MTBENCH_JUDGE_CMD_ENV = 'KOLM_MTBENCH_JUDGE_CMD';

// Canonical 8-category list per FastChat MT-Bench question.jsonl. Frozen
// so a re-order is a deliberate breaking change. Test pins both length=8
// AND the freeze.
export const MTBENCH_CATEGORIES = Object.freeze([
  'writing',
  'roleplay',
  'reasoning',
  'math',
  'coding',
  'extraction',
  'stem',
  'humanities',
]);

function _defaultPackDir() {
  const home = process.env.KOLM_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.kolm', 'bench-packs', 'mtbench');
}

// parseMTBenchJsonl(text) - JSONL parser. Each row: { question_id, category,
// turns: [t1, t2], reference?: [r1, r2] }. We tolerate either `question_id`
// or `id` (FastChat uses the former; some forks normalize the field name).
// Skips rows without 2 turns.
export function parseMTBenchJsonl(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); }
    catch (_e) { continue; }
    if (!row || typeof row !== 'object') continue;
    const turns = Array.isArray(row.turns) ? row.turns : null;
    if (!turns || turns.length < 2) continue;
    const qid = row.question_id != null ? row.question_id : row.id;
    if (qid == null) continue;
    const category = String(row.category || 'unknown').toLowerCase();
    const reference = Array.isArray(row.reference) ? row.reference.slice() : null;
    out.push({
      question_id: qid,
      category,
      turns: [String(turns[0] || ''), String(turns[1] || '')],
      reference,
    });
  }
  return out;
}

// loadMTBenchPack({pack_dir}) - returns rows OR honest envelope.
export function loadMTBenchPack({ pack_dir = null } = {}) {
  const dir = pack_dir || process.env[MTBENCH_PACK_PATH_ENV] || _defaultPackDir();
  const candidates = [
    path.join(dir, 'question.jsonl'),
    path.join(dir, 'mt-bench.jsonl'),
    path.join(dir, 'mtbench.jsonl'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    return {
      ok: false,
      error: 'bench_pack_not_local',
      hint:
        'MT-Bench pack not found. Download question.jsonl from ' +
        'github.com/lm-sys/FastChat (under fastchat/llm_judge/data/mt_bench/) ' +
        'and place it in ' + dir,
      expected_path: dir,
      version: MTBENCH_VERSION,
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
      version: MTBENCH_VERSION,
    };
  }
  const rows = parseMTBenchJsonl(text);
  if (rows.length === 0) {
    return {
      ok: false,
      error: 'bench_pack_empty',
      hint: 'MT-Bench pack file ' + found + ' has no parseable rows.',
      expected_path: dir,
      version: MTBENCH_VERSION,
    };
  }
  return { ok: true, rows, n: rows.length, path: found, version: MTBENCH_VERSION };
}

// runMTBench({artifact_path, pack_dir, runOnArtifact, judge, n_samples}).
//
// For each question we issue turn 1, capture the response, then issue
// turn 2 with the (turn1_question, turn1_response) history threaded
// through. runOnArtifact receives an optional third `conversation_history`
// arg shaped as [{role:'user', content}, {role:'assistant', content}, ...].
//
// Each (question, turn) is then handed to `judge` which returns a 1-10
// score. We surface the per-turn score, the mean per question, the mean
// per category, and the overall mean. by_question is capped at 16 entries.
//
// Honest envelopes for every missing dependency - see HONESTY CONTRACT.
export async function runMTBench({
  artifact_path = null,
  pack_dir = null,
  runOnArtifact = null,
  judge = null,
  n_samples = null,
} = {}) {
  if (typeof runOnArtifact !== 'function') {
    return {
      ok: false,
      error: 'runtime_not_wired',
      hint:
        'runMTBench requires a runOnArtifact callable. ' +
        'Wire src/artifact-runner.js from the route handler, or pass a callable in tests.',
      version: MTBENCH_VERSION,
    };
  }
  if (typeof judge !== 'function') {
    return {
      ok: false,
      error: 'no_judge_model_configured',
      hint:
        'MT-Bench requires GPT-4 or comparable judge to score responses 1-10. ' +
        'Set ' + MTBENCH_JUDGE_CMD_ENV + ' to a path that calls a judge model, ' +
        'or pass --judge-cmd. We refuse to fall through to length-as-score or ' +
        'any other heuristic - that would fabricate authority for an unscored model.',
      version: MTBENCH_VERSION,
    };
  }
  const pack = loadMTBenchPack({ pack_dir });
  if (!pack.ok) return pack;
  const rows = (typeof n_samples === 'number' && n_samples > 0)
    ? pack.rows.slice(0, n_samples)
    : pack.rows;
  if (rows.length === 0) {
    return { ok: false, error: 'bench_pack_empty', version: MTBENCH_VERSION };
  }
  const by_question = [];
  const by_category = {};
  let total_score = 0;
  let total_turns = 0;
  for (const row of rows) {
    const t1 = row.turns[0];
    const t2 = row.turns[1];
    const ref1 = row.reference ? row.reference[0] : null;
    const ref2 = row.reference ? row.reference[1] : null;
    // Turn 1.
    let resp1 = '';
    try { resp1 = await runOnArtifact(artifact_path, t1, []); }
    catch (e) { resp1 = ''; /* judge will see empty + score accordingly */ }
    let v1 = { score: 0, rationale: 'judge_invocation_error' };
    try { v1 = await judge(row, 0, resp1, ref1); }
    catch (e) {
      v1 = { score: 0, rationale: String(e && e.message || e) };
    }
    // Turn 2 - thread turn-1 history.
    const history = [
      { role: 'user', content: t1 },
      { role: 'assistant', content: resp1 },
    ];
    let resp2 = '';
    try { resp2 = await runOnArtifact(artifact_path, t2, history); }
    catch (e) { resp2 = ''; }
    let v2 = { score: 0, rationale: 'judge_invocation_error' };
    try { v2 = await judge(row, 1, resp2, ref2); }
    catch (e) {
      v2 = { score: 0, rationale: String(e && e.message || e) };
    }
    const score1 = _clampScore(v1 && v1.score);
    const score2 = _clampScore(v2 && v2.score);
    const turn_mean = Number(((score1 + score2) / 2).toFixed(4));
    total_score += score1 + score2;
    total_turns += 2;
    const cat = row.category || 'unknown';
    if (!by_category[cat]) by_category[cat] = { n: 0, sum: 0 };
    by_category[cat].n += 2;
    by_category[cat].sum += score1 + score2;
    if (by_question.length < 16) {
      by_question.push({
        question_id: row.question_id,
        category: cat,
        turn_1_score: score1,
        turn_2_score: score2,
        mean: turn_mean,
      });
    }
  }
  for (const k of Object.keys(by_category)) {
    const r = by_category[k];
    r.mean_score = r.n > 0 ? Number((r.sum / r.n).toFixed(4)) : 0;
  }
  const mean_score = total_turns > 0 ? Number((total_score / total_turns).toFixed(4)) : 0;
  return {
    ok: true,
    version: MTBENCH_VERSION,
    n: rows.length,
    mean_score,
    by_category,
    by_question,
    pack_path: pack.path || (pack_dir || process.env[MTBENCH_PACK_PATH_ENV] || _defaultPackDir()),
  };
}

function _clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 10) return 10;
  return Number(x.toFixed(4));
}
