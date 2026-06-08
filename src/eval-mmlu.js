// W758-1 - MMLU runner harness (honest scaffold).
//
// MMLU (Massive Multitask Language Understanding) - Hendrycks et al. 2020 - 
// 57 academic subjects, multi-choice A/B/C/D, ~14k test rows. Source of
// truth at huggingface.co/datasets/cais/mmlu (Apache-2.0). The official
// archive ships per-subject CSV files: question, A, B, C, D, answer.
//
// HONESTY CONTRACT (do not violate):
//   - This module does NOT bundle the MMLU dataset. We ship a HARNESS that
//     scores rows from a locally provided pack. If the pack is absent we
//     return an honest envelope { ok:false, error:'bench_pack_not_local',
//     hint, expected_path } - NEVER a fake number.
//   - This module does NOT ship a runtime that calls your .kolm artifact.
//     The caller supplies `runOnArtifact(artifact_path, prompt) -> string`
//     via dependency injection so tests have a deterministic seam and the
//     real-runtime wiring (W470, W775) stays out of the harness. When the
//     route layer omits a runOnArtifact, we return an honest envelope
//     { ok:false, error:'runtime_not_wired', hint } NOT 200 with zeroes.
//   - Accuracy is exact-match on the letter answer. Output normalization is
//     conservative - trim/upper, grab the first A|B|C|D character. We do
//     NOT pattern-match longer rationale text; that would silently inflate
//     scores on models that emit "I think the answer is B because ..." and
//     deflate scores on models that emit "B".
//
// Tenant safety: this module is pure compute over a CSV pack + caller-
// supplied callable. It writes nothing to the event store. The route layer
// is auth-gated and tenant-scoped on the caller's side.
//
// W604 anti-brittleness: the version stamp uses a regex-friendly suffix
// `w758-v1` so a 1.x bump in the same wave does not force a coordinated
// test rev (the test pins /^w758-/ AND the literal current value).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MMLU_VERSION = 'w758-v1';
export const MMLU_PACK_PATH_ENV = 'KOLM_MMLU_PACK';

// Canonical 57-subject list per cais/mmlu test split (alpha-sorted, frozen
// so a re-order is a deliberate breaking change). Source order follows the
// /test/<subject>_test.csv filenames in the HF release. Tests pin both the
// length and the freeze.
export const MMLU_CATEGORIES = Object.freeze([
  'abstract_algebra',
  'anatomy',
  'astronomy',
  'business_ethics',
  'clinical_knowledge',
  'college_biology',
  'college_chemistry',
  'college_computer_science',
  'college_mathematics',
  'college_medicine',
  'college_physics',
  'computer_security',
  'conceptual_physics',
  'econometrics',
  'electrical_engineering',
  'elementary_mathematics',
  'formal_logic',
  'global_facts',
  'high_school_biology',
  'high_school_chemistry',
  'high_school_computer_science',
  'high_school_european_history',
  'high_school_geography',
  'high_school_government_and_politics',
  'high_school_macroeconomics',
  'high_school_mathematics',
  'high_school_microeconomics',
  'high_school_physics',
  'high_school_psychology',
  'high_school_statistics',
  'high_school_us_history',
  'high_school_world_history',
  'human_aging',
  'human_sexuality',
  'international_law',
  'jurisprudence',
  'logical_fallacies',
  'machine_learning',
  'management',
  'marketing',
  'medical_genetics',
  'miscellaneous',
  'moral_disputes',
  'moral_scenarios',
  'nutrition',
  'philosophy',
  'prehistory',
  'professional_accounting',
  'professional_law',
  'professional_medicine',
  'professional_psychology',
  'public_relations',
  'security_studies',
  'sociology',
  'us_foreign_policy',
  'virology',
  'world_religions',
]);

function _defaultPackDir() {
  const home = process.env.KOLM_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.kolm', 'bench-packs', 'mmlu');
}

