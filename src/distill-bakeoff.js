// src/distill-bakeoff.js
//
// W972 - Distillation method bake-off harness.
//
// The trainer stack can run SeqKD, ROPD, GAD, GKD, BoN/rejection sampling, and
// related variants, but the product still needed a common holdout comparison
// envelope: same rows, same judge, same scoring semantics, privacy-safe output.
// This module is the local measurement layer. It can either:
//   - read precomputed row.method_outputs / row.outputs values, or
//   - call an injected runMethod({method,row,index}) seam.
//
// It never calls a model provider by itself and never returns raw prompts or
// raw generations. Row-level evidence is hashes + scores only.

import crypto from 'node:crypto';

export const DISTILL_BAKEOFF_VERSION = 'w972-distill-method-bakeoff-v1';
export const DEFAULT_DISTILL_METHODS = Object.freeze(['seqkd', 'ropd', 'gad']);
export const DISTILL_BAKEOFF_LIMITS = Object.freeze({
  max_rows: 256,
  max_methods: 8,
  max_text_chars: 20000,
  max_method_chars: 64,
  max_id_chars: 160,
});

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cleanText(value, max = DISTILL_BAKEOFF_LIMITS.max_text_chars) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max) : s;
}

function cleanId(value, max = DISTILL_BAKEOFF_LIMITS.max_id_chars) {
  const raw = cleanText(value, max);
  if (!raw || UNSAFE_KEYS.has(raw)) return null;
  const id = raw.replace(/[^\w:.-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!id || UNSAFE_KEYS.has(id)) return null;
  return id;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function tokenize(text) {
  return cleanText(text).toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function tokenJaccard(a, b) {
  const aa = new Set(tokenize(a));
  const bb = new Set(tokenize(b));
  if (aa.size === 0 && bb.size === 0) return 1;
  if (aa.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const tok of aa) if (bb.has(tok)) inter += 1;
  const union = new Set([...aa, ...bb]).size;
  return union ? inter / union : 0;
}

function normalizeMethods(methods) {
  const raw = Array.isArray(methods) && methods.length ? methods : DEFAULT_DISTILL_METHODS;
  const out = [];
  const seen = new Set();
  for (const item of raw.slice(0, DISTILL_BAKEOFF_LIMITS.max_methods)) {
    const id = cleanId(typeof item === 'string' ? item : item && item.id, DISTILL_BAKEOFF_LIMITS.max_method_chars);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: cleanText((item && item.label) || id, DISTILL_BAKEOFF_LIMITS.max_method_chars),
    });
  }
  return out;
}

function rowStableId(row, index) {
  return cleanId(
    row && (row.id || row.row_id || row.capture_id || row.event_id || row.trace_id),
    DISTILL_BAKEOFF_LIMITS.max_id_chars,
  ) || `row_${index}`;
}

function expectedText(row) {
  return cleanText(
    row && (
      row.expected
      || row.reference
      || row.teacher_output
      || row.output
      || row.response
      || row.response_redacted
    ),
  );
}

function teacherText(row) {
  return cleanText(row && (row.teacher_output || row.teacher_response || row.reference || row.expected));
}

function promptText(row) {
  return cleanText(row && (row.prompt_redacted || row.prompt || row.input || row.query));
}

function precomputedOutput(row, method) {
  if (!row || typeof row !== 'object') return null;
  for (const bagName of ['method_outputs', 'outputs', 'candidate_outputs', 'student_outputs']) {
    const bag = row[bagName];
    if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
      const v = bag[method];
      if (typeof v === 'string') return { output: v, source: bagName };
      if (v && typeof v === 'object' && typeof v.output === 'string') {
        return { ...v, source: bagName };
      }
    }
  }
  const direct = row[`${method}_output`];
  if (typeof direct === 'string') return { output: direct, source: `${method}_output` };
  const nested = row[method];
  if (nested && typeof nested === 'object' && typeof nested.output === 'string') {
    return { ...nested, source: method };
  }
  return null;
}

async function resolveOutput({ row, method, index, runMethod }) {
  if (typeof runMethod === 'function') {
    const out = await runMethod({ method, row, index });
    if (typeof out === 'string') return { output: out, source: 'runMethod' };
    if (out && typeof out === 'object' && typeof out.output === 'string') return { ...out, source: 'runMethod' };
    return null;
  }
  return precomputedOutput(row, method);
}

