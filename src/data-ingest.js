// src/data-ingest.js
//
// W910 Track A — Data Ingestion. W921 — KOLM Data Engine INGEST stage.
//
// TWO layers live here:
//
//  1. The original "in-memory importer" surface (positional args) that turns
//     customer artifacts into the {input, output, source}[] shape the compile
//     pipeline understands. These feed cmdCompile (cli/kolm.js) via the
//     --data / --describe / --docs flags; the combined form merges all three.
//       ingestData(filePath, opts)     - .csv/.tsv/.jsonl/.json (parquet rejected with hint)
//       ingestDescribe(text, opts)     - synthetic seed expansion (teacher-backed)
//       ingestDocs(folderPath, opts)   - .md/.txt/.html walk + Q&A extraction
//       mergeAndDedupe(arrays)         - sha1(input) dedupe across sources
//       synthesizeSpec(rows, opts)     - minimal spec.json so the pipeline runs
//
//  2. The W921 INGEST stage: persistent, namespace-scoped raw-pairs that land in
//     <KOLM_DATA_DIR>/<ns>/raw-pairs.jsonl, each line carrying a complete nested
//     provenance block (see src/data-provenance.js). These are the {ok, n_written}
//     object-arg entry points the Data Engine drives:
//       ingestDescribe({namespace, description, n})       - SEED prompts (output '')
//       ingestFile({namespace, file})                     - JSONL {input,output}
//       ingestDocs({namespace, docs_dir})                 - chunk .md → reference output
//       ingestFrom({namespace, source, file})             - provider export → input
//       ingestPairs({namespace, pairs})                   - in-memory pairs source
//       ingestCombined({namespace, sources:[...]})        - merge + dedupe by id
//       readRawPairs(namespace) / rawPairsPath(namespace) - read / locate the JSONL
//       validateProvenance(pair)                          - re-exported from provenance
//
//  ingestDescribe + ingestDocs are DUAL-SIGNATURE: an object arg carrying a
//  `namespace` selects the W921 persistent path; the legacy positional string
//  arg keeps the in-memory importer behavior intact for existing callers.
//
// No new npm deps. Reuses parseCsv + extractPairsFromJsonObjects + stripHtml
// from src/seeds-mining.js so the parsing rules stay in one place.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCsv, extractPairsFromJsonObjects, extractPairsFromText, stripHtml } from './seeds-mining.js';
import { recordProvenance, validateProvenance, summarizeProvenance } from './data-provenance.js';

export const INGEST_VERSION = 'ingest-v1';

// Re-export the provenance validator so callers (and the smoke) can import it
// straight from the ingest surface; the contract is owned by data-provenance.js.
export { validateProvenance, summarizeProvenance };

const SUPPORTED_DATA_EXTS = new Set(['.csv', '.tsv', '.jsonl', '.ndjson', '.json']);
const DOC_EXTS = new Set(['.md', '.txt', '.html', '.htm', '.rst', '.markdown']);
const PARQUET_EXTS = new Set(['.parquet', '.pq']);
const XLSX_EXTS = new Set(['.xlsx', '.xls']);
const PDF_EXTS = new Set(['.pdf']);

const MAX_FILE_BYTES = 500 * 1024 * 1024;          // 500 MB hard cap per file
const MAX_ROW_CHARS = 8000 * 4;                    // ~8k tokens, 4 chars/token
const MAX_DOC_BYTES = 5 * 1024 * 1024;             // 5 MB per individual document
const DEFAULT_DESCRIBE_COUNT = 500;
const DEFAULT_BUDGET_USD = 5;

const INPUT_COL_PATTERNS = [
  'input', 'prompt', 'question', 'query', 'user_message', 'customer_message',
  'message', 'request', 'user', 'utterance', 'source', 'before', 'text',
];
const OUTPUT_COL_PATTERNS = [
  'output', 'completion', 'answer', 'response', 'reply', 'assistant',
  'agent_response', 'bot_response', 'after', 'target', 'expected', 'label',
];

function sha1(s) {
  return crypto.createHash('sha1').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
}
function sha256(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
}

function detectDelimiter(headLine) {
  // Score , \t ; | by frequency in the first non-empty line; tiebreaker = comma.
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestN = 0;
  for (const c of candidates) {
    const n = (headLine.match(new RegExp(c === '|' ? '\\|' : c, 'g')) || []).length;
    if (n > bestN) { best = c; bestN = n; }
  }
  return best;
}

function pickColumn(header, patterns, override) {
  if (override) {
    const norm = String(override).toLowerCase().trim();
    const idx = header.findIndex(h => String(h).toLowerCase().trim() === norm);
    if (idx >= 0) return { index: idx, source: 'override', label: header[idx] };
    return { index: -1, source: 'override-miss', label: override };
  }
  // Score columns: exact match > startsWith > includes.
  let best = -1;
  let bestScore = 0;
  let bestLabel = null;
  header.forEach((h, i) => {
    const hl = String(h).toLowerCase().trim();
    for (const p of patterns) {
      let score = 0;
      if (hl === p) score = 100;
      else if (hl.startsWith(p)) score = 50;
      else if (hl.includes(p)) score = 20;
      if (score > bestScore) { best = i; bestScore = score; bestLabel = h; }
    }
  });
  if (best >= 0) return { index: best, source: 'auto', label: bestLabel };
  return { index: -1, source: 'none', label: null };
}

