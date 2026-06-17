// kolm tui — a full-screen, drag-drop friendly TUI.
//
// Drag-and-drop: when a user drops a file onto a terminal, the OS pastes
// the file *path* into the input buffer. The TUI watches every line for
// a *.kolm path (quoted or not, with or without surrounding whitespace),
// auto-strips quotes, validates it exists, and ingests it with a frame
// animation. No drivers, no deps.
//
// :serve — spins up a tiny http server bound to 127.0.0.1 that exposes
// the loaded artifact as POST /v1/run, so users can hit it from curl,
// Postman, Claude, etc. as easily as they hit kolm.ai.
//
// Brand colors match the neo-lab theme used on the web:
//   good   = #7ef0d2   accent green (success / verbs)
//   accent = #b3a8ff   electric lavender (k-score / ring 4)
//   bad    = #ff7e8a   alert red (errors only)
//   mute   = #6a7a85   ink-mute (chrome)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

// ---------- ANSI ---------------------------------------------------------
const ESC = '[';
const RESET = ESC + '0m';
const BOLD = ESC + '1m';
const DIM = ESC + '2m';
const FAINT = ESC + '2;37m';
const HIDE_CURSOR = ESC + '?25l';
const SHOW_CURSOR = ESC + '?25h';
const CLEAR_LINE = ESC + '2K\r';
const ALT_BUFFER_IN = ESC + '?1049h';
const ALT_BUFFER_OUT = ESC + '?1049l';

// truecolor 24-bit. fall back to 256-color in the rare TERM where this fails.
function rgb(r, g, b) { return ESC + '38;2;' + r + ';' + g + ';' + b + 'm'; }
function bgRgb(r, g, b) { return ESC + '48;2;' + r + ';' + g + ';' + b + 'm'; }
const C = {
  good:   rgb(126, 240, 210),
  accent: rgb(179, 168, 255),
  bad:    rgb(255, 126, 138),
  mute:   rgb(106, 122, 133),
  ink:    rgb(220, 230, 235),
  ring:   rgb(70,  220, 180),
};

function w(s) { process.stdout.write(s); }
function wln(s) { process.stdout.write((s || '') + '\n'); }
function clear() { w(ESC + '2J' + ESC + 'H'); }
function moveTo(row, col) { w(ESC + row + ';' + col + 'H'); }

// ---------- logo ---------------------------------------------------------
// Plain block-letter logo built for the neo-lab brand. Short enough to fit
// in 80×24 terminals while staying readable when the splash plays.
const LOGO = [
  '   __ __   ___    __    __  ___',
  '  / //_/  / _ \\  / /   /  |/  /',
  ' /   <_  / // / / /__ / /|_/ / ',
  '/_/|_(_)\\___/ /____//_/  /_/  ',
];

// ---------- splash animation --------------------------------------------
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function splash() {
  clear();
  w(HIDE_CURSOR);
  // Slow fade-in line by line.
  for (let i = 0; i < LOGO.length; i++) {
    wln('  ' + C.good + LOGO[i] + RESET);
    await sleep(70);
  }
  wln('');
  // Tagline typewriter.
  const tag = '   your AI · yours forever · audited every call';
  w('  ' + C.mute);
  for (let i = 0; i < tag.length; i++) {
    w(tag[i]);
    if (i % 3 === 0) await sleep(8);
  }
  wln(RESET);
  await sleep(120);
  // Spinner row
  const spinner = ['◜', '◝', '◞', '◟'];
  const steps = [
    'loading runtime',
    'verifying signing key',
    'opening artifact registry',
    'ready',
  ];
  for (let s = 0; s < steps.length; s++) {
    for (let k = 0; k < 6; k++) {
      w(CLEAR_LINE + '  ' + C.accent + spinner[k % spinner.length] + '  ' + C.mute + steps[s] + '…' + RESET);
      await sleep(40);
    }
  }
  w(CLEAR_LINE + '  ' + C.good + '●  ' + C.ink + 'ready' + RESET + '\n\n');
  w(SHOW_CURSOR);
}

// ---------- frame helpers -----------------------------------------------
function hr() {
  const cols = Math.min(process.stdout.columns || 80, 100);
  return C.mute + '─'.repeat(cols - 2) + RESET;
}

function box(title, lines) {
  const cols = Math.min(process.stdout.columns || 80, 100);
  const inner = cols - 4;
  const out = [];
  out.push(C.mute + '┌─ ' + C.ink + BOLD + title + RESET + ' ' + C.mute + '─'.repeat(Math.max(0, inner - title.length - 2)) + '┐' + RESET);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const visible = stripAnsi(raw);
    const pad = ' '.repeat(Math.max(0, inner - visible.length));
    out.push(C.mute + '│ ' + RESET + raw + pad + C.mute + ' │' + RESET);
  }
  out.push(C.mute + '└' + '─'.repeat(inner + 2) + '┘' + RESET);
  return out.join('\n');
}

