// T2.6 - distill-watch: a local-first live training dashboard.
//
// Reads a distill run's progress.jsonl and serves a dependency-free HTML page
// on localhost with a loss sparkline + ETA + cost-burnt + CoT-flag count, auto
// refreshing. Everything here is Node built-ins only (node:http, node:fs,
// node:path, node:os) - ZERO npm deps, so it runs the same on a fresh box.
//
// Runs live at ~/.kolm/distill-runs/<run_id>/ (matching src/distill-pipeline.js
// _kolmDir() resolution). The progress file is
// ~/.kolm/distill-runs/<run_id>/progress.jsonl - each line a JSON object that
// MAY carry any of: { step, total_steps, loss, eval_loss, epoch, lr, ts,
// cost_usd, cot_flags, tokens, elapsed_s }. Every field is treated as optional:
// a missing/garbled line never crashes the reader, and an absent file renders a
// "waiting for first progress line" state.
//
// Surface contract (envelope): the public functions return
// { ok:true, version, ... } on success and { ok:false, error } on failure. We
// do not throw across the public API.
//
// Cost-burnt: if cost_usd looks cumulative (non-decreasing across lines) we take
// the latest; if it looks per-step (resets/jitters) we sum. ETA: derived from
// step / total_steps + elapsed (elapsed_s if present, else last_ts - first_ts).
// CoT-flag count: from cot_flags (latest cumulative, else sum of per-line).
//
// wandb stays optional and is out of scope here: this dashboard is the local,
// no-account path; pointing a run at Weights & Biases is a separate opt-in knob.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DISTILL_WATCH_VERSION = 'tw-v1';
export const DISTILL_WATCH_LIMITS = Object.freeze({
  max_progress_bytes: 4 * 1024 * 1024,
  max_lines: 5000,
  max_run_id_chars: 160,
  max_error_detail_chars: 240,
  loopback_hosts: Object.freeze(['127.0.0.1', 'localhost', '::1']),
});

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function _safeText(v, max = DISTILL_WATCH_LIMITS.max_run_id_chars) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function _safeError(e) {
  return _safeText((e && e.message) ? e.message : e, DISTILL_WATCH_LIMITS.max_error_detail_chars);
}

function _hash(v) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v)).digest('hex');
}

function _safeRunId(runId) {
  if (runId == null || runId === '') return '';
  const s = _safeText(runId, DISTILL_WATCH_LIMITS.max_run_id_chars);
  if (!s || s === '.' || s === '..' || UNSAFE_OBJECT_KEYS.has(s)) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(s)) return null;
  return s;
}