function filterRows(rawRows) {
  // Drop empty, dedupe by sha1(input), drop oversized. Return {rows, stats}.
  const stats = { dropped_empty: 0, dropped_dup: 0, dropped_long: 0, kept: 0 };
  const seen = new Set();
  const out = [];
  for (const r of rawRows) {
    if (!r || r.input == null || r.output == null) { stats.dropped_empty++; continue; }
    const iStr = typeof r.input === 'string' ? r.input : JSON.stringify(r.input);
    const oStr = typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
    if (!iStr.trim() || !oStr.trim()) { stats.dropped_empty++; continue; }
    if (iStr.length > MAX_ROW_CHARS || oStr.length > MAX_ROW_CHARS) { stats.dropped_long++; continue; }
    const key = sha1(iStr);
    if (seen.has(key)) { stats.dropped_dup++; continue; }
    seen.add(key);
    out.push(r);
  }
  stats.kept = out.length;
  return { rows: out, stats };
}

// =============================================================================
// W921 INGEST stage — persistent, namespace-scoped raw-pairs.
//
// Every pair appended to <KOLM_DATA_DIR>/<ns>/raw-pairs.jsonl carries:
//   id, input, output, source_type, ingested_at, source_ref,
//   provenance:{ source_type, ingested_at, source_ref, extra }.
// =============================================================================

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

// Root for engine data. Honors KOLM_DATA_DIR (the smoke sets it to a temp dir
// BEFORE importing this module), then KOLM_HOME, then ~/.kolm. The /<ns> dir
// lives directly under this root so rawPairsPath('x') == <root>/x/raw-pairs.jsonl.
function _dataRoot() {
  if (process.env.KOLM_DATA_DIR) return path.resolve(process.env.KOLM_DATA_DIR);
  if (process.env.KOLM_HOME) return path.join(path.resolve(process.env.KOLM_HOME), 'data');
  return path.join(_home(), '.kolm', 'data');
}

function _safeNs(namespace) {
  return String(namespace || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128) || 'default';
}

// Path to the namespace's raw-pairs.jsonl under the data root. Pure (no IO).
export function rawPairsPath(namespace) {
  return path.join(_dataRoot(), _safeNs(namespace), 'raw-pairs.jsonl');
}

// Read all raw pairs for a namespace. A cold namespace yields []. Never throws.
export function readRawPairs(namespace) {
  const p = rawPairsPath(namespace);
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const ln of text.split('\n')) {
    const t = ln.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

// Stable id for a pair: explicit id wins (so callers can force dedupe);
// otherwise sha1 over source_type + input + output keeps identical content from
// re-appending on a re-run without depending on wall-clock.
function _pairId(pair, sourceType) {
  if (pair && pair.id != null && String(pair.id).trim()) return String(pair.id);
  const basis = `${sourceType || ''} ${pair && pair.input != null ? String(pair.input) : ''} ${pair && pair.output != null ? String(pair.output) : ''}`;
  return 'pr_' + sha1(basis).slice(0, 24);
}

// Normalize one raw pair into the on-disk line shape with a complete provenance
// block. `sourceMeta` describes the origin (source_type + source_ref). Outputs
// are preserved verbatim (including '' for seed prompts).
function _toRawLine(pair, sourceMeta) {
  const sourceType = sourceMeta.source_type;
  const ingested_at = sourceMeta.ingested_at || new Date().toISOString();
  const source_ref = String(pair.source_ref != null ? pair.source_ref
    : (pair.source != null ? pair.source : sourceMeta.source_ref));
  const id = _pairId(pair, sourceType);
  const withProv = recordProvenance(
    { id, input: pair.input != null ? String(pair.input) : '', output: pair.output != null ? String(pair.output) : '' },
    { source_type: sourceType, source_ref, ingested_at, extra: sourceMeta.extra },
  );
  return withProv;
}

// Append normalized lines to the namespace JSONL, deduping by id WITHIN this
// write AND against ids already on disk. Returns {n_written, dupes_skipped, ids}.
function _appendRawPairs(namespace, pairs, sourceMeta) {
  const target = rawPairsPath(namespace);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const existing = new Set(readRawPairs(namespace).map(p => p && p.id).filter(Boolean));
  const lines = [];
  const ids = [];
  let dupes = 0;
  for (const raw of pairs) {
    const line = _toRawLine(raw, sourceMeta);
    if (existing.has(line.id)) { dupes++; continue; }
    existing.add(line.id);
    lines.push(JSON.stringify(line));
    ids.push(line.id);
  }
  if (lines.length) fs.appendFileSync(target, lines.join('\n') + '\n', 'utf8');
  return { n_written: lines.length, dupes_skipped: dupes, ids, path: target };
}

// ---- A2/W921: ingestDescribe({namespace, description, n}) — SEED prompts -----
//
// Writes n seed pairs whose OUTPUT IS EMPTY: they are prompts spanning the
// described task, to be filled by a later AUGMENT/collect stage. This is the
// object-arg signature; the legacy string-arg signature is handled below.
async function ingestDescribeStage({ namespace, description, n = 8 } = {}) {
  const desc = String(description || '').trim();
  if (!desc) return { ok: false, error: 'description_required', version: INGEST_VERSION };
  const count = Math.max(1, Math.min(2000, Number(n) || 8));
  const ingested_at = new Date().toISOString();
  const seeds = buildSeedPrompts(desc, count);
  const res = _appendRawPairs(namespace, seeds, {
    source_type: 'describe',
    source_ref: 'describe:' + sha1(desc).slice(0, 16),
    ingested_at,
    extra: { description_sha256: sha256(desc), description_chars: desc.length },
  });
  return {
    ok: true,
    version: INGEST_VERSION,
    source_type: 'describe',
    namespace,
    n_written: res.n_written,
    dupes_skipped: res.dupes_skipped,
    path: res.path,
    rows: seeds.map((s, i) => ({ ...s, id: res.ids[i] })),
  };
}

// Deterministic seed-prompt scaffolds: each one is a distinct angle on the
// described task, phrased AS a prompt to be answered later. Outputs are empty.
const _SEED_ANGLES = [
  'a minimal, well-formed request',
  'a typical everyday request',
  'an edge-case request near a boundary',
  'a malformed or ambiguous request',
  'an unusually long, detailed request',
  'a terse, one-line request',
  'a request in casual, informal language',
  'a request in formal, professional language',
  'a request that references prior context',
  'a request that asks for clarification',
  'a high-stakes or urgent request',
  'a request with an unsupported ask',
];

function buildSeedPrompts(description, n) {
  const seeds = [];
  for (let i = 0; i < n; i++) {
    const angle = _SEED_ANGLES[i % _SEED_ANGLES.length];
    const cycle = Math.floor(i / _SEED_ANGLES.length) + 1;
    const suffix = cycle > 1 ? ` (variant ${cycle})` : '';
    seeds.push({
      // The input is a generation prompt; a later stage fills the empty output.
      input: `For the task "${description}", produce ${angle}${suffix}.`,
      output: '',
      source: `describe:seed:${i + 1}`,
    });
  }
  return seeds;
}

// ---- W921: ingestFile({namespace, file}) — JSONL of {input,output} ----------
export async function ingestFile({ namespace, file } = {}) {
  if (!file) return { ok: false, error: 'input_not_found', version: INGEST_VERSION };
  const abs = path.resolve(file);
  let text;
  try { text = await fsp.readFile(abs, 'utf8'); }
  catch { return { ok: false, error: 'input_not_found', version: INGEST_VERSION }; }

  const ingested_at = new Date().toISOString();
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln || ln.startsWith('//') || ln.startsWith('#')) continue;
    let parsed;
    try { parsed = JSON.parse(ln); } catch { continue; }
    for (const pair of extractPairsFromJsonObjects([parsed], path.basename(abs), i + 1)) {
      rows.push({ input: pair.input, output: pair.output, source: pair.source });
    }
  }
  const res = _appendRawPairs(namespace, rows, {
    source_type: 'file',
    source_ref: abs,
    ingested_at,
    extra: { file: path.basename(abs) },
  });
  return {
    ok: true,
    version: INGEST_VERSION,
    source_type: 'file',
    namespace,
    n_written: res.n_written,
    dupes_skipped: res.dupes_skipped,
    path: res.path,
  };
}