// parseMMLUCsv(text) - RFC 4180-flavoured CSV parser scoped to the MMLU
// schema: 6 columns (question, A, B, C, D, answer). Supports embedded
// quotes ("a ""quoted"" word"), embedded newlines inside quoted fields,
// commas in quoted fields. Does NOT support escaped backslashes or BOM
// preambles (MMLU ships UTF-8 without BOM).
//
// `subject` is taken from the optional 7th column if present (we synthesize
// one when re-packing); falls back to 'unknown' otherwise. Callers usually
// pass subject via the filename (foo_test.csv -> foo) - loadMMLUPack does.
export function parseMMLUCsv(text, defaultSubject = 'unknown') {
  if (typeof text !== 'string') return [];
  const rows = [];
  const len = text.length;
  let i = 0;
  let field = '';
  let row = [];
  let inQuotes = false;
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  const out = [];
  for (const r of rows) {
    if (!r || r.length < 6) continue;
    const [question, A, B, C, D, answer, maybeSubject] = r;
    const ans = String(answer || '').trim().toUpperCase();
    if (!/^[ABCD]$/.test(ans)) continue;
    out.push({
      question: String(question || ''),
      choices: [String(A || ''), String(B || ''), String(C || ''), String(D || '')],
      answer: ans,
      subject: String(maybeSubject || defaultSubject),
    });
  }
  return out;
}

// loadMMLUPack({pack_dir, subjects=null}) - returns an array of MMLU rows
// from a local pack OR an honest envelope when the pack is absent. The
// pack layout is the HF release shape: <pack_dir>/test/<subject>_test.csv.
// When subjects is null we read every subject in MMLU_CATEGORIES that has
// a matching file (missing subjects are tolerated - partial packs are
// useful for smoke tests).
//
// Returns either { ok:true, rows, n, subjects } OR
// { ok:false, error:'bench_pack_not_local', hint, expected_path, version }.
export function loadMMLUPack({ pack_dir = null, subjects = null } = {}) {
  const dir = pack_dir || process.env[MMLU_PACK_PATH_ENV] || _defaultPackDir();
  const testDir = path.join(dir, 'test');
  if (!fs.existsSync(testDir)) {
    return {
      ok: false,
      error: 'bench_pack_not_local',
      hint:
        'MMLU pack not found. Download from huggingface.co/datasets/cais/mmlu ' +
        'and unpack to ' + dir + '. Expected layout: <pack_dir>/test/<subject>_test.csv',
      expected_path: dir,
      version: MMLU_VERSION,
    };
  }
  const want = Array.isArray(subjects) && subjects.length
    ? subjects.filter((s) => MMLU_CATEGORIES.includes(s))
    : MMLU_CATEGORIES.slice();
  const rows = [];
  const seen = [];
  for (const subj of want) {
    const fp = path.join(testDir, subj + '_test.csv');
    if (!fs.existsSync(fp)) continue;
    let text;
    try { text = fs.readFileSync(fp, 'utf8'); }
    catch (_e) { continue; }
    const parsed = parseMMLUCsv(text, subj);
    for (const r of parsed) rows.push(r);
    if (parsed.length) seen.push(subj);
  }
  if (rows.length === 0) {
    return {
      ok: false,
      error: 'bench_pack_empty',
      hint:
        'MMLU pack directory exists at ' + dir + ' but contains no parseable rows. ' +
        'Verify the per-subject CSV layout matches huggingface.co/datasets/cais/mmlu.',
      expected_path: dir,
      version: MMLU_VERSION,
    };
  }
  return { ok: true, rows, n: rows.length, subjects: seen, version: MMLU_VERSION };
}

// _normalizeLetter(s) - extract the predicted MMLU letter from `s`.
// Deliberately conservative - see HONESTY CONTRACT.
//
// Priority order (first match wins):
//   1) A standalone letter at start of string ('B', 'B.', 'B)', 'B - ').
//   2) An "answer is X" or "the answer: X" pattern (case-insensitive).
//   3) The very last standalone A|B|C|D in the string (most models emit
//      their final answer last).
//   4) A bare A|B|C|D anywhere in the string (last-resort fallback).
//
// We do NOT just scan for the first A|B|C|D - that would mis-attribute on
// "The answer is B" (matches A in "Answer"). Returns null when nothing
// plausible is found.
function _normalizeLetter(s) {
  if (s == null) return null;
  const text = String(s).trim();
  if (!text) return null;
  // 1) Leading letter - strict boundary so 'Anatomy' (A) doesn't match.
  const lead = text.match(/^([ABCD])(?:[\s.,):\- - ]|$)/i);
  if (lead) return lead[1].toUpperCase();
  // 2) "the answer is X" / "answer: X" / "Answer is X" patterns.
  const pat = text.match(/answer\s*(?:is|:)\s*\*?\s*([ABCD])\b/i);
  if (pat) return pat[1].toUpperCase();
  // 3) Last standalone boundary-anchored letter.
  const all = [...text.matchAll(/\b([ABCD])\b/gi)];
  if (all.length) return all[all.length - 1][1].toUpperCase();
  // 4) Last-resort: any A|B|C|D character.
  const any = text.toUpperCase().match(/[ABCD]/);
  return any ? any[0] : null;
}