async function scoreOutput({ judge, judgeKind, row, method, output, expected, teacher, index, kscore }) {
  if (typeof judge === 'function') {
    const judged = await judge({
      prompt: promptText(row),
      expected,
      teacher_output: teacher,
      actual: output,
      output,
      method,
      row,
      index,
    });
    const score = clamp01(judged && typeof judged === 'object' ? judged.score : judged);
    const out = {
      score,
      judge_kind: judgeKind || 'callable',
    };
    if (judged && typeof judged === 'object') {
      const kj = clamp01(judged.kscore);
      if (kj != null) out.kscore = kj;
    }
    return out;
  }
  const target = expected || teacher;
  return {
    score: clamp01(tokenJaccard(output, target)),
    judge_kind: 'heuristic_token_jaccard',
  };
}

function initMethodSummary(method) {
  return {
    method,
    attempted: 0,
    completed: 0,
    failed: 0,
    wins: 0,
    ties: 0,
    losses: 0,
    avg_judge_score: null,
    avg_kscore: null,
    score_delta_vs_baseline: null,
    win_rate_vs_baseline: null,
  };
}

function mean(xs) {
  const vals = xs.filter((x) => Number.isFinite(x));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function round4(v) {
  return Number.isFinite(v) ? Number(v.toFixed(4)) : null;
}

function hasAnyPrecomputed(rows, methods) {
  return rows.some((row) => methods.some((m) => precomputedOutput(row, m.id)));
}

export async function runDistillMethodBakeoff(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const methods = normalizeMethods(input.methods);
  const baseline = cleanId(input.baseline_method || input.baseline || 'seqkd', DISTILL_BAKEOFF_LIMITS.max_method_chars)
    || methods[0]?.id;
  const maxRows = Math.max(1, Math.min(
    DISTILL_BAKEOFF_LIMITS.max_rows,
    Math.floor(Number(input.max_rows || input.maxRows || DISTILL_BAKEOFF_LIMITS.max_rows)),
  ));
  const runMethod = input.runMethod;
  const judge = input.judge;
  const kscore = input.kscore;
  const judgeKind = cleanId(input.judge_kind || input.judgeKind, 80);

  if (!rows.length) {
    return {
      ok: false,
      error: 'no_holdout_rows',
      hint: 'pass rows with teacher/reference text and per-method outputs, or pass runMethod',
      version: DISTILL_BAKEOFF_VERSION,
    };
  }
  if (methods.length < 2) {
    return {
      ok: false,
      error: 'need_at_least_two_methods',
      hint: 'pass at least two methods, e.g. seqkd,ropd,gad',
      version: DISTILL_BAKEOFF_VERSION,
    };
  }
  if (typeof runMethod !== 'function' && !hasAnyPrecomputed(rows, methods)) {
    return {
      ok: false,
      error: 'no_method_outputs_or_runner',
      hint: 'pass runMethod({method,row}) or rows carrying method_outputs/outputs/<method>_output',
      version: DISTILL_BAKEOFF_VERSION,
    };
  }

  const selectedRows = rows.slice(0, maxRows);
  const byMethod = Object.create(null);
  const scoreLists = Object.create(null);
  const kscoreLists = Object.create(null);
  for (const m of methods) {
    byMethod[m.id] = initMethodSummary(m.id);
    scoreLists[m.id] = [];
    kscoreLists[m.id] = [];
  }

  const row_results = [];
  let judge_error_count = 0;
  let output_error_count = 0;

  for (let index = 0; index < selectedRows.length; index += 1) {
    const row = selectedRows[index] || {};
    const rowId = rowStableId(row, index);
    const expected = expectedText(row);
    const teacher = teacherText(row);
    const scores = Object.create(null);
    for (const m of methods) {
      byMethod[m.id].attempted += 1;
      try {
        const out = await resolveOutput({ row, method: m.id, index, runMethod });
        if (!out || typeof out.output !== 'string') {
          byMethod[m.id].failed += 1;
          output_error_count += 1;
          scores[m.id] = { error: 'missing_method_output' };
          continue;
        }
        const output = cleanText(out.output);
        const judged = await scoreOutput({
          judge,
          judgeKind,
          row,
          method: m.id,
          output,
          expected,
          teacher,
          index,
          kscore,
        });
        let score = judged.score;
        if (score == null) {
          byMethod[m.id].failed += 1;
          judge_error_count += 1;
          scores[m.id] = { error: 'judge_score_missing' };
          continue;
        }
        let kscoreValue = judged.kscore;
        if (kscoreValue == null && typeof kscore === 'function') {
          const k = await kscore({ prompt: promptText(row), expected, teacher_output: teacher, actual: output, method: m.id, row, index });
          kscoreValue = clamp01(k && typeof k === 'object' ? k.score : k);
        }
        byMethod[m.id].completed += 1;
        scoreLists[m.id].push(score);
        if (kscoreValue != null) kscoreLists[m.id].push(kscoreValue);
        scores[m.id] = {
          score: round4(score),
          ...(kscoreValue != null ? { kscore: round4(kscoreValue) } : {}),
          output_sha256: sha256(output),
          source: cleanId(out.source || 'unknown', 64) || 'unknown',
        };
      } catch (_) {
        byMethod[m.id].failed += 1;
        judge_error_count += 1;
        scores[m.id] = { error: 'method_or_judge_threw' };
      }
    }
    let winner = null;
    let best = -Infinity;
    let tie = false;
    for (const m of methods) {
      const s = scores[m.id] && scores[m.id].score;
      if (!Number.isFinite(s)) continue;
      if (s > best) {
        winner = m.id;
        best = s;
        tie = false;
      } else if (s === best) {
        tie = true;
      }
    }
    if (tie) winner = 'tie';
    row_results.push({
      row_id_hash: sha256(rowId),
      row_index: index,
      expected_sha256: sha256(expected),
      teacher_output_sha256: sha256(teacher),
      winner,
      scores,
    });
  }

  const baselineScores = scoreLists[baseline] || [];
  const baselineAvg = mean(baselineScores);
  for (const m of methods) {
    const summary = byMethod[m.id];
    const avg = mean(scoreLists[m.id]);
    const kavg = mean(kscoreLists[m.id]);
    summary.avg_judge_score = round4(avg);
    summary.avg_kscore = round4(kavg);
    summary.score_delta_vs_baseline = baselineAvg == null || avg == null ? null : round4(avg - baselineAvg);

    let comparable = 0;
    let wins = 0;
    let ties = 0;
    let losses = 0;
    for (const row of row_results) {
      const mine = row.scores[m.id] && row.scores[m.id].score;
      const base = row.scores[baseline] && row.scores[baseline].score;
      if (!Number.isFinite(mine) || !Number.isFinite(base)) continue;
      comparable += 1;
      if (mine > base) wins += 1;
      else if (mine < base) losses += 1;
      else ties += 1;
    }
    summary.wins = wins;
    summary.ties = ties;
    summary.losses = losses;
    summary.win_rate_vs_baseline = comparable ? round4(wins / comparable) : null;
  }

  const ranked_methods = methods.map((m) => byMethod[m.id])
    .sort((a, b) => (b.avg_judge_score ?? -1) - (a.avg_judge_score ?? -1));
  const best_method = ranked_methods[0]?.method || null;
  const gate = buildDistillBakeoffGate({
    ranked_methods,
    baseline_method: baseline,
    min_score_delta: input.min_score_delta,
    min_win_rate: input.min_win_rate,
  });

  return {
    ok: true,
    version: DISTILL_BAKEOFF_VERSION,
    privacy_mode: 'hash_only',
    claim_scope: typeof judge === 'function'
      ? 'method_head_to_head_with_callable_judge'
      : 'heuristic_local_overlap_smoke_not_quality_claim',
    judge_kind: typeof judge === 'function' ? (judgeKind || 'callable') : 'heuristic_token_jaccard',
    baseline_method: baseline,
    methods: methods.map((m) => m.id),
    rows_requested: rows.length,
    rows_compared: selectedRows.length,
    max_rows: maxRows,
    output_error_count,
    judge_error_count,
    best_method,
    ranked_methods,
    gate,
    row_results,
  };
}

export function buildDistillBakeoffGate({
  ranked_methods,
  baseline_method = 'seqkd',
  min_score_delta = 0.02,
  min_win_rate = 0.55,
} = {}) {
  const rows = Array.isArray(ranked_methods) ? ranked_methods : [];
  const baseline = rows.find((r) => r.method === baseline_method);
  const best = rows[0] || null;
  if (!baseline || !best || best.method === baseline_method) {
    return {
      pass: false,
      reason: 'no_non_baseline_winner',
      baseline_method,
      best_method: best && best.method,
    };
  }
  const delta = Number(best.score_delta_vs_baseline);
  const winRate = Number(best.win_rate_vs_baseline);
  const pass = Number.isFinite(delta)
    && Number.isFinite(winRate)
    && delta >= Number(min_score_delta)
    && winRate >= Number(min_win_rate);
  return {
    pass,
    reason: pass ? 'best_method_exceeds_baseline' : 'best_method_below_gate',
    baseline_method,
    best_method: best.method,
    min_score_delta: Number(min_score_delta),
    min_win_rate: Number(min_win_rate),
    score_delta_vs_baseline: Number.isFinite(delta) ? round4(delta) : null,
    win_rate_vs_baseline: Number.isFinite(winRate) ? round4(winRate) : null,
  };
}

export function loadDistillBakeoffJsonl(text) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) rows.push(obj);
    } catch (e) {
      const err = new Error(`malformed JSONL at line ${i + 1}: ${e.message}`);
      err.code = 'BAD_JSONL';
      throw err;
    }
  }
  return rows;
}