// ---- W921: ingestDocs({namespace, docs_dir}) — chunk .md → reference output -
//
// Each Markdown chunk becomes one pair: the heading is the input, the chunk
// TEXT is the reference output (so every written pair has a non-empty output).
async function ingestDocsStage({ namespace, docs_dir } = {}) {
  const abs = path.resolve(docs_dir || '');
  let st;
  try { st = await fsp.stat(abs); } catch { return { ok: false, error: 'docs_dir_not_found', version: INGEST_VERSION }; }
  if (!st.isDirectory()) return { ok: false, error: 'docs_dir_not_a_directory', version: INGEST_VERSION };

  const files = await walkDocs(abs);
  const ingested_at = new Date().toISOString();
  const rows = [];
  for (const f of files) {
    let text;
    try { text = await fsp.readFile(f, 'utf8'); } catch { continue; }
    const ext = path.extname(f).toLowerCase();
    if (ext === '.html' || ext === '.htm') text = stripHtml(text);
    const chunks = chunkDocument(text, ext);
    for (const c of chunks) {
      const body = (c.text || c.body || '').trim();
      if (!body) continue;
      const input = (c.heading && c.heading.trim())
        ? c.heading.trim()
        : body.split(/\r?\n/)[0].slice(0, 200);
      rows.push({
        input: input || path.basename(f),
        output: body,                       // chunk text IS the reference output
        source: `${f}:${c.line || 1}`,
      });
    }
  }
  const res = _appendRawPairs(namespace, rows, {
    source_type: 'docs',
    source_ref: abs,
    ingested_at,
    extra: { docs_dir: abs, files_scanned: files.length },
  });
  return {
    ok: true,
    version: INGEST_VERSION,
    source_type: 'docs',
    namespace,
    n_written: res.n_written,
    dupes_skipped: res.dupes_skipped,
    files_scanned: files.length,
    path: res.path,
  };
}

// ---- W921: ingestFrom({namespace, source, file}) — provider exports ---------
//
// Each supported provider exports request/response logs in its own shape. We
// extract the USER INPUT (and the assistant output when present) so every
// written pair carries a non-empty input.
const FROM_SOURCES = new Set(['openai-finetune', 'portkey', 'helicone', 'litellm', 'hf']);