function stripAnsi(s) {
  return String(s).replace(/\[[0-9;]*m/g, '');
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- .kolm parser (zip → manifest.json) --------------------------
//
// Tiny pure-Node zip reader. We only need to extract a few JSON files at
// known names; we do not need full DEFLATE for every entry. Most .kolm
// metadata files are STORED (no compression) or short enough that decoding
// via zlib.inflateRawSync is cheap.
import zlib from 'node:zlib';

// ZIP64 sentinel: any 32-bit size/offset field equal to 0xFFFFFFFF means the
// real value lives in the per-entry ZIP64 extra field (header id 0x0001).
const Z64_U32 = 0xFFFFFFFF;
const Z64_U16 = 0xFFFF;

// Read a 64-bit little-endian unsigned int as a JS number. .kolm metadata
// offsets are always < 2^53, so Number() is exact here; the central directory
// of a multi-GB GPU-trained bundle still sits well under that ceiling.
function readU64LE(buf, off) {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
  return hi * 0x100000000 + lo;
}

// Walk a ZIP64 extra field and pull out (uncompSize, compSize, localOff) in the
// order the spec mandates: each present ONLY when its 32-bit counterpart was the
// 0xFFFFFFFF sentinel. `need` flags which slots to consume.
function parseZip64Extra(buf, extraStart, extraLen, need) {
  const out = {};
  let q = extraStart;
  const extraEnd = extraStart + extraLen;
  while (q + 4 <= extraEnd) {
    const id = buf.readUInt16LE(q);
    const sz = buf.readUInt16LE(q + 2);
    const body = q + 4;
    if (id === 0x0001) {
      let r = body;
      if (need.uncomp && r + 8 <= body + sz) { out.uncompSize = readU64LE(buf, r); r += 8; }
      if (need.comp && r + 8 <= body + sz) { out.compSize = readU64LE(buf, r); r += 8; }
      if (need.localOff && r + 8 <= body + sz) { out.localOff = readU64LE(buf, r); r += 8; }
      break;
    }
    q = body + sz;
  }
  return out;
}

function readZipEntries(buf) {
  // End of central directory record (EOCD) is in the last 22..(22+0xFFFF) bytes.
  const len = buf.length;
  let eocdOff = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error('not a zip (no EOCD)');
  let cdSize = buf.readUInt32LE(eocdOff + 12);
  let cdOff = buf.readUInt32LE(eocdOff + 16);

  // ZIP64: when the classic EOCD sentinels its counts/sizes/offset, the true
  // values live in the ZIP64 EOCD record, located via the ZIP64 EOCD locator
  // (sig 0x07064b50) sitting immediately before the classic EOCD.
  if (cdSize === Z64_U32 || cdOff === Z64_U32 || buf.readUInt16LE(eocdOff + 10) === Z64_U16) {
    const locOff = eocdOff - 20;
    if (locOff >= 0 && buf.readUInt32LE(locOff) === 0x07064b50) {
      const z64EocdOff = readU64LE(buf, locOff + 8);
      if (z64EocdOff >= 0 && z64EocdOff + 56 <= len && buf.readUInt32LE(z64EocdOff) === 0x06064b50) {
        cdSize = readU64LE(buf, z64EocdOff + 40);
        cdOff = readU64LE(buf, z64EocdOff + 48);
      }
    }
  }

  const entries = [];
  let p = cdOff;
  const end = cdOff + cdSize;
  while (p < end) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // Per-entry ZIP64 extra (header id 0x0001) overrides any 0xFFFFFFFF slot.
    if (compSize === Z64_U32 || uncompSize === Z64_U32 || localOff === Z64_U32) {
      const z64 = parseZip64Extra(buf, p + 46 + nameLen, extraLen, {
        uncomp: uncompSize === Z64_U32,
        comp: compSize === Z64_U32,
        localOff: localOff === Z64_U32,
      });
      if (z64.uncompSize != null) uncompSize = z64.uncompSize;
      if (z64.compSize != null) compSize = z64.compSize;
      if (z64.localOff != null) localOff = z64.localOff;
    }
    entries.push({ name, method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  // Local file header at entry.localOff
  if (buf.readUInt32LE(entry.localOff) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(entry.localOff + 26);
  const extraLen = buf.readUInt16LE(entry.localOff + 28);
  const dataOff = entry.localOff + 30 + nameLen + extraLen;
  const data = buf.slice(dataOff, dataOff + entry.compSize);
  if (entry.method === 0) return data; // stored
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error('unsupported zip method ' + entry.method);
}

function readJSONFromZip(buf, entries, name) {
  const e = entries.find(function (x) { return x.name === name; });
  if (!e) return null;
  try {
    const raw = readZipEntry(buf, e);
    if (!raw) return null;
    return JSON.parse(raw.toString('utf8'));
  } catch (err) {
    return null;
  }
}

// Streaming metadata read: for large (multi-GB GPU-trained) bundles we never
// want to slurp the whole file into memory. We read only the tail (EOCD +
// central directory) to enumerate entries, then read just the handful of local
// JSON entries we actually render. Falls back to the in-memory path for small
// files (cheaper than two opens) or if the tail heuristic comes up short.
const TAIL_WINDOW = 4 * 1024 * 1024; // 4 MB is plenty for a CD + ZIP64 EOCD.
const SMALL_FILE = 16 * 1024 * 1024; // <=16 MB: just buffer it.

function readRange(fd, start, length) {
  const out = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, out, got, length - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? out : out.slice(0, got);
}

// Read one named JSON entry from disk by seeking to its local header. The CD
// entry gives us localOff + compSize so we read only that slice, not the file.
function readJSONStreamed(fd, entry) {
  if (!entry) return null;
  // Local header is 30 bytes + nameLen + extraLen, both read from the header.
  const lh = readRange(fd, entry.localOff, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) return null;
  const nameLen = lh.readUInt16LE(26);
  const extraLen = lh.readUInt16LE(28);
  const dataOff = entry.localOff + 30 + nameLen + extraLen;
  const data = readRange(fd, dataOff, entry.compSize);
  try {
    let raw = data;
    if (entry.method === 8) raw = zlib.inflateRawSync(data);
    else if (entry.method !== 0) return null;
    return JSON.parse(raw.toString('utf8'));
  } catch (e) { return null; }
}

function parseKolmStreamed(filePath, sizeBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const tailLen = Math.min(TAIL_WINDOW, sizeBytes);
    const tailStart = sizeBytes - tailLen;
    const tail = readRange(fd, tailStart, tailLen);
    // readZipEntries works on a buffer whose offsets are file-absolute; rebase
    // by reading the CD from the tail but resolving local entries against fd.
    // We locate EOCD within the tail and adjust cd offsets to tail-relative.
    let eocdOff = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
    }
    if (eocdOff < 0) throw new Error('CD not in tail window');
    let cdSize = tail.readUInt32LE(eocdOff + 12);
    let cdOff = tail.readUInt32LE(eocdOff + 16);
    if (cdSize === Z64_U32 || cdOff === Z64_U32 || tail.readUInt16LE(eocdOff + 10) === Z64_U16) {
      const locOff = eocdOff - 20;
      if (locOff >= 0 && tail.readUInt32LE(locOff) === 0x07064b50) {
        const z64EocdAbs = readU64LE(tail, locOff + 8);
        const z64Rel = z64EocdAbs - tailStart;
        if (z64Rel >= 0 && z64Rel + 56 <= tail.length && tail.readUInt32LE(z64Rel) === 0x06064b50) {
          cdSize = readU64LE(tail, z64Rel + 40);
          cdOff = readU64LE(tail, z64Rel + 48);
        }
      }
    }
    const cdRel = cdOff - tailStart;
    if (cdRel < 0 || cdRel + cdSize > tail.length) throw new Error('CD outside tail window');
    // Build a synthetic buffer whose CD lives at the correct tail-relative spot
    // so readZipEntries can parse it; entry.localOff stays file-absolute.
    const cdBuf = Buffer.allocUnsafe(cdOff + cdSize);
    tail.copy(cdBuf, cdOff, cdRel, cdRel + cdSize);
    // Re-point the synthetic EOCD so readZipEntries finds it.
    const synthEocd = Buffer.allocUnsafe(22);
    tail.copy(synthEocd, 0, eocdOff, eocdOff + 22);
    synthEocd.writeUInt32LE(Math.min(cdSize, Z64_U32), 12);
    synthEocd.writeUInt32LE(Math.min(cdOff, Z64_U32), 16);
    const full = Buffer.concat([cdBuf, synthEocd]);
    const entries = readZipEntries(full);
    const find = (n) => entries.find((x) => x.name === n) || null;
    const manifest = readJSONStreamed(fd, find('manifest.json'));
    if (!manifest) throw new Error('no manifest.json — is this a .kolm artifact?');
    return {
      filePath, fileName: path.basename(filePath), sizeBytes,
      manifest,
      recipes: readJSONStreamed(fd, find('recipes.json')),
      receipt: readJSONStreamed(fd, find('receipt.json')),
      evals: readJSONStreamed(fd, find('evals.json')),
      entryCount: entries.length,
      streamed: true,
    };
  } finally {
    fs.closeSync(fd);
  }
}

async function parseKolm(filePath) {
  const sizeBytes = fs.statSync(filePath).size;
  // Large bundles: stream the tail + needed entries, never buffer the whole file.
  if (sizeBytes > SMALL_FILE) {
    try { return parseKolmStreamed(filePath, sizeBytes); }
    catch (e) { /* fall through to buffered path below */ }
  }
  const buf = fs.readFileSync(filePath);
  const entries = readZipEntries(buf);
  const manifest = readJSONFromZip(buf, entries, 'manifest.json');
  if (!manifest) throw new Error('no manifest.json — is this a .kolm artifact?');
  const recipes = readJSONFromZip(buf, entries, 'recipes.json');
  const receipt = readJSONFromZip(buf, entries, 'receipt.json');
  const evals   = readJSONFromZip(buf, entries, 'evals.json');
  return {
    filePath: filePath,
    fileName: path.basename(filePath),
    sizeBytes: buf.length,
    manifest: manifest,
    recipes: recipes,
    receipt: receipt,
    evals: evals,
    entryCount: entries.length,
  };
}

// ---------- artifact ingest animation -----------------------------------
async function ingestAnimation(filePath) {
  const frames = [
    '◴ reading bytes',
    '◷ decompressing',
    '◶ verifying manifest',
    '◵ ringing receipt chain',
    '● ready',
  ];
  for (let i = 0; i < frames.length; i++) {
    const isLast = i === frames.length - 1;
    const color = isLast ? C.good : C.accent;
    w(CLEAR_LINE + '  ' + color + frames[i] + RESET + '   ' + C.mute + path.basename(filePath) + RESET);
    await sleep(160);
  }
  w('\n');
}

// ---------- card render --------------------------------------------------
function fmtKScore(v) {
  if (v == null) return '—';
  const n = (typeof v === 'object' && v.composite != null) ? v.composite : v;
  if (typeof n !== 'number') return '—';
  return n.toFixed(3);
}

function renderCard(art) {
  const m = art.manifest || {};
  const kScore = fmtKScore(m.k_score);
  const gate = (m.k_score && m.k_score.gate) ? m.k_score.gate : (m.gate || '—');
  const lines = [
    C.mute + 'task     ' + RESET + (m.task || art.fileName),
    C.mute + 'model    ' + RESET + (m.base_model || m.runtime || '—'),
    C.mute + 'k-score  ' + RESET + C.accent + kScore + RESET + '   ' + C.mute + 'gate=' + gate + RESET,
    C.mute + 'cid      ' + RESET + (m.cid ? (String(m.cid).slice(0, 28) + '…') : '—'),
    C.mute + 'size     ' + RESET + fmtBytes(art.sizeBytes) + '   ' + C.mute + 'entries=' + art.entryCount + RESET,
    '',
    C.mute + 'run      ' + RESET + C.good + ':run' + RESET + '  ' + C.good + ':serve' + RESET + '  ' + C.good + ':receipt' + RESET + '  ' + C.good + ':eval' + RESET,
    C.mute + 'workbench' + RESET + ' ' + C.good + ':tune' + RESET + '  ' + C.good + ':distill' + RESET + '  ' + C.good + ':curate' + RESET + '   ' + C.mute + ':help for all' + RESET,
  ];
  wln('');
  wln(box(' artifact ', lines));
  wln('');
}

// ---------- :run REPL (real artifact inference) -------------------------
//
// The TUI runs the loaded artifact through the SAME signed runtime the CLI
// and server use (src/artifact-runner.js `runArtifact`): it loads the .kolm,
// verifies its signature, and executes the real `generate(input, lib)` recipe
// in the node:vm sandbox. No mock, no substring matching — `:run` and `:serve`
// return exactly what the artifact computes, or a clear error if the runtime
// is unavailable (e.g. a gguf bundle with no llama-cli, or an invalid
// signature). The runner is imported lazily so TUI startup stays instant.
let _runArtifact = null;
async function getRunner() {
  if (!_runArtifact) {
    ({ runArtifact: _runArtifact } = await import('../src/artifact-runner.js'));
  }
  return _runArtifact;
}

// ---------- shared src/ module bridges (NO reimplemented logic) ----------
//
// atom #1: the interactive TUI is the most discoverable self-serve surface, yet
// the REAL tune / distill / eval / curate backends were invisible here. Rather
// than reimplement any of that logic (which would diverge from the CLI verbs),
// we import the exact same pure-JS src/ modules the CLI uses. Lazy-imported so
// TUI startup stays instant and a missing optional module never blocks load.
let _tune = null, _runnerMod = null, _curate = null;
async function getTune() {
  if (!_tune) _tune = await import('../src/tune.js');
  return _tune;
}
async function getRunnerMod() {
  if (!_runnerMod) _runnerMod = await import('../src/artifact-runner.js');
  return _runnerMod;
}
async function getCurate() {
  if (!_curate) _curate = await import('../src/data-curate.js');
  return _curate;
}

export async function realInfer(art, prompt) {
  const runArtifact = await getRunner();
  try {
    const r = await runArtifact(art.filePath, prompt);
    let text = r.output;
    if (typeof text !== 'string') {
      try { text = JSON.stringify(text); } catch (e) { text = String(text); } // deliberate: cleanup
    }
    return {
      text,
      ok: true,
      source: 'runtime:' + (r.runtime || 'js'),
      latency_us: r.latency_us,
      k_score: r.k_score,
    };
  } catch (e) {
    // Caveat path: surface the runtime error code, never a fake success.
    return {
      text: 'run failed: ' + ((e && (e.code || e.message)) || 'unknown error'),
      ok: false,
      source: 'error',
      error_code: (e && e.code) || 'KOLM_E_RUN_FAILED',
    };
  }
}

async function runPrompt(art, prompt) {
  const r = await realInfer(art, prompt);
  wln('');
  if (r.ok) {
    wln('  ' + C.good + '› ' + RESET + r.text);
    const ms = r.latency_us != null ? Math.max(1, Math.round(r.latency_us / 1000)) + 'ms' : '';
    wln('  ' + C.mute + r.source + (ms ? ' · ' + ms : '') + (r.k_score != null ? ' · K=' + r.k_score : '') + RESET);
  } else {
    wln('  ' + C.bad + '✗ ' + RESET + r.text);
    wln('  ' + C.mute + r.source + RESET);
  }
  wln('');
}

// ---------- :tune pane (wraps src/tune.js lifecycle) --------------------
//
// Drives the SAME tune lifecycle the CLI `kolm tune` verb uses: init / capture-
// on/off / step / eval / promote / status. No logic is reimplemented here - every
// action calls a src/tune.js export. The trainer (scripts/tune-step.py) is the
// real path; if its python deps are missing tune.runTuneStep throws a clear,
// actionable message which we surface verbatim (never a fake success).
async function tunePane(art, sub, rest) {
  if (!art) { wln('  ' + C.bad + 'load a .kolm first.' + RESET); return; }
  const tune = await getTune();
  const ap = art.filePath;
  const args = (rest || []).filter(Boolean);
  const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
  try {
    if (!sub || sub === 'status' || sub === 'summary') {
      const s = tune.summary(ap);
      if (!s.initialized) {
        wln('  ' + C.mute + 'tune not initialized. ' + RESET + C.good + ':tune init --base <model>' + RESET);
        return;
      }
      const lines = [
        C.mute + 'base      ' + RESET + (s.base_model || '—'),
        C.mute + 'head      ' + RESET + (s.head || '—') + '   ' + C.mute + 'revisions=' + (s.revisions || []).length + RESET,
        C.mute + 'captures  ' + RESET + s.captures + '   ' + C.mute + 'capturing=' + (s.captures_on ? C.good + 'on' : C.mute + 'off') + RESET,
        C.mute + 'gate      ' + RESET + (s.gate ? 'k_min=' + s.gate.k_min + ' require_improvement=' + s.gate.require_improvement : '—'),
        '',
        C.mute + 'verbs     ' + RESET + C.good + ':tune init|capture-on|capture-off|step|eval|promote' + RESET,
      ];
      wln('');
      wln(box(' tune · ' + art.fileName, lines));
      wln('');
    } else if (sub === 'init') {
      const base = flag('base') || flag('model');
      if (!base) { wln('  ' + C.bad + 'usage: :tune init --base <model>' + RESET); return; }
      const r = tune.initAdapter({ artifactPath: ap, baseModel: base });
      wln('  ' + (r.existed ? C.mute + 'already initialized at ' + r.revision : C.good + 'initialized ' + r.revision + ' for ' + base) + RESET);
    } else if (sub === 'capture-on') {
      tune.setCaptureFlag(ap, true);
      wln('  ' + C.good + 'capture ON' + RESET + '   ' + C.mute + 'subsequent :run inputs are collected for training.' + RESET);
    } else if (sub === 'capture-off') {
      tune.setCaptureFlag(ap, false);
      wln('  ' + C.mute + 'capture OFF' + RESET);
    } else if (sub === 'step') {
      const epochs = parseInt(flag('epochs'), 10) || 1;
      wln('  ' + C.accent + '◴ running SFT step (' + tune.captureCount(ap) + ' captures, ' + epochs + ' epoch' + (epochs > 1 ? 's' : '') + ')…' + RESET);
      const r = tune.runTuneStep({ artifactPath: ap, epochs: epochs, airgap: args.includes('--airgap') });
      wln('  ' + C.good + 'step complete → ' + r.revision + RESET + (r.stats ? '   ' + C.mute + JSON.stringify(r.stats).slice(0, 60) + RESET : ''));
    } else if (sub === 'eval') {
      const rev = flag('revision') || tune.headRevision(ap);
      if (!rev) { wln('  ' + C.bad + 'no revision to eval. :tune step first.' + RESET); return; }
      wln('  ' + C.accent + '◴ evaluating ' + rev + ' on held-out evals…' + RESET);
      const r = await tune.evalRevision({ artifactPath: ap, revision: rev });
      wln('  ' + C.good + rev + RESET + '   ' + C.mute + 'acc=' + RESET + (r.accuracy * 100).toFixed(1) + '%  '
        + C.mute + 'K=' + RESET + C.accent + fmtKScore(r.k_score) + RESET + '   ' + C.mute + r.pass + '/' + r.total + RESET);
    } else if (sub === 'promote') {
      const rev = flag('revision') || tune.headRevision(ap);
      if (!rev) { wln('  ' + C.bad + 'no revision to promote.' + RESET); return; }
      try {
        const r = await tune.promoteRevision({ artifactPath: ap, revision: rev, force: args.includes('--force') });
        wln('  ' + C.good + 'promoted ' + r.promoted + RESET + (r.previous ? '   ' + C.mute + '(was ' + r.previous + ')' + RESET : '')
          + '   ' + C.mute + 'K=' + RESET + C.accent + fmtKScore(r.k_score) + RESET);
      } catch (e) {
        if (e && e.code === 'K_GATE') wln('  ' + C.bad + 'gate blocked: ' + e.message + RESET + '   ' + C.mute + 'add --force to override (not recommended).' + RESET);
        else throw e;
      }
    } else {
      wln('  ' + C.bad + 'unknown :tune subcommand: ' + sub + RESET + '   ' + C.mute + 'try :tune status' + RESET);
    }
  } catch (e) {
    wln('  ' + C.bad + 'tune ' + (sub || 'status') + ' failed: ' + ((e && e.message) || 'unknown') + RESET);
  }
}

// ---------- :eval pane (held-out grading via real runtime) --------------
//
// Surfaces the holdout/leakage + K-score delta atom #1 asks for. Runs the
// artifact against its OWN embedded held-out grading set through the same
// signed runtime (artifact-runner.evalArtifact), then reports accuracy, p50
// latency and the K-score delta vs the manifest's recorded K-score. The grading
// set is the disjoint holdout baked into the .kolm at compile time - we never
// re-derive it or weaken the split (moat: fail-closed holdout disjointness).
async function evalPane(art) {
  if (!art) { wln('  ' + C.bad + 'load a .kolm first.' + RESET); return; }
  try {
    const { evalArtifact } = await getRunnerMod();
    wln('  ' + C.accent + '◴ grading on embedded held-out set…' + RESET);
    const r = await evalArtifact(art.filePath);
    if (!r.n) {
      wln('  ' + C.mute + 'no held-out evals embedded in this artifact.' + RESET);
      return;
    }
    const manifestK = (art.manifest && art.manifest.k_score) ? fmtKScore(art.manifest.k_score) : null;
    const liveAcc = (r.accuracy * 100).toFixed(1) + '%';
    const ms = r.p50_latency_us != null ? Math.max(1, Math.round(r.p50_latency_us / 1000)) + 'ms p50' : '—';
    const lines = [
      C.mute + 'cases     ' + RESET + r.n + '   ' + C.mute + 'passed=' + RESET + r.passed + '   ' + C.mute + 'source=' + r.source + RESET,
      C.mute + 'accuracy  ' + RESET + (r.accuracy >= 0.999 ? C.good : C.ink) + liveAcc + RESET,
      C.mute + 'latency   ' + RESET + ms,
      C.mute + 'manifest K' + RESET + '  ' + C.accent + (manifestK || '—') + RESET + '   ' + C.mute + '(recorded at compile)' + RESET,
    ];
    wln('');
    wln(box(' eval · ' + art.fileName, lines));
    if (r.errors && r.errors.length) {
      wln('  ' + C.mute + 'first failures:' + RESET);
      for (const e of r.errors.slice(0, 3)) {
        wln('    ' + C.bad + '✗ ' + RESET + C.mute + (e.id || '?') + RESET + '  '
          + (e.error ? C.bad + e.error : 'got=' + JSON.stringify(e.got).slice(0, 40)) + RESET);
      }
    }
    wln('');
  } catch (e) {
    wln('  ' + C.bad + 'eval failed: ' + ((e && e.message) || 'unknown') + RESET);
  }
}

// ---------- :curate pane (real default-on MinHash + semantic dedup) ------
//
// Runs the W921 default-on curate pipeline (curateDefault: quality classifier +
// MinHash near-dup + semantic cluster + CoT/PII flags) over the artifact's own
// captured training pairs. This is the exact pure-JS path the CLI curate verb /
// distill corpus prep use - heavy python stages stay opt-in, light stages
// degrade gracefully. Reports n_in -> n_kept and the dedup/quality report so an
// operator can run a curate pass before a compile/distill.
async function curatePane(art, rest) {
  if (!art) { wln('  ' + C.bad + 'load a .kolm first.' + RESET); return; }
  try {
    const tune = await getTune();
    const { curateDefault } = await getCurate();
    const d = tune.tuneDir(art.filePath);
    const capPath = path.join(d, 'captures.jsonl');
    let pairs = [];
    if (fs.existsSync(capPath)) {
      const raw = fs.readFileSync(capPath, 'utf8').split('\n').filter(Boolean);
      for (const line of raw) { try { pairs.push(JSON.parse(line)); } catch (e) { /* skip */ } }
    }
    if (!pairs.length) {
      wln('  ' + C.mute + 'no captured pairs to curate. :tune capture-on then :run to collect.' + RESET);
      return;
    }
    const ns = (rest && rest.filter(Boolean)[0]) || 'default';
    wln('  ' + C.accent + '◴ curating ' + pairs.length + ' pairs (MinHash + semantic dedup, default-on)…' + RESET);
    const r = await curateDefault(pairs, { namespace: ns });
    const kept = r.n_kept != null ? r.n_kept : (r.pairs ? r.pairs.length : pairs.length);
    const dropped = (r.n_in != null ? r.n_in : pairs.length) - kept;
    const lines = [
      C.mute + 'version   ' + RESET + (r.version || 'curate'),
      C.mute + 'in        ' + RESET + (r.n_in != null ? r.n_in : pairs.length),
      C.mute + 'kept      ' + RESET + C.good + kept + RESET + '   ' + C.mute + 'dropped=' + dropped + RESET,
      C.mute + 'mode      ' + RESET + (r.degraded ? C.bad + 'degraded (' + (r.reason || 'partial') + ')' : C.good + 'full') + RESET,
    ];
    wln('');
    wln(box(' curate · ' + ns, lines));
    if (r.report) wln('  ' + C.mute + JSON.stringify(r.report).slice(0, 200) + RESET);
    wln('');
  } catch (e) {
    wln('  ' + C.bad + 'curate failed: ' + ((e && e.message) || 'unknown') + RESET);
  }
}

// ---------- :distill pane (auto-distill from captures) ------------------
//
// Bridges to the SAME local-worker self-serve distill flow the CLI/web console
// use: it curates the artifact's captured pairs (the default-on path above),
// then runs a tune step (the real SFT trainer) and grades the resulting revision
// - rendering loss/k_score progress live as each stage completes. This is the
// un-gated specialist path: it never returns a 503; when the python trainer or
// its deps are missing it fails LOUD with the trainer's own actionable message.
async function distillPane(art, rest) {
  if (!art) { wln('  ' + C.bad + 'load a .kolm first.' + RESET); return; }
  const tune = await getTune();
  const ap = art.filePath;
  try {
    const s = tune.summary(ap);
    if (!s.initialized) {
      wln('  ' + C.bad + 'tune not initialized.' + RESET + '   ' + C.good + ':tune init --base <model>' + RESET + C.mute + ' first.' + RESET);
      return;
    }
    const caps = tune.captureCount(ap);
    if (!caps) {
      wln('  ' + C.bad + 'no captures.' + RESET + '   ' + C.mute + ':tune capture-on then :run to collect training pairs.' + RESET);
      return;
    }
    wln('');
    wln('  ' + C.good + '● distill' + RESET + '   ' + C.mute + art.fileName + '  (' + caps + ' captured pairs)' + RESET);
    // Stage 1: curate (live).
    wln('  ' + C.accent + '◴ [1/3] curating training corpus…' + RESET);
    await curatePane(art, rest);
    // Stage 2: SFT step (the real trainer; loss surfaced from stats).
    wln('  ' + C.accent + '◴ [2/3] SFT step…' + RESET);
    const step = tune.runTuneStep({ artifactPath: ap, epochs: 1, airgap: (rest || []).includes('--airgap') });
    const loss = step.stats && (step.stats.loss != null ? step.stats.loss : step.stats.train_loss);
    wln('  ' + C.good + '  → ' + step.revision + RESET + (loss != null ? '   ' + C.mute + 'loss=' + RESET + loss : ''));
    // Stage 3: grade the new revision (K-score gate).
    wln('  ' + C.accent + '◴ [3/3] grading ' + step.revision + ' (K-score gate)…' + RESET);
    const ev = await tune.evalRevision({ artifactPath: ap, revision: step.revision });
    wln('  ' + C.good + '  → K=' + RESET + C.accent + fmtKScore(ev.k_score) + RESET + '   '
      + C.mute + 'acc=' + RESET + (ev.accuracy * 100).toFixed(1) + '%   '
      + C.mute + ev.pass + '/' + ev.total + RESET);
    wln('  ' + C.mute + 'promote with ' + RESET + C.good + ':tune promote --revision ' + step.revision + RESET);
    wln('');
  } catch (e) {
    wln('  ' + C.bad + 'distill failed: ' + ((e && e.message) || 'unknown') + RESET);
    wln('  ' + C.mute + '(the SFT trainer is the real path; install its deps or run on a GPU host to proceed.)' + RESET);
  }
}

// ---------- :serve mode (one-click REST) --------------------------------
//
// Security model (atom #8): the loopback bind is necessary but NOT sufficient -
// any webpage open in the user's browser can POST to http://127.0.0.1:<port>.
// So every :serve session mints a random bearer token (printed once in the curl
// example) and requires it on POST /v1/run. We also drop the wildcard CORS
// header: a loopback dev tool has no business echoing Access-Control-Allow-
// Origin:'*', which is exactly what lets a hostile origin read the response.
// Pass `unsafeOpen:true` only via an explicit operator opt-in (:serve --open).
import crypto from 'node:crypto';

// Constant-time string compare so a remote timing oracle cannot recover the
// session token byte-by-byte. Falls back to false on length mismatch.
function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

function mintSessionToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function startServe(art, port, opts) {
  opts = opts || {};
  const token = opts.token || null;       // required bearer unless unsafeOpen
  const unsafeOpen = !!opts.unsafeOpen;
  const allowOrigin = opts.allowOrigin || null; // explicit allowlist, else none
  function authorized(req) {
    if (unsafeOpen) return true;
    const h = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return !!(m && token && timingSafeEq(m[1].trim(), token));
  }
  return new Promise(function (resolve, reject) {
    const server = http.createServer(function (req, res) {
      const setJson = function (code, obj) {
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json');
        // No wildcard CORS for a loopback tool. Echo back ONLY an explicitly
        // allowlisted origin (none by default) so a hostile page cannot read.
        const reqOrigin = req.headers['origin'];
        if (allowOrigin && reqOrigin === allowOrigin) {
          res.setHeader('Access-Control-Allow-Origin', allowOrigin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        }
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'OPTIONS') { setJson(204, {}); return; }
      if (req.url === '/' && req.method === 'GET') {
        setJson(200, {
          ok: true,
          artifact: art.fileName,
          manifest_cid: (art.manifest || {}).cid || null,
          endpoints: { run: 'POST /v1/run { input | messages }' },
        });
        return;
      }
      if (req.url === '/v1/run' && req.method === 'POST') {
        if (!authorized(req)) {
          setJson(401, {
            error: 'missing or invalid bearer token',
            hint: 'pass the session token printed by :serve as: -H "Authorization: Bearer <token>"',
            error_code: 'KOLM_E_UNAUTHORIZED',
          });
          return;
        }
        const chunks = [];
        req.on('data', function (c) { chunks.push(c); });
        req.on('end', function () {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
          catch (e) { setJson(400, { error: 'invalid json' }); return; }
          const prompt = body.input
            || (Array.isArray(body.messages) && body.messages[body.messages.length - 1] && body.messages[body.messages.length - 1].content)
            || '';
          if (!prompt) { setJson(400, { error: 'input or messages required' }); return; }
          // Real artifact execution — byte-identical to `:run` and the CLI.
          realInfer(art, prompt).then(function (r) {
            if (!r.ok) {
              setJson(500, {
                error: r.text,
                error_code: r.error_code || 'KOLM_E_RUN_FAILED',
                _kolm: { artifact: art.fileName, cid: (art.manifest || {}).cid || null },
              });
              return;
            }
            setJson(200, {
              output: r.text,
              model: (art.manifest || {}).base_model || (art.manifest || {}).runtime_target || 'kolm',
              _kolm: {
                artifact: art.fileName,
                cid: (art.manifest || {}).cid || null,
                source: r.source,
                latency_us: r.latency_us,
              },
            });
          }).catch(function (e) {
            setJson(500, { error: String((e && e.message) || e), error_code: 'KOLM_E_RUN_FAILED' });
          });
        });
        return;
      }
      setJson(404, { error: 'not found' });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', function () {
      resolve(server);
    });
  });
}

// ---------- input parsing -----------------------------------------------
//
// Drag-drop pastes the file path into the prompt. On macOS/Linux the path
// is bare (with spaces escaped via backslash); on Windows it's typically
// wrapped in double quotes. Strip both, expand ~, and check existence.
function looksLikeKolmPath(s) {
  if (!s) return null;
  let v = s.trim();
  // Some terminals wrap drag-drop paths in single quotes on Linux.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  // Unix-style escaped spaces.
  v = v.replace(/\\ /g, ' ');
  if (v.startsWith('~')) v = path.join(os.homedir(), v.slice(1));
  if (!/\.kolm$/i.test(v)) return null;
  try { if (fs.statSync(v).isFile()) return v; } catch (e) { return null; }
  return null;
}

// ---------- help screen --------------------------------------------------
function helpScreen() {
  wln('');
  wln('  ' + BOLD + C.ink + 'kolm tui · commands' + RESET);
  wln('');
  wln('  ' + C.good + ':run <text>' + RESET + '         ' + C.mute + 'run the loaded artifact on text (or just type at the prompt)' + RESET);
  wln('  ' + C.good + ':serve [port]' + RESET + '       ' + C.mute + 'expose POST /v1/run on localhost (default port 7777)' + RESET);
  wln('  ' + C.good + ':stop' + RESET + '               ' + C.mute + 'stop the local serve' + RESET);
  wln('  ' + C.good + ':recipe' + RESET + '             ' + C.mute + 'show the recipe block' + RESET);
  wln('  ' + C.good + ':receipt' + RESET + '            ' + C.mute + 'show the 4-ring receipt' + RESET);
  wln('  ' + C.good + ':eval [run|json]' + RESET + '    ' + C.mute + 'grade on the embedded held-out set (live) + K-score delta' + RESET);
  wln('');
  wln('  ' + BOLD + C.ink + 'workbench' + RESET + '  ' + C.mute + '(drives the real src/ training backends, no reimplementation)' + RESET);
  wln('  ' + C.good + ':tune <sub>' + RESET + '         ' + C.mute + 'init | capture-on | capture-off | step | eval | promote | status' + RESET);
  wln('  ' + C.good + ':distill [--airgap]' + RESET + ' ' + C.mute + 'curate -> SFT step -> grade (un-gated specialist path; loss/K live)' + RESET);
  wln('  ' + C.good + ':curate [ns]' + RESET + '        ' + C.mute + 'run default-on MinHash + semantic dedup over captured pairs' + RESET);
  wln('');
  wln('  ' + C.good + ':drop' + RESET + '               ' + C.mute + 'unload the current artifact' + RESET);
  wln('  ' + C.good + ':clear' + RESET + '              ' + C.mute + 'clear the screen' + RESET);
  wln('  ' + C.good + ':help' + RESET + '               ' + C.mute + 'this screen' + RESET);
  wln('  ' + C.good + ':exit' + RESET + '   ' + C.mute + '(or Ctrl-D)' + RESET);
  wln('');
  wln('  ' + C.mute + 'tip: drag a .kolm file onto this window and the TUI auto-loads it.' + RESET);
  wln('');
}

function statusLine(state) {
  const parts = [];
  if (state.artifact) parts.push(C.good + '● ' + state.artifact.fileName + RESET);
  else parts.push(C.mute + '○ no artifact' + RESET);
  if (state.server) parts.push(C.accent + 'serving :' + state.server.address().port + RESET);
  return '  ' + parts.join('   ' + C.mute + '·' + RESET + '   ');
}

// ---------- main loop ----------------------------------------------------
export async function runTui(opts) {
  opts = opts || {};
  const startPath = opts.startPath || null;

  process.stdout.write(ALT_BUFFER_IN);
  process.on('exit', function () { process.stdout.write(ALT_BUFFER_OUT + SHOW_CURSOR); });
  process.on('SIGINT', function () { process.stdout.write(ALT_BUFFER_OUT + SHOW_CURSOR); process.exit(0); });

  await splash();

  const state = { artifact: null, server: null };

  // Auto-load if a path was passed on the command line.
  if (startPath) {
    try {
      await ingestAnimation(startPath);
      state.artifact = await parseKolm(startPath);
      renderCard(state.artifact);
    } catch (e) {
      wln('  ' + C.bad + 'failed to load ' + startPath + ': ' + e.message + RESET + '\n');
    }
  } else {
    wln('  ' + C.mute + 'drag a ' + RESET + C.good + '.kolm' + RESET + C.mute + ' file onto this window — or type ' + RESET + C.good + ':help' + RESET);
    wln('');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '  ' + C.good + '› ' + RESET,
  });

  function prompt() {
    // Re-render the status line above the prompt every cycle.
    wln(hr());
    wln(statusLine(state));
    wln(hr());
    rl.setPrompt('  ' + C.good + '› ' + RESET);
    rl.prompt();
  }

  prompt();

  rl.on('line', async function (line) {
    const raw = line == null ? '' : line.trim();
    if (!raw) { rl.prompt(); return; }

    // Drag-drop path detection takes priority over verb parsing.
    const dropped = looksLikeKolmPath(raw);
    if (dropped) {
      try {
        await ingestAnimation(dropped);
        state.artifact = await parseKolm(dropped);
        renderCard(state.artifact);
      } catch (e) {
        wln('  ' + C.bad + 'failed to load: ' + e.message + RESET);
      }
      prompt();
      return;
    }

    if (raw.startsWith(':')) {
      const [cmd, ...rest] = raw.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();

      if (cmd === 'help' || cmd === 'h' || cmd === '?') {
        helpScreen();
      } else if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') {
        if (state.server) { try { state.server.close(); } catch (e) {} } // deliberate: cleanup
        rl.close();
        return;
      } else if (cmd === 'clear' || cmd === 'cls') {
        clear();
      } else if (cmd === 'drop' || cmd === 'unload') {
        if (state.server) { try { state.server.close(); } catch (e) {} state.server = null; } // deliberate: cleanup
        state.artifact = null;
        wln('  ' + C.mute + 'artifact unloaded.' + RESET);
      } else if (cmd === 'recipe') {
        if (!state.artifact) wln('  ' + C.bad + 'no artifact loaded.' + RESET);
        else wln(C.mute + JSON.stringify(state.artifact.recipes || { note: 'no recipes.json' }, null, 2) + RESET);
      } else if (cmd === 'receipt') {
        if (!state.artifact) wln('  ' + C.bad + 'no artifact loaded.' + RESET);
        else wln(C.mute + JSON.stringify(state.artifact.receipt || { note: 'no receipt.json' }, null, 2) + RESET);
      } else if (cmd === 'eval' || cmd === 'evals') {
        if (!state.artifact) { wln('  ' + C.bad + 'no artifact loaded.' + RESET); }
        else if (arg === 'run' || arg === 'grade' || arg === 'live') {
          // Live held-out grading (real runtime) + K-score delta.
          await evalPane(state.artifact);
        } else if (arg === 'json' || arg === 'raw') {
          wln(C.mute + JSON.stringify(state.artifact.evals || { note: 'no evals.json' }, null, 2) + RESET);
        } else {
          // Default: live grade, then a hint at the raw dump.
          await evalPane(state.artifact);
          wln('  ' + C.mute + ':eval json' + RESET + C.mute + ' for the raw evals.json block.' + RESET);
        }
      } else if (cmd === 'serve') {
        if (!state.artifact) { wln('  ' + C.bad + 'load a .kolm first.' + RESET); prompt(); return; }
        if (state.server) { wln('  ' + C.mute + 'already serving on :' + state.server.address().port + RESET); prompt(); return; }
        const argv = rest.filter(Boolean);
        const unsafeOpen = argv.includes('--open') || argv.includes('--unsafe-open');
        const port = parseInt(argv.find((a) => /^\d+$/.test(a)), 10) || 7777;
        const token = unsafeOpen ? null : mintSessionToken();
        try {
          state.server = await startServe(state.artifact, port, { token: token, unsafeOpen: unsafeOpen });
          const url = 'http://127.0.0.1:' + port + '/v1/run';
          const inputEx = ((state.artifact.manifest && state.artifact.manifest.task) || 'hello').slice(0, 40).replace(/"/g, '\\"');
          wln('');
          wln('  ' + C.good + '● serving' + RESET + '   ' + C.ink + url + RESET);
          if (token) {
            wln('  ' + C.mute + 'session token ' + RESET + C.accent + token + RESET + '   ' + C.mute + '(required as Bearer; not persisted)' + RESET);
          } else {
            wln('  ' + C.bad + 'OPEN MODE: no auth, no CORS guard — anyone on this host can call it.' + RESET);
          }
          wln('');
          wln('  ' + C.mute + 'curl example:' + RESET);
          wln('  ' + C.accent + 'curl -X POST ' + url + " -H 'Content-Type: application/json' \\" + RESET);
          if (token) wln('  ' + C.accent + "     -H 'Authorization: Bearer " + token + "' \\" + RESET);
          wln('  ' + C.accent + "     -d '{\"input\":\"" + inputEx + "\"}'" + RESET);
          wln('');
          wln('  ' + C.mute + ':stop to stop.' + RESET);
        } catch (e) {
          wln('  ' + C.bad + 'serve failed: ' + e.message + RESET);
        }
      } else if (cmd === 'stop') {
        if (state.server) { try { state.server.close(); } catch (e) {} state.server = null; wln('  ' + C.mute + 'stopped.' + RESET); } // deliberate: cleanup
        else wln('  ' + C.mute + 'not serving.' + RESET);
      } else if (cmd === 'run') {
        if (!state.artifact) { wln('  ' + C.bad + 'load a .kolm first.' + RESET); prompt(); return; }
        if (!arg) { wln('  ' + C.bad + 'usage: :run <prompt>' + RESET); prompt(); return; }
        await runPrompt(state.artifact, arg);
      } else if (cmd === 'tune') {
        await tunePane(state.artifact, rest[0], rest.slice(1));
      } else if (cmd === 'distill') {
        await distillPane(state.artifact, rest);
      } else if (cmd === 'curate') {
        await curatePane(state.artifact, rest);
      } else {
        wln('  ' + C.bad + 'unknown command: :' + cmd + RESET + '   ' + C.mute + 'type :help' + RESET);
      }
      prompt();
      return;
    }

    // Bare input → run on current artifact (the codex/claude-style chat flow).
    if (!state.artifact) {
      wln('  ' + C.mute + 'drag a .kolm to load, or type :help' + RESET);
    } else {
      await runPrompt(state.artifact, raw);
    }
    prompt();
  });

  rl.on('close', function () {
    if (state.server) { try { state.server.close(); } catch (e) {} } // deliberate: cleanup
    process.stdout.write(ALT_BUFFER_OUT + SHOW_CURSOR);
    wln('');
    wln('  ' + C.mute + 'bye.' + RESET);
    process.exit(0);
  });
}

// ---------- test surface -------------------------------------------------
// Pure, side-effect-free internals exported for the SOTA lane test. These are
// the exact functions the TUI uses (zip64 reader, token mint/compare, the
// streamed/buffered .kolm parser, the workbench bridges, the authed serve), so
// the test exercises real behavior - not a copy.
export const __test__ = {
  readZipEntries,
  readZipEntry,
  parseKolm,
  parseKolmStreamed,
  timingSafeEq,
  mintSessionToken,
  startServe,
  tunePane,
  evalPane,
  curatePane,
  distillPane,
};

function workbenchUsage() {
  return [
    'kolm workbench TUI',
    '',
    'USAGE',
    '  kolm play [file.kolm]',
    '  kolm tui --workbench [file.kolm]',
    '  node cli/kolm-tui.mjs [file.kolm]',
    '',
    'COMMANDS',
    '  :run <text>      run the loaded artifact on text',
    '  :serve [port]    expose POST /v1/run on localhost',
    '  :tune <sub>      init | capture-on | capture-off | step | eval | promote | status',
    '  :distill         curate -> SFT step -> grade',
    '  :curate [ns]     deduplicate captured pairs',
    '  :eval [json]     grade embedded eval cases or show eval JSON',
    '  :exit            quit',
    '',
    'NOTES',
    '  Requires an interactive terminal. For scripts, use `kolm inspect <file>` or `kolm run <file>`.',
  ].join('\n') + '\n';
}

function isDirectEntrypoint() {
  return import.meta.url === 'file://' + process.argv[1]
    || (process.argv[1] && process.argv[1].endsWith('kolm-tui.mjs'));
}

// Entry point if invoked directly (node cli/kolm-tui.mjs <path?>)
if (isDirectEntrypoint()) {
  const directArgs = process.argv.slice(2);
  if (directArgs.includes('--help') || directArgs.includes('-h')) {
    process.stdout.write(workbenchUsage());
    process.exit(0);
  }
  const unknownFlag = directArgs.find((a) => a.startsWith('-'));
  if (unknownFlag) {
    process.stderr.write('error: unknown flag for workbench TUI: ' + unknownFlag + '\n');
    process.stderr.write(workbenchUsage());
    process.exit(1);
  }
  const startPath = directArgs[0] || null;
  if (startPath && !fs.existsSync(startPath)) {
    process.stderr.write('error: not found: ' + startPath + '\n');
    process.exit(5);
  }
  if (!process.stdout.isTTY) {
    process.stderr.write('kolm workbench requires a TTY (interactive terminal).\n');
    process.stderr.write('  non-interactive alternatives: kolm inspect <file> / kolm run <file>\n');
    process.exit(3);
  }
  runTui({ startPath: startPath }).catch(function (err) {
    process.stdout.write(ALT_BUFFER_OUT + SHOW_CURSOR);
    console.error(err);
    process.exit(1);
  });
}