function _isUnder(baseDir, target) {
  const base = path.resolve(baseDir);
  const dest = path.resolve(target);
  const rel = path.relative(base, dest);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function _pathLabel(absPath) {
  return _safeText(path.basename(String(absPath || '')), DISTILL_WATCH_LIMITS.max_run_id_chars) || 'run';
}

function _isLoopbackHost(host) {
  const h = _safeText(host || '127.0.0.1', 64).toLowerCase();
  return DISTILL_WATCH_LIMITS.loopback_hosts.includes(h);
}

// --- path resolution (mirrors src/distill-pipeline.js so we read the same dir)
function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _kolmDir() {
  return process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
}
// Resolve a run directory. opts.runDir / opts.baseDir let callers (and the
// smoke) point at a temp dir without touching the real ~/.kolm tree.
function _resolveRunDir(runId, opts = {}) {
  const base = opts.baseDir ? path.resolve(opts.baseDir) : path.join(_kolmDir(), 'distill-runs');
  if (opts.runDir) {
    const runDir = path.resolve(String(opts.runDir));
    if (opts.baseDir && !_isUnder(base, runDir)) {
      return { ok: false, error: 'run_dir_outside_base' };
    }
    return { ok: true, runDir, runId: _safeRunId(runId) || _pathLabel(runDir) };
  }
  const safeRunId = _safeRunId(runId);
  if (safeRunId == null) return { ok: false, error: 'invalid_run_id' };
  const runDir = path.resolve(base, safeRunId);
  if (!_isUnder(base, runDir)) return { ok: false, error: 'run_dir_outside_base' };
  return { ok: true, runDir, runId: safeRunId || null };
}

function _num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function _readBoundedUtf8(filePath) {
  let stat = null;
  try { stat = fs.statSync(filePath); } catch (e) { return { raw: '', truncated: false, error: _safeError(e) }; }
  if (!stat || !stat.isFile()) return { raw: '', truncated: false, error: 'not_file' };
  const max = DISTILL_WATCH_LIMITS.max_progress_bytes;
  if (stat.size <= max) {
    try { return { raw: fs.readFileSync(filePath, 'utf8'), truncated: false }; }
    catch (e) { return { raw: '', truncated: false, error: _safeError(e) }; }
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(max);
    fs.readSync(fd, buf, 0, max, stat.size - max);
    return { raw: buf.toString('utf8'), truncated: true, bytes: stat.size };
  } catch (e) {
    return { raw: '', truncated: true, bytes: stat.size, error: _safeError(e) };
  } finally {
    try { fs.closeSync(fd); } catch { /* deliberate: cleanup */ }
  }
}

// --- progress parsing -------------------------------------------------------
//
// Pure: no server, no mutation of inputs. Returns the envelope shape documented
// in the task. On any read/parse trouble we still return ok:true with whatever
// we could recover (exists:false or a partial points array) - a dashboard
// should degrade, not error.
export function readProgress(runId, opts = {}) {
  try {
    const resolved = _resolveRunDir(runId, opts);
    if (!resolved.ok) {
      return {
        ok: false,
        error: resolved.error,
        version: DISTILL_WATCH_VERSION,
      };
    }
    const runDir = resolved.runDir;
    const progPath = path.join(runDir, 'progress.jsonl');
    const exists = fs.existsSync(progPath);

    const base = {
      ok: true,
      version: DISTILL_WATCH_VERSION,
      run_id: resolved.runId,
      run_dir: _pathLabel(runDir),
      run_dir_sha256: _hash(runDir),
      exists,
      progress_truncated: false,
      points: [],
      latest: null,
      summary: {
        steps: 0,
        total_steps: null,
        last_loss: null,
        eval_loss: null,
        pct: null,
        eta_seconds: null,
        cost_usd: null,
        cot_flags: null,
        tok_per_s: null,
      },
    };

    if (!exists) return base;

    const read = _readBoundedUtf8(progPath);
    let lines = String(read.raw || '').split('\n');
    if (read.truncated && lines.length) lines = lines.slice(1);
    if (lines.length > DISTILL_WATCH_LIMITS.max_lines) lines = lines.slice(-DISTILL_WATCH_LIMITS.max_lines);
    base.progress_truncated = !!read.truncated;
    if (read.error) base.read_warning = read.error;

    const points = [];
    const costs = [];
    const cots = [];
    let firstTs = null;
    let lastTs = null;
    let lastElapsed = null;
    let totalTokens = 0;
    let sawTokens = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj = null;
      try { obj = JSON.parse(trimmed); } catch { continue; } // skip garbled line
      if (!obj || typeof obj !== 'object') continue;

      const pt = {
        step: _num(obj.step),
        loss: _num(obj.loss),
        eval_loss: _num(obj.eval_loss),
        epoch: _num(obj.epoch),
        lr: _num(obj.lr),
        ts: _num(obj.ts),
        cost_usd: _num(obj.cost_usd),
        cot_flags: _num(obj.cot_flags),
        tokens: _num(obj.tokens),
        elapsed_s: _num(obj.elapsed_s),
        total_steps: _num(obj.total_steps),
      };
      points.push(pt);
      if (points.length >= DISTILL_WATCH_LIMITS.max_lines) break;

      if (pt.cost_usd != null) costs.push(pt.cost_usd);
      if (pt.cot_flags != null) cots.push(pt.cot_flags);
      if (pt.ts != null) {
        if (firstTs == null) firstTs = pt.ts;
        lastTs = pt.ts;
      }
      if (pt.elapsed_s != null) lastElapsed = pt.elapsed_s;
      if (pt.tokens != null) { totalTokens += pt.tokens; sawTokens = true; }
    }

    const latest = points.length ? points[points.length - 1] : null;
    base.points = points;
    base.latest = latest;

    if (latest) {
      const steps = latest.step != null ? latest.step : points.length;
      // total_steps: prefer the latest line's value, else the max seen.
      let totalSteps = latest.total_steps;
      if (totalSteps == null) {
        for (const p of points) if (p.total_steps != null && (totalSteps == null || p.total_steps > totalSteps)) totalSteps = p.total_steps;
      }

      // elapsed: explicit elapsed_s wins; else derive from ts span.
      let elapsed = lastElapsed;
      if (elapsed == null && firstTs != null && lastTs != null && lastTs >= firstTs) {
        elapsed = lastTs - firstTs;
      }

      // pct + ETA from step/total + elapsed.
      let pct = null;
      let eta = null;
      if (totalSteps != null && totalSteps > 0 && steps != null) {
        pct = Math.max(0, Math.min(100, (steps / totalSteps) * 100));
        if (steps >= totalSteps) {
          eta = 0;
        } else if (elapsed != null && elapsed > 0 && steps > 0) {
          const perStep = elapsed / steps;
          eta = Math.max(0, Math.round(perStep * (totalSteps - steps)));
        }
      }

      // cost-burnt: cumulative (non-decreasing) -> latest; per-step -> sum.
      let cost = null;
      if (costs.length) {
        let nonDecreasing = true;
        for (let i = 1; i < costs.length; i++) if (costs[i] < costs[i - 1]) { nonDecreasing = false; break; }
        cost = (nonDecreasing && costs.length > 1) ? costs[costs.length - 1]
          : costs.length === 1 ? costs[0]
            : costs.reduce((a, b) => a + b, 0);
      }

      // CoT flags: cumulative (non-decreasing) -> latest; else sum.
      let cot = null;
      if (cots.length) {
        let nonDecreasing = true;
        for (let i = 1; i < cots.length; i++) if (cots[i] < cots[i - 1]) { nonDecreasing = false; break; }
        cot = (nonDecreasing && cots.length > 1) ? cots[cots.length - 1]
          : cots.length === 1 ? cots[0]
            : cots.reduce((a, b) => a + b, 0);
      }

      // tokens/sec: total tokens over elapsed, when both known.
      let tps = null;
      if (sawTokens && elapsed != null && elapsed > 0) tps = totalTokens / elapsed;

      base.summary = {
        steps: steps != null ? steps : points.length,
        total_steps: totalSteps,
        last_loss: latest.loss,
        eval_loss: latest.eval_loss,
        pct: pct == null ? null : Math.round(pct * 10) / 10,
        eta_seconds: eta,
        cost_usd: cost,
        cot_flags: cot,
        tok_per_s: tps == null ? null : Math.round(tps * 100) / 100,
      };
    }

    return base;
  } catch (e) {
    return { ok: false, error: 'distill_watch_failed', detail: _safeError(e), version: DISTILL_WATCH_VERSION };
  }
}