function _lastUserContent(messages) {
  if (!Array.isArray(messages)) return '';
  let val = '';
  for (const m of messages) {
    if (m && m.role === 'user' && m.content != null) val = String(m.content);
  }
  // Fall back to the last non-system/non-assistant message if no explicit user.
  if (!val) {
    for (const m of messages) {
      if (m && m.role !== 'assistant' && m.role !== 'system' && m.content != null) val = String(m.content);
    }
  }
  return val;
}

function _firstAssistantContent(messages) {
  if (!Array.isArray(messages)) return '';
  for (const m of messages) {
    if (m && m.role === 'assistant' && m.content != null) return String(m.content);
  }
  return '';
}

function _extractFromRecord(source, rec) {
  if (!rec || typeof rec !== 'object') return null;
  let input = '';
  let output = '';
  switch (source) {
    case 'openai-finetune': {
      input = _lastUserContent(rec.messages);
      output = _firstAssistantContent(rec.messages);
      break;
    }
    case 'portkey': {
      const reqMsgs = rec.request && rec.request.messages;
      input = _lastUserContent(reqMsgs);
      const choice = rec.response && rec.response.choices && rec.response.choices[0];
      output = (choice && choice.message && choice.message.content != null) ? String(choice.message.content) : '';
      break;
    }
    case 'helicone': {
      const req = rec.request || {};
      input = req.prompt != null ? String(req.prompt) : _lastUserContent(req.messages);
      const choice = rec.response && rec.response.choices && rec.response.choices[0];
      output = choice ? String(choice.text != null ? choice.text : (choice.message && choice.message.content) || '') : '';
      break;
    }
    case 'litellm': {
      const reqMsgs = rec.request && rec.request.messages;
      input = _lastUserContent(reqMsgs) || (rec.request && rec.request.prompt != null ? String(rec.request.prompt) : '');
      output = (rec.response && rec.response.content != null) ? String(rec.response.content) : '';
      break;
    }
    case 'hf': {
      if (rec.prompt != null) { input = String(rec.prompt); output = rec.response != null ? String(rec.response) : ''; }
      else if (rec.instruction != null) {
        input = rec.input != null && String(rec.input).trim()
          ? `${rec.instruction}\n\n${rec.input}`
          : String(rec.instruction);
        output = rec.output != null ? String(rec.output) : '';
      } else if (rec.question != null) { input = String(rec.question); output = rec.answer != null ? String(rec.answer) : ''; }
      else if (rec.input != null) { input = String(rec.input); output = rec.output != null ? String(rec.output) : ''; }
      break;
    }
    default:
      return null;
  }
  if (!input || !String(input).trim()) return null;
  return { input: String(input), output: String(output || '') };
}

export async function ingestFrom({ namespace, source, file } = {}) {
  if (!FROM_SOURCES.has(source)) {
    return { ok: false, error: 'unsupported_source', supported: [...FROM_SOURCES], version: INGEST_VERSION };
  }
  if (!file) return { ok: false, error: 'input_not_found', version: INGEST_VERSION };
  const abs = path.resolve(file);
  let text;
  try { text = await fsp.readFile(abs, 'utf8'); }
  catch { return { ok: false, error: 'input_not_found', version: INGEST_VERSION }; }

  const ingested_at = new Date().toISOString();
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln || ln.startsWith('//') || ln.startsWith('#')) continue;
    let parsed;
    try { parsed = JSON.parse(ln); } catch { continue; }
    const pair = _extractFromRecord(source, parsed);
    if (pair) rows.push({ ...pair, source: `${source}:${path.basename(abs)}:${i + 1}` });
  }
  const res = _appendRawPairs(namespace, rows, {
    source_type: 'from:' + source,
    source_ref: abs,
    ingested_at,
    extra: { provider: source, file: path.basename(abs) },
  });
  return {
    ok: true,
    version: INGEST_VERSION,
    source_type: 'from:' + source,
    namespace,
    n_written: res.n_written,
    dupes_skipped: res.dupes_skipped,
    path: res.path,
  };
}

// ---- W921: ingestPairs({namespace, pairs}) — in-memory source ---------------
export async function ingestPairs({ namespace, pairs } = {}) {
  const list = Array.isArray(pairs) ? pairs : [];
  const ingested_at = new Date().toISOString();
  const res = _appendRawPairs(namespace, list, {
    source_type: 'pairs',
    source_ref: 'pairs:in-memory',
    ingested_at,
    extra: { n_input: list.length },
  });
  return {
    ok: true,
    version: INGEST_VERSION,
    source_type: 'pairs',
    namespace,
    n_written: res.n_written,
    dupes_skipped: res.dupes_skipped,
    path: res.path,
  };
}

// ---- W921: ingestCombined({namespace, sources:[...]}) — merge + dedupe -------
//
// sources: [{kind:'file', file} | {kind:'pairs', pairs}]. Each contributes to
// the SAME namespace; dedupe by explicit id is enforced across contributions
// (an id seen in an earlier contribution drops the later duplicate).
export async function ingestCombined({ namespace, sources } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const contributions = [];
  let total = 0;

  for (const src of list) {
    if (!src || typeof src !== 'object') {
      contributions.push({ kind: 'unknown', n_written: 0, dupes_skipped: 0, error: 'bad_source' });
      continue;
    }
    let res;
    if (src.kind === 'file') {
      res = await ingestFile({ namespace, file: src.file });
    } else if (src.kind === 'pairs') {
      res = await ingestPairs({ namespace, pairs: src.pairs });
    } else {
      contributions.push({ kind: String(src.kind || 'unknown'), n_written: 0, dupes_skipped: 0, error: 'unsupported_kind' });
      continue;
    }
    const nWritten = res && res.ok ? (res.n_written || 0) : 0;
    const dupes = res && res.ok ? (res.dupes_skipped || 0) : 0;
    total += nWritten;
    contributions.push({ kind: src.kind, n_written: nWritten, dupes_skipped: dupes, ...(res && res.ok ? {} : { error: res && res.error }) });
  }

  return {
    ok: true,
    version: INGEST_VERSION,
    source_type: 'combined',
    namespace,
    n_written: total,
    contributions,
    path: rawPairsPath(namespace),
  };
}

