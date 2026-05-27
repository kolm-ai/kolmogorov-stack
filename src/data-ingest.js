// src/data-ingest.js
//
// W910 Track A — Data Ingestion.
//
// Three importer paths that turn real customer artifacts into the
// {input, output, source}[] shape the rest of the compile pipeline already
// understands. All three feed cmdCompile (cli/kolm.js) via the
// --data / --describe / --docs flags; the combined form merges all three.
//
// Exports:
//   ingestData(filePath, opts)     - .csv/.tsv/.jsonl/.json (parquet rejected with hint)
//   ingestDescribe(text, opts)     - synthetic seed expansion (teacher-backed if KOLM_TEACHER_BASE_URL)
//   ingestDocs(folderPath, opts)   - .md/.txt/.html walk + Q&A extraction
//   mergeAndDedupe(arrays)         - sha1(input) dedupe across sources
//   synthesizeSpec(rows, opts)     - minimal spec.json so the pipeline can fall through
//
// No new npm deps. Reuses parseCsv + extractPairsFromJsonObjects + stripHtml
// from src/seeds-mining.js so the parsing rules stay in one place.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCsv, extractPairsFromJsonObjects, extractPairsFromText, stripHtml } from './seeds-mining.js';

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