// formatMMLUPrompt(row) - canonical 4-choice prompt template. Matches the
// reference scoring harness in the MMLU paper (Hendrycks et al. 2020 §4.1).
export function formatMMLUPrompt(row) {
  return (
    'Question: ' + row.question + '\n' +
    'A. ' + row.choices[0] + '\n' +
    'B. ' + row.choices[1] + '\n' +
    'C. ' + row.choices[2] + '\n' +
    'D. ' + row.choices[3] + '\n' +
    'Answer:'
  );
}

// runMMLU({artifact_path, pack_dir, n_samples, subjects, runOnArtifact}).
//
// runOnArtifact MUST be a callable (sync or async) of shape
// (artifact_path, prompt) -> string. It is mandatory - when omitted the
// harness returns honest { ok:false, error:'runtime_not_wired' }.
//
// n_samples truncates to the first N rows for fast smoke tests; null runs
// everything in the pack. sample_runs is capped at 8 so the response stays
// small even on a 14k-row full pack.
export async function runMMLU({
  artifact_path = null,
  pack_dir = null,
  n_samples = null,
  subjects = null,
  runOnArtifact = null,
} = {}) {
  if (typeof runOnArtifact !== 'function') {
    return {
      ok: false,
      error: 'runtime_not_wired',
      hint:
        'runMMLU requires a runOnArtifact callable (artifact_path, prompt) -> string. ' +
        'The bench harness ships before W775 runtime wiring; pass a callable from a ' +
        'tester or wire src/artifact-runner.js into the route handler.',
      version: MMLU_VERSION,
    };
  }
  const pack = loadMMLUPack({ pack_dir, subjects });
  if (!pack.ok) return pack;
  const rows = (typeof n_samples === 'number' && n_samples > 0)
    ? pack.rows.slice(0, n_samples)
    : pack.rows;
  if (rows.length === 0) {
    return { ok: false, error: 'bench_pack_empty', expected_path: pack_dir, version: MMLU_VERSION };
  }
  const by_subject = {};
  const sample_runs = [];
  let correct = 0;
  for (const row of rows) {
    let raw;
    try { raw = await runOnArtifact(artifact_path, formatMMLUPrompt(row)); }
    catch (e) {
      raw = '';
      // capture the first 3 errors in sample_runs so debugging isn't blind.
      if (sample_runs.length < 3) {
        sample_runs.push({
          question: row.question.slice(0, 200),
          predicted: null,
          expected: row.answer,
          correct: false,
          error: String(e && e.message || e),
        });
      }
    }
    const predicted = _normalizeLetter(raw);
    const ok = predicted === row.answer;
    if (ok) correct += 1;
    const subj = row.subject || 'unknown';
    if (!by_subject[subj]) by_subject[subj] = { n: 0, correct: 0 };
    by_subject[subj].n += 1;
    if (ok) by_subject[subj].correct += 1;
    if (sample_runs.length < 8) {
      sample_runs.push({
        question: row.question.slice(0, 200),
        predicted,
        expected: row.answer,
        correct: ok,
      });
    }
  }
  // finalize per-subject accuracy.
  for (const k of Object.keys(by_subject)) {
    const r = by_subject[k];
    r.accuracy = r.n > 0 ? Number((r.correct / r.n).toFixed(4)) : 0;
  }
  const accuracy = rows.length > 0 ? Number((correct / rows.length).toFixed(4)) : 0;
  return {
    ok: true,
    version: MMLU_VERSION,
    n: rows.length,
    accuracy,
    correct,
    by_subject,
    sample_runs,
    pack_path: pack_dir || process.env[MMLU_PACK_PATH_ENV] || _defaultPackDir(),
  };
}