// ---- A1: --data <file> -------------------------------------------------------

export async function ingestData(filePath, opts = {}) {
  const abs = path.resolve(filePath);
  let st;
  try { st = await fsp.stat(abs); }
  catch (e) { throw new Error(`ingestData: cannot read ${filePath}: ${e.message}`); }

  if (st.isDirectory()) {
    return ingestDataDir(abs, opts);
  }
  const ext = path.extname(abs).toLowerCase();
  if (PARQUET_EXTS.has(ext)) {
    throw new Error(`ingestData: .parquet not yet supported by the CLI. Convert with: python -c "import pandas; pandas.read_parquet('${path.basename(abs)}').to_csv('${path.basename(abs, ext)}.csv', index=False)"`);
  }
  if (XLSX_EXTS.has(ext)) {
    throw new Error(`ingestData: .xlsx/.xls not supported. Save the sheet as .csv first.`);
  }
  if (!SUPPORTED_DATA_EXTS.has(ext)) {
    throw new Error(`ingestData: unsupported extension '${ext}'. Supported: ${[...SUPPORTED_DATA_EXTS].join(', ')}.`);
  }
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`ingestData: file is ${(st.size / 1e6).toFixed(1)} MB; cap is 500 MB. Split into chunks or run on a smaller sample.`);
  }

  const text = await fsp.readFile(abs, 'utf8');
  const filename = path.basename(abs);
  let rawRows = [];

  if (ext === '.csv' || ext === '.tsv') {
    rawRows = parseCsvFile(text, ext === '.tsv' ? '\t' : null, filename, opts);
  } else if (ext === '.jsonl' || ext === '.ndjson') {
    rawRows = parseJsonlFile(text, filename);
  } else if (ext === '.json') {
    rawRows = parseJsonFile(text, filename);
  }

  const { rows, stats } = filterRows(rawRows);
  return {
    source_type: 'upload',
    rows,
    stats: {
      file: filename,
      file_bytes: st.size,
      file_sha256: sha256(text),
      raw_rows: rawRows.length,
      ...stats,
    },
  };
}

async function ingestDataDir(absDir, opts) {
  const entries = await fsp.readdir(absDir, { withFileTypes: true });
  const files = entries.filter(e => e.isFile() && SUPPORTED_DATA_EXTS.has(path.extname(e.name).toLowerCase()));
  const allRaw = [];
  const perFile = [];
  for (const e of files) {
    try {
      const r = await ingestData(path.join(absDir, e.name), opts);
      perFile.push({ file: e.name, kept: r.stats.kept });
      allRaw.push(...r.rows);
    } catch (err) {
      perFile.push({ file: e.name, error: err.message });
    }
  }
  const { rows, stats } = filterRows(allRaw);
  return {
    source_type: 'upload',
    rows,
    stats: {
      directory: absDir,
      files_scanned: files.length,
      per_file: perFile,
      raw_rows: allRaw.length,
      ...stats,
    },
  };
}

function parseCsvFile(text, forcedDelim, filename, opts) {
  const firstLine = text.split(/\r?\n/).find(l => l.trim().length > 0) || '';
  const delim = forcedDelim || detectDelimiter(firstLine);
  const grid = parseCsv(text, { delimiter: delim });
  if (grid.length < 2) return [];
  const header = grid[0].map(h => String(h).trim());
  const inPick = pickColumn(header, INPUT_COL_PATTERNS, opts.inputCol);
  const outPick = pickColumn(header, OUTPUT_COL_PATTERNS, opts.outputCol);
  if (inPick.index < 0 || outPick.index < 0) {
    const reason = inPick.index < 0 && outPick.index < 0
      ? 'no input or output column detected'
      : inPick.index < 0 ? `no input column detected (looked for ${INPUT_COL_PATTERNS.slice(0, 4).join('/')})`
      : `no output column detected (looked for ${OUTPUT_COL_PATTERNS.slice(0, 4).join('/')})`;
    throw new Error(`ingestData: ${reason} in ${filename}. headers: [${header.join(', ')}]. Pass --input-col X --output-col Y to disambiguate.`);
  }
  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    // Empty fields are pushed through so filterRows can count the drop —
    // silent drops here would hide bad-data signals from the user.
    const input = row.length > inPick.index ? String(row[inPick.index] || '').trim() : '';
    const output = row.length > outPick.index ? String(row[outPick.index] || '').trim() : '';
    rows.push({ input, output, source: `${filename}:${i + 1}` });
  }
  return rows;
}

function parseJsonlFile(text, filename) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln || ln.startsWith('//') || ln.startsWith('#')) continue;
    try {
      const parsed = JSON.parse(ln);
      rows.push(...extractPairsFromJsonObjects([parsed], filename, i + 1));
    } catch { /* skip bad line */ }
  }
  return rows;
}