// --- tiny formatting helpers (deterministic, no locale surprises) -----------
function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _fmtNum(v, digits = 4) {
  if (v == null || !Number.isFinite(v)) return ' - ';
  return Number(v).toFixed(digits);
}
function _fmtCost(v) {
  if (v == null || !Number.isFinite(v)) return '$ - ';
  return '$' + Number(v).toFixed(4);
}
function _fmtEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return ' - ';
  if (sec <= 0) return 'done';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

// --- sparkline --------------------------------------------------------------
//
// Given an array of { step, loss }, emit an <svg><polyline/></svg> scaling loss
// to the viewbox (y inverted so lower loss sits lower). Handles 0 and 1 points
// without dividing by zero: 0 pts -> an empty framed svg; 1 pt -> a flat midline
// dot+line so the panel still reads as "one sample".
function renderSparkline(points, opts = {}) {
  const W = opts.width || 640;
  const H = opts.height || 160;
  const pad = 6;
  const innerW = W - pad * 2;
  const innerH = H - pad * 2;

  const usable = (points || [])
    .map((p, i) => ({ x: _num(p && p.step) != null ? p.step : i, y: _num(p && p.loss) }))
    .filter((p) => p.y != null);

  const frame = (inner) =>
    `<svg class="spark" width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="loss sparkline">`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="#eef1f4" stroke="#dde1e7"/>`
    + inner
    + `</svg>`;

  if (usable.length === 0) {
    return frame(`<text x="${W / 2}" y="${H / 2}" fill="#56606c" font-size="13" text-anchor="middle" dominant-baseline="middle">no loss samples yet</text>`);
  }

  const xs = usable.map((p) => p.x);
  const ys = usable.map((p) => p.y);
  let minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);

  if (usable.length === 1 || minX === maxX) {
    const cy = pad + innerH / 2;
    return frame(
      `<line x1="${pad}" y1="${cy}" x2="${W - pad}" y2="${cy}" stroke="#a8b3c2" stroke-width="2"/>`
      + `<circle cx="${(pad + (W - pad)) / 2}" cy="${cy}" r="3.5" fill="#56606c"/>`,
    );
  }
  if (minY === maxY) { minY -= 0.5; maxY += 0.5; } // flat curve -> give it room

  const sx = (x) => pad + ((x - minX) / (maxX - minX)) * innerW;
  // invert y: lower loss -> larger y (toward bottom)
  const sy = (y) => pad + (1 - (y - minY) / (maxY - minY)) * innerH;

  const pts = usable.map((p) => `${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(' ');
  const lastX = sx(usable[usable.length - 1].x);
  const lastY = sy(usable[usable.length - 1].y);

  return frame(
    `<polyline points="${pts}" fill="none" stroke="#56606c" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="3.5" fill="#1f2937"/>`,
  );
}

// --- dashboard HTML ---------------------------------------------------------
//
// Full self-contained page. Deterministic for a given input: no Date.now(), no
// random. Auto-refresh is handled by a tiny inline poll of /data.json that
// repaints stats + sparkline in place; a <meta http-equiv="refresh"> is also
// emitted as a no-JS fallback. Cool-slate palette only.
export function renderDashboardHtml(progress) {
  const p = progress && typeof progress === 'object' ? progress : {};
  if (p.ok === false) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>kolm distill watch</title>`
      + `<style>body{margin:0;background:#f3f5f7;color:#1f2937;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:32px}</style>`
      + `</head><body><h1 style="font-size:18px">kolm distill watch</h1>`
      + `<p style="color:#525a64">could not read run: ${_esc(p.error || 'unknown error')}</p></body></html>`;
  }

  const s = p.summary || {};
  const runId = p.run_id || ' - ';
  const waiting = !p.exists || !(p.points && p.points.length);

  const spark = renderSparkline(p.points || []);
  const lastLoss = _fmtNum(s.last_loss);
  const evalLoss = _fmtNum(s.eval_loss);
  const pct = s.pct == null ? ' - ' : `${s.pct}%`;
  const eta = _fmtEta(s.eta_seconds);
  const cost = _fmtCost(s.cost_usd);
  const cot = s.cot_flags == null ? '0' : String(s.cot_flags);
  const steps = s.steps == null ? ' - ' : String(s.steps);
  const total = s.total_steps == null ? ' - ' : String(s.total_steps);
  const tps = s.tok_per_s == null ? ' - ' : String(s.tok_per_s);

  const waitingBanner = waiting
    ? `<div class="wait">waiting for first progress line - run hasn't written to <code>progress.jsonl</code> yet.</div>`
    : '';

  // Embed the data so the no-JS render already shows real numbers, and the JS
  // poller has a baseline. JSON is safe to inline once </ is neutralised.
  const dataJson = JSON.stringify(p).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>kolm distill watch - ${_esc(runId)}</title>
<style>
  :root{ --text:#1f2937; --mute:#56606c; --mute2:#525a64; --line:#a8b3c2; --line2:#dde1e7; --s1:#f3f5f7; --s2:#eef1f4; --s3:#e6eaef; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--s1);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .wrap{max-width:860px;margin:0 auto;padding:32px 24px 48px}
  h1{font-size:18px;margin:0 0 2px;letter-spacing:.2px}
  .sub{color:var(--mute2);font-size:12px;margin:0 0 20px}
  .sub code{background:var(--s3);padding:1px 5px;border-radius:3px}
  .wait{background:var(--s2);border:1px solid var(--line2);border-radius:6px;padding:12px 14px;color:var(--mute2);font-size:13px;margin:0 0 20px}
  .wait code{background:var(--s3);padding:1px 5px;border-radius:3px}
  .panel{background:var(--s2);border:1px solid var(--line2);border-radius:8px;padding:16px;margin:0 0 20px}
  .panel h2{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--mute);margin:0 0 10px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .stat{background:var(--s1);border:1px solid var(--line2);border-radius:6px;padding:12px 14px}
  .stat .k{font-size:11px;color:var(--mute);text-transform:uppercase;letter-spacing:.6px}
  .stat .v{font-size:20px;margin-top:4px;font-variant-numeric:tabular-nums}
  .stat .v small{font-size:12px;color:var(--mute2)}
  footer{color:var(--mute2);font-size:11px;margin-top:8px}
  footer code{background:var(--s3);padding:1px 5px;border-radius:3px}
</style>
</head>
<body>
<div class="wrap">
  <h1>kolm distill watch</h1>
  <p class="sub">run <code id="run-id">${_esc(runId)}</code> · refreshes every 5s · <code>${DISTILL_WATCH_VERSION}</code></p>
  <div id="wait-slot">${waitingBanner}</div>

  <div class="panel">
    <h2>loss</h2>
    <div id="spark-slot">${spark}</div>
  </div>

  <div class="panel">
    <h2>progress</h2>
    <div class="grid">
      <div class="stat"><div class="k">step</div><div class="v"><span id="m-steps">${steps}</span> <small>/ <span id="m-total">${total}</span></small></div></div>
      <div class="stat"><div class="k">complete</div><div class="v" id="m-pct">${pct}</div></div>
      <div class="stat"><div class="k">eta</div><div class="v" id="m-eta">${_esc(eta)}</div></div>
      <div class="stat"><div class="k">loss</div><div class="v" id="m-loss">${lastLoss}</div></div>
      <div class="stat"><div class="k">eval loss</div><div class="v" id="m-eval">${evalLoss}</div></div>
      <div class="stat"><div class="k">tok / s</div><div class="v" id="m-tps">${tps}</div></div>
      <div class="stat"><div class="k">cost burnt</div><div class="v" id="m-cost">${cost}</div></div>
      <div class="stat"><div class="k">cot flags</div><div class="v" id="m-cot">${cot}</div></div>
      <div class="stat"><div class="k">samples</div><div class="v" id="m-samples">${(p.points || []).length}</div></div>
    </div>
  </div>

  <footer>local-first dashboard · data from <code id="run-dir">${_esc(p.run_dir || '')}</code> · wandb integration is a separate opt-in (out of scope here)</footer>
</div>
<script>
  // Baseline render is already correct (server-side). This poller keeps the
  // numbers fresh between the 5s meta-refresh fallbacks. Defensive throughout:
  // any fetch/parse error is swallowed so the page never goes blank.
  var INITIAL = ${dataJson};
  function fmtNum(v,d){ if(v==null||!isFinite(v))return '\\u2014'; return Number(v).toFixed(d==null?4:d); }
  function fmtCost(v){ if(v==null||!isFinite(v))return '$\\u2014'; return '$'+Number(v).toFixed(4); }
  function fmtEta(sec){ if(sec==null||!isFinite(sec))return '\\u2014'; if(sec<=0)return 'done'; sec=Math.round(sec);
    var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),r=sec%60;
    if(h>0)return h+'h '+m+'m'; if(m>0)return m+'m '+r+'s'; return r+'s'; }
  function set(id,val){ var el=document.getElementById(id); if(el)el.textContent=val; }
  function paint(p){
    if(!p||p.ok===false)return;
    var s=p.summary||{};
    set('m-steps', s.steps==null?'\\u2014':String(s.steps));
    set('m-total', s.total_steps==null?'\\u2014':String(s.total_steps));
    set('m-pct', s.pct==null?'\\u2014':(s.pct+'%'));
    set('m-eta', fmtEta(s.eta_seconds));
    set('m-loss', fmtNum(s.last_loss));
    set('m-eval', fmtNum(s.eval_loss));
    set('m-tps', s.tok_per_s==null?'\\u2014':String(s.tok_per_s));
    set('m-cost', fmtCost(s.cost_usd));
    set('m-cot', s.cot_flags==null?'0':String(s.cot_flags));
    set('m-samples', String((p.points||[]).length));
    var wait=document.getElementById('wait-slot');
    if(wait) wait.innerHTML = (!p.exists || !(p.points&&p.points.length))
      ? '<div class="wait">waiting for first progress line \\u2014 run hasn\\u2019t written to <code>progress.jsonl</code> yet.</div>' : '';
  }
  paint(INITIAL);
  function tick(){
    try{
      fetch('/data.json',{cache:'no-store'}).then(function(r){return r.json();}).then(function(p){
        paint(p);
        // Repaint the sparkline by replacing the slot's SVG via a fresh fetch of '/'
        // would be heavy; instead we redraw from points client-side.
        try{ drawSpark(p.points||[]); }catch(e){}
      }).catch(function(){});
    }catch(e){}
  }
  function drawSpark(points){
    var W=640,H=160,pad=6,iW=W-pad*2,iH=H-pad*2;
    var u=[]; for(var i=0;i<points.length;i++){var pt=points[i];var y=(pt&&typeof pt.loss==='number'&&isFinite(pt.loss))?pt.loss:null; if(y!=null)u.push({x:(pt&&typeof pt.step==='number'&&isFinite(pt.step))?pt.step:i,y:y});}
    var slot=document.getElementById('spark-slot'); if(!slot)return;
    var head='<svg class="spark" width="100%" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="loss sparkline"><rect x="0" y="0" width="'+W+'" height="'+H+'" fill="#eef1f4" stroke="#dde1e7"/>';
    if(u.length===0){ slot.innerHTML=head+'<text x="'+(W/2)+'" y="'+(H/2)+'" fill="#56606c" font-size="13" text-anchor="middle" dominant-baseline="middle">no loss samples yet</text></svg>'; return; }
    var minX=u[0].x,maxX=u[0].x,minY=u[0].y,maxY=u[0].y;
    for(var j=0;j<u.length;j++){ if(u[j].x<minX)minX=u[j].x; if(u[j].x>maxX)maxX=u[j].x; if(u[j].y<minY)minY=u[j].y; if(u[j].y>maxY)maxY=u[j].y; }
    if(u.length===1||minX===maxX){ var cy=pad+iH/2; slot.innerHTML=head+'<line x1="'+pad+'" y1="'+cy+'" x2="'+(W-pad)+'" y2="'+cy+'" stroke="#a8b3c2" stroke-width="2"/><circle cx="'+((pad+(W-pad))/2)+'" cy="'+cy+'" r="3.5" fill="#56606c"/></svg>'; return; }
    if(minY===maxY){ minY-=0.5; maxY+=0.5; }
    function sx(x){return pad+((x-minX)/(maxX-minX))*iW;} function sy(y){return pad+(1-(y-minY)/(maxY-minY))*iH;}
    var pts=''; for(var k=0;k<u.length;k++){ pts+=(k?' ':'')+sx(u[k].x).toFixed(2)+','+sy(u[k].y).toFixed(2); }
    var lx=sx(u[u.length-1].x),ly=sy(u[u.length-1].y);
    slot.innerHTML=head+'<polyline points="'+pts+'" fill="none" stroke="#56606c" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="'+lx.toFixed(2)+'" cy="'+ly.toFixed(2)+'" r="3.5" fill="#1f2937"/></svg>';
  }
  setInterval(tick, 5000);
</script>
</body>
</html>`;
}

// --- server -----------------------------------------------------------------
//
// node:http server. GET / -> renderDashboardHtml(readProgress(runId)).
// GET /data.json -> readProgress(runId) as JSON (for the poller + scripting).
// Never binds without being called: listen() is invoked here, inside the
// exported factory, not at import time. Returns the envelope + a close() that
// resolves when the socket is fully released.
export function startWatchServer({ runId, port = 7787, host = '127.0.0.1', ...opts } = {}) {
  try {
    const safeHost = _safeText(host || '127.0.0.1', 64) || '127.0.0.1';
    if (!_isLoopbackHost(safeHost) && opts.allow_non_loopback !== true) {
      return { ok: false, error: 'non_loopback_host_rejected', version: DISTILL_WATCH_VERSION };
    }
    const safePort = Number(port);
    if (!Number.isInteger(safePort) || safePort < 0 || safePort > 65535) {
      return { ok: false, error: 'invalid_port', version: DISTILL_WATCH_VERSION };
    }
    const server = http.createServer((req, res) => {
      // Only GET is meaningful here; everything else is a 405.
      const url = (req.url || '/').split('?')[0];
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      if (url === '/data.json') {
        const data = readProgress(runId, opts);
        const body = JSON.stringify(data);
        res.writeHead(data.ok === false ? 500 : 200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(body);
        return;
      }
      if (url === '/' || url === '/index.html') {
        const data = readProgress(runId, opts);
        const html = renderDashboardHtml(data);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(html);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });

    const close = () => new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); } // deliberate: cleanup
    });

    // The envelope is returned synchronously (the server starts listening on
    // this call), but the OS-assigned port for an ephemeral bind (port:0) is
    // only known once the 'listening' event fires. We backfill handle.port /
    // handle.url in place at that point and resolve handle.ready, so callers
    // can either pass a concrete port and read it immediately, or `await
    // handle.ready` when they asked for an ephemeral one.
    const handle = {
      ok: true,
      version: DISTILL_WATCH_VERSION,
      url: `http://${safeHost}:${safePort}/`,
      port: safePort,
      host: safeHost,
      run_id: _safeRunId(runId) || null,
      server,
      close,
      ready: null,
    };

    handle.ready = new Promise((resolve) => {
      const settle = () => {
        try {
          const a = server.address();
          if (a && typeof a === 'object' && a.port) {
            handle.port = a.port;
            handle.url = `http://${safeHost}:${a.port}/`;
          }
        } catch { /* deliberate: cleanup */ }
        resolve(handle);
      };
      // If already listening (concrete port can bind fast), settle now.
      if (server.listening) settle();
      else server.once('listening', settle);
      // Don't leave callers hanging on a bind error.
      server.once('error', () => resolve(handle));
    });

    // Surface listen errors to any 'error' listener the caller attaches; the
    // synchronous setup above is what the try/catch guards.
    server.listen(safePort, safeHost);

    return handle;
  } catch (e) {
    return { ok: false, error: 'watch_server_failed', detail: _safeError(e), version: DISTILL_WATCH_VERSION };
  }
}

// Exported for tests/tooling; also usable by callers who want just the SVG.
export { renderSparkline };