function parseJsonFile(text, filename) {
  try {
    const parsed = JSON.parse(text);
    return extractPairsFromJsonObjects(parsed, filename, 1);
  } catch { return []; }
}

// ---- A2: --describe "..." ----------------------------------------------------

export async function ingestDescribe(description, opts = {}) {
  // W921 dual-signature: an object arg carrying a `namespace` selects the
  // persistent INGEST-stage path (writes empty-output seed prompts to disk).
  if (description && typeof description === 'object' && !Array.isArray(description) && 'namespace' in description) {
    return ingestDescribeStage(description);
  }
  const desc = String(description || '').trim();
  if (!desc) throw new Error('ingestDescribe: description is empty');
  if (desc.length > 16000) throw new Error(`ingestDescribe: description is ${desc.length} chars; cap is 16000.`);
  const wanted = Math.max(1, Math.min(opts.count || DEFAULT_DESCRIBE_COUNT, 2000));
  const budgetUsd = Number.isFinite(opts.budgetUsd) ? Number(opts.budgetUsd) : DEFAULT_BUDGET_USD;

  // Cost estimate: ~$0.002/pair via the teacher council; abort if over budget.
  const estimatedCost = wanted * 0.002;
  if (estimatedCost > budgetUsd) {
    throw new Error(`ingestDescribe: requested ${wanted} pairs costs ~$${estimatedCost.toFixed(2)} but --budget-usd is $${budgetUsd.toFixed(2)}. Lower --count or raise --budget-usd.`);
  }

  const teacherBase = opts.teacherBaseUrl || process.env.KOLM_TEACHER_BASE_URL || null;
  const teacherKey = opts.teacherKey || process.env.KOLM_TEACHER_API_KEY || null;

  if (teacherBase) {
    // Teacher-backed path. Streams batches of 20 pairs per call to keep latency
    // bounded; on any HTTP failure, fall through to the bootstrap path so the
    // compile pipeline keeps moving (with a clearly-marked synthetic source).
    try {
      const rows = await synthesizeViaTeacher(desc, wanted, { teacherBase, teacherKey, onProgress: opts.onProgress });
      const { rows: kept, stats } = filterRows(rows);
      return {
        source_type: 'describe',
        rows: kept,
        stats: {
          description_chars: desc.length,
          description_sha256: sha256(desc),
          requested: wanted,
          generated: rows.length,
          budget_usd_cap: budgetUsd,
          estimated_cost_usd: estimatedCost,
          teacher: teacherBase,
          mode: 'teacher',
          ...stats,
        },
      };
    } catch (e) {
      // Fall through to bootstrap.
      if (opts.onProgress) opts.onProgress({ stage: 'teacher-fallback', detail: e.message });
    }
  }

  // Bootstrap path: emit a small number of self-supervised seed scaffolds that
  // make the describe-only compile path runnable end-to-end without a teacher.
  // The scaffolds carry a `synthetic_bootstrap:true` marker so downstream eval
  // knows these are NOT teacher-derived.
  const rows = bootstrapSeedsFromDescription(desc, Math.min(wanted, 20));
  return {
    source_type: 'describe',
    rows,
    stats: {
      description_chars: desc.length,
      description_sha256: sha256(desc),
      requested: wanted,
      generated: rows.length,
      budget_usd_cap: budgetUsd,
      estimated_cost_usd: 0,
      mode: 'bootstrap',
      note: 'no KOLM_TEACHER_BASE_URL configured; using bootstrap scaffolds. Set KOLM_TEACHER_BASE_URL for full synthetic generation.',
    },
  };
}

// W921 — object-arg entry consumed by the autopilot bootstrap. Seeds the
// namespace's persistent raw-pairs.jsonl (empty-output prompts, no teacher
// spend) and returns the {ok:true, rows, n_written, path, dupes_skipped}
// envelope the bootstrap gates on (it reads seed.ok, seed.n_written,
// seed.path, seed.dupes_skipped). Errors surface as {ok:false, error}.
export async function ingestDescribeEngine({ tenant, namespace, description, n, count } = {}) {
  const want = n != null ? n : count;
  const result = await ingestDescribeStage({
    namespace,
    description,
    n: want != null ? Number(want) : DEFAULT_SEED_TARGET_ENGINE,
  });
  // Preserve tenant on the envelope for callers that thread it through.
  return tenant != null ? { ...result, tenant } : result;
}

const DEFAULT_SEED_TARGET_ENGINE = 8;

async function synthesizeViaTeacher(description, count, { teacherBase, teacherKey, onProgress }) {
  const out = [];
  const batchSize = 20;
  const batches = Math.ceil(count / batchSize);
  for (let b = 0; b < batches; b++) {
    const want = Math.min(batchSize, count - out.length);
    const prompt = `Generate exactly ${want} training pairs as a JSON array of objects {input, output} for a model with this task description:\n\n${description}\n\nReturn ONLY the JSON array, no prose.`;
    let res;
    try {
      res = await fetch(`${teacherBase.replace(/\/$/, '')}/v1/teacher/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(teacherKey ? { authorization: `Bearer ${teacherKey}` } : {}),
        },
        body: JSON.stringify({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (e) {
      throw new Error(`teacher network error: ${e.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`teacher HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => null);
    const text = data && (data.text || data.message || data.content) || '';
    let arr = [];
    try {
      const m = String(text).match(/\[[\s\S]*\]/);
      if (m) arr = JSON.parse(m[0]);
    } catch { /* drop batch */ }
    for (const pair of (Array.isArray(arr) ? arr : [])) {
      if (pair && pair.input != null && pair.output != null) {
        out.push({ input: String(pair.input), output: String(pair.output), source: `describe:teacher:b${b + 1}` });
      }
    }
    if (onProgress) onProgress({ stage: 'describe-batch', done: out.length, total: count, batch: b + 1, batches });
    if (out.length >= count) break;
  }
  return out;
}

function bootstrapSeedsFromDescription(description, n) {
  // Lightweight seed scaffolds: pair the description with N few-shot stub
  // prompts so the rest of the compile pipeline has something to chew on.
  // The seeds are CLEARLY marked synthetic_bootstrap so they don't masquerade
  // as teacher output.
  const seeds = [];
  const stubs = [
    'Example A: minimal request',
    'Example B: typical request',
    'Example C: edge-case request',
    'Example D: malformed request',
    'Example E: long request',
    'Example F: short request',
    'Example G: multilingual request',
    'Example H: technical request',
    'Example I: casual request',
    'Example J: formal request',
  ];
  for (let i = 0; i < n; i++) {
    const stub = stubs[i % stubs.length];
    seeds.push({
      input: `[${stub}] ${description}`,
      output: `[bootstrap-output ${i + 1}] Pending teacher synthesis. Re-run with KOLM_TEACHER_BASE_URL set to expand this seed.`,
      source: `describe:bootstrap:${i + 1}`,
      synthetic_bootstrap: true,
    });
  }
  return seeds;
}

// ---- A3: --docs <folder> -----------------------------------------------------

export async function ingestDocs(folderPath, opts = {}) {
  // W921 dual-signature: an object arg carrying `namespace`/`docs_dir` selects
  // the persistent INGEST-stage path (writes chunk pairs to raw-pairs.jsonl).
  if (folderPath && typeof folderPath === 'object' && !Array.isArray(folderPath)
      && ('namespace' in folderPath || 'docs_dir' in folderPath)) {
    return ingestDocsStage(folderPath);
  }
  const abs = path.resolve(folderPath);
  let st;
  try { st = await fsp.stat(abs); }
  catch (e) { throw new Error(`ingestDocs: cannot read ${folderPath}: ${e.message}`); }
  if (!st.isDirectory()) throw new Error(`ingestDocs: ${folderPath} is not a directory`);

  const files = await walkDocs(abs);
  if (files.length === 0) {
    throw new Error(`ingestDocs: no .md/.txt/.html files under ${abs}. Add documents or point at a different folder.`);
  }

  const allChunks = [];
  const perFile = [];
  const errors = [];

  for (const f of files) {
    try {
      const fst = await fsp.stat(f);
      if (fst.size > MAX_DOC_BYTES) {
        errors.push({ file: f, error: `${(fst.size / 1e6).toFixed(1)} MB exceeds 5 MB cap; split it.` });
        continue;
      }
      const ext = path.extname(f).toLowerCase();
      let text = await fsp.readFile(f, 'utf8');
      if (ext === '.html' || ext === '.htm') text = stripHtml(text);
      const chunks = chunkDocument(text, ext);
      allChunks.push(...chunks.map(c => ({ ...c, file: f })));
      perFile.push({ file: path.basename(f), chunks: chunks.length });
    } catch (e) {
      errors.push({ file: f, error: e.message });
    }
  }

  // Pair extraction: for each chunk, prefer explicit Q/A patterns; otherwise
  // emit a single (heading -> body) pair as a safe default.
  const rawRows = [];
  for (const chunk of allChunks) {
    const pairs = extractPairsFromText(chunk.text, chunk.file);
    if (pairs.length > 0) {
      rawRows.push(...pairs);
    } else if (chunk.heading && chunk.body && chunk.body.length > 20) {
      // Heading-as-question fallback.
      rawRows.push({
        input: chunk.heading,
        output: chunk.body.length > MAX_ROW_CHARS ? chunk.body.slice(0, MAX_ROW_CHARS) : chunk.body,
        source: `${chunk.file}:${chunk.line || 1}`,
      });
    }
  }

  // Near-dup filter on input (string-distance; embedding-free).
  const deduped = dedupeNearDup(rawRows);
  const { rows, stats } = filterRows(deduped);

  return {
    source_type: 'docs',
    rows,
    stats: {
      folder: abs,
      files_scanned: files.length,
      chunks: allChunks.length,
      per_file: perFile.slice(0, 50),
      errors: errors.slice(0, 50),
      raw_rows: rawRows.length,
      near_dup_dropped: rawRows.length - deduped.length,
      ...stats,
    },
  };
}

async function walkDocs(absDir) {
  const out = [];
  async function recurse(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        await recurse(full);
      } else if (e.isFile() && DOC_EXTS.has(path.extname(e.name).toLowerCase())) {
        out.push(full);
      } else if (e.isFile() && PDF_EXTS.has(path.extname(e.name).toLowerCase())) {
        // Skip silently for now; logged via caller's error list if desired.
      }
    }
  }
  await recurse(absDir);
  return out;
}

function chunkDocument(text, ext) {
  // .md: split on ATX headings (`#`, `##`, ...) — heading text is the chunk
  //      heading, body is everything until the next heading.
  // .txt/.html: split on blank-line paragraphs; first paragraph treated as
  //      pseudo-heading if it ends without punctuation.
  if (ext === '.md' || ext === '.markdown' || ext === '.rst') {
    const lines = text.split(/\r?\n/);
    const chunks = [];
    let current = { heading: '', body: '', line: 1 };
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const h = ln.match(/^#{1,6}\s+(.*)$/);
      if (h) {
        if (current.heading || current.body.trim()) chunks.push({ ...current, text: (current.heading ? `# ${current.heading}\n` : '') + current.body });
        current = { heading: h[1].trim(), body: '', line: i + 1 };
      } else {
        current.body += (current.body ? '\n' : '') + ln;
      }
    }
    if (current.heading || current.body.trim()) chunks.push({ ...current, text: (current.heading ? `# ${current.heading}\n` : '') + current.body });
    return chunks;
  }
  // Paragraph split.
  const paras = text.split(/\n{2,}/);
  return paras
    .map((p, i) => ({ heading: '', body: p.trim(), line: i + 1, text: p.trim() }))
    .filter(p => p.body.length > 0);
}

function dedupeNearDup(rows) {
  const out = [];
  const seenInputs = [];
  for (const r of rows) {
    const i = String(r.input).trim().toLowerCase();
    let dup = false;
    for (const prev of seenInputs) {
      if (Math.abs(prev.length - i.length) > 8) continue;
      if (levenshteinAtMost(i, prev, 4)) { dup = true; break; }
    }
    if (dup) continue;
    seenInputs.push(i);
    out.push(r);
  }
  return out;
}

function levenshteinAtMost(a, b, max) {
  // Returns true if edit distance(a,b) <= max. Banded DP.
  if (Math.abs(a.length - b.length) > max) return false;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return false;
    [prev, curr] = [curr, prev];
  }
  return prev[n] <= max;
}

// ---- A4: --combined ---------------------------------------------------------

export function mergeAndDedupe(arrays) {
  // arrays: [{source_type, rows, stats}, ...]
  // Returns: {rows, stats:{by_source:{upload, describe, docs}, merged, after_dedupe}}
  const all = [];
  const bySource = {};
  for (const r of arrays) {
    if (!r || !Array.isArray(r.rows)) continue;
    bySource[r.source_type] = (bySource[r.source_type] || 0) + r.rows.length;
    all.push(...r.rows);
  }
  const { rows } = filterRows(all);
  return {
    rows,
    stats: {
      by_source: bySource,
      merged: all.length,
      after_dedupe: rows.length,
    },
  };
}

// ---- Spec synthesis ---------------------------------------------------------

export function synthesizeSpec(rows, opts = {}) {
  const baseModel = opts.baseModel || 'Qwen/Qwen2.5-3B-Instruct';
  const taskDescription = opts.description || opts.task || `Train on ${rows.length} provided pairs`;
  const namespace = opts.namespace || 'data-ingest';
  const passport = opts.passport || {};
  return {
    job_id: 'job_' + Math.random().toString(16).slice(2, 10),
    task: taskDescription,
    base_model: baseModel,
    corpus_namespace: namespace,
    examples: rows.length,
    epochs: opts.epochs || 3,
    batch_size: opts.batchSize || 4,
    seq_len: opts.seqLen || 1024,
    recipes: [],
    evals: {
      spec: 'rs-1-evals',
      n: rows.length,
      cases: rows.map((r, i) => ({
        id: `data_ingest_${i + 1}`,
        input: r.input,
        expected: r.output,
        source: r.source || 'data-ingest',
      })),
      coverage: 0,
    },
    data_ingest: {
      sources: passport,
      total_rows: rows.length,
      generated_at: new Date().toISOString(),
    },
  };
}

// ---- Helper: write seeds.jsonl from rows ------------------------------------

export function writeSeedsJsonl(rows, outPath) {
  const lines = rows.map(r => JSON.stringify({ input: r.input, expected: r.output, source: r.source || 'data-ingest' }));
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  return outPath;
}

// ---- Helper: format stats for CLI -------------------------------------------

export function formatStats(stats) {
  const lines = [];
  if (stats.file) lines.push(`  file:        ${stats.file}`);
  if (stats.directory) lines.push(`  directory:   ${stats.directory}`);
  if (stats.folder) lines.push(`  folder:      ${stats.folder}`);
  if (stats.files_scanned != null) lines.push(`  files:       ${stats.files_scanned}`);
  if (stats.chunks != null) lines.push(`  chunks:      ${stats.chunks}`);
  if (stats.raw_rows != null) lines.push(`  raw pairs:   ${stats.raw_rows}`);
  if (stats.dropped_empty != null) lines.push(`  dropped empty: ${stats.dropped_empty}`);
  if (stats.dropped_dup != null) lines.push(`  dropped dup:   ${stats.dropped_dup}`);
  if (stats.dropped_long != null) lines.push(`  dropped long:  ${stats.dropped_long}`);
  if (stats.near_dup_dropped) lines.push(`  near-dup:      ${stats.near_dup_dropped}`);
  if (stats.kept != null) lines.push(`  KEPT:        ${stats.kept}`);
  if (stats.mode) lines.push(`  mode:        ${stats.mode}`);
  if (stats.estimated_cost_usd != null) lines.push(`  est. cost:   $${Number(stats.estimated_cost_usd).toFixed(4)}`);
  return lines.join('\n');
}
