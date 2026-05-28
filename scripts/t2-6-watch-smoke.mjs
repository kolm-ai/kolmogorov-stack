#!/usr/bin/env node
// scripts/t2-6-watch-smoke.mjs
//
// T2.6 smoke test — src/distill-watch.js live training dashboard. Pure JS, no
// real training: we write a synthetic progress.jsonl into a temp run dir and
// assert the reader, the HTML renderer, the sparkline edge cases, and (best
// effort) a live server round-trip on an ephemeral port.
//
//   1. readProgress returns ok, exists, points.length===5
//   2. summary.pct===100 (step 40 / total 40) and eta_seconds===0 at completion
//   3. summary.last_loss matches the last synthetic loss
//   4. renderDashboardHtml(progress) is a string containing <svg, <polyline,
//      the last loss value, and a cost figure
//   5. rendered HTML contains NO warm hex (#c2410c / #faf9f7)
//   6. renderSparkline([]) does not crash and still returns an <svg
//   7. (optional) live server: GET / -> 200 + body has <polyline;
//      GET /data.json -> 200 + valid JSON with ok:true
//   8. missing run dir -> exists:false, no crash, "waiting" state in HTML

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
  DISTILL_WATCH_VERSION,
  readProgress,
  renderDashboardHtml,
  renderSparkline,
  startWatchServer,
} from '../src/distill-watch.js';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ok   ${label}`); }
function bad(label, detail) { fail++; console.log(`  FAIL ${label}: ${detail}`); }
function assert(cond, label, detail = '') { if (cond) ok(label); else bad(label, detail || 'condition false'); }

console.log(`T2.6 — distill-watch smoke (${DISTILL_WATCH_VERSION})`);

// --- set up a temp run dir with a synthetic progress.jsonl ------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-t2-6-'));
const runId = 'run_t26smoke';
const runDir = path.join(tmp, runId);
fs.mkdirSync(runDir, { recursive: true });

// 5 lines, decreasing loss, cumulative cost_usd, cot_flags=0 throughout, final
// line at step 40 / total 40 (i.e. complete). ts increments so elapsed derives.
const LAST_LOSS = 0.412;
const FINAL_COST = 0.0837;
const lines = [
  { step: 0,  total_steps: 40, loss: 1.842, eval_loss: 1.901, ts: 1000, cost_usd: 0.0000, cot_flags: 0, tokens: 2048, elapsed_s: 0 },
  { step: 10, total_steps: 40, loss: 1.107, eval_loss: 1.210, ts: 1030, cost_usd: 0.0215, cot_flags: 0, tokens: 2048, elapsed_s: 30 },
  { step: 20, total_steps: 40, loss: 0.781, eval_loss: 0.844, ts: 1060, cost_usd: 0.0430, cot_flags: 0, tokens: 2048, elapsed_s: 60 },
  { step: 30, total_steps: 40, loss: 0.553, eval_loss: 0.612, ts: 1090, cost_usd: 0.0640, cot_flags: 0, tokens: 2048, elapsed_s: 90 },
  { step: 40, total_steps: 40, loss: LAST_LOSS, eval_loss: 0.470, ts: 1120, cost_usd: FINAL_COST, cot_flags: 0, tokens: 2048, elapsed_s: 120 },
];
fs.writeFileSync(path.join(runDir, 'progress.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// --- 1-3. readProgress ------------------------------------------------------
const prog = readProgress(runId, { baseDir: tmp });
assert(prog.ok === true, '1: readProgress ok', JSON.stringify(prog).slice(0, 200));
assert(prog.exists === true, '1: exists true', String(prog.exists));
assert(prog.points.length === 5, '1: points.length===5', `got ${prog.points.length}`);
assert(prog.summary.pct === 100, '2: summary.pct===100', `got ${prog.summary.pct}`);
assert(prog.summary.eta_seconds === 0, '2: eta_seconds===0 at completion', `got ${prog.summary.eta_seconds}`);
assert(prog.summary.last_loss === LAST_LOSS, '3: last_loss matches', `got ${prog.summary.last_loss}`);
assert(prog.summary.total_steps === 40, '3: total_steps===40', `got ${prog.summary.total_steps}`);
// cumulative cost -> latest value
assert(Math.abs(prog.summary.cost_usd - FINAL_COST) < 1e-9, '3: cost_usd === final cumulative', `got ${prog.summary.cost_usd}`);
assert(prog.summary.cot_flags === 0, '3: cot_flags===0', `got ${prog.summary.cot_flags}`);
assert(prog.summary.tok_per_s != null && prog.summary.tok_per_s > 0, '3: tok_per_s computed', `got ${prog.summary.tok_per_s}`);

// --- 4-5. renderDashboardHtml -----------------------------------------------
const html = renderDashboardHtml(prog);
assert(typeof html === 'string', '4: renderDashboardHtml returns string', typeof html);
assert(html.includes('<svg'), '4: html contains <svg', 'no <svg');
assert(html.includes('<polyline'), '4: html contains <polyline', 'no <polyline');
assert(html.includes(LAST_LOSS.toFixed(4)), '4: html shows last loss value', `missing ${LAST_LOSS.toFixed(4)}`);
assert(html.includes('$' + FINAL_COST.toFixed(4)), '4: html shows a cost figure', `missing $${FINAL_COST.toFixed(4)}`);
// cool-slate palette only — no warm hex anywhere in the document
assert(!/#c2410c/i.test(html), '5: no warm accent #c2410c', 'found #c2410c');
assert(!/#faf9f7/i.test(html), '5: no warm paper #faf9f7', 'found #faf9f7');
// spot-check a couple of cool-slate tokens are actually present
assert(/#1f2937/i.test(html) && /#56606c/i.test(html), '5: cool-slate tokens present', 'missing slate tokens');

// --- 6. renderSparkline edge cases ------------------------------------------
const sparkEmpty = renderSparkline([]);
assert(typeof sparkEmpty === 'string' && sparkEmpty.includes('<svg'), '6: renderSparkline([]) returns <svg, no crash', sparkEmpty.slice(0, 80));
const sparkOne = renderSparkline([{ step: 5, loss: 0.9 }]);
assert(sparkOne.includes('<svg') && !sparkOne.includes('NaN'), '6: renderSparkline(1 point) ok, no NaN', sparkOne.slice(0, 120));
const sparkMany = renderSparkline(prog.points);
assert(sparkMany.includes('<polyline') && !sparkMany.includes('NaN'), '6: renderSparkline(many) has polyline, no NaN', sparkMany.slice(0, 120));

// --- 8. missing run dir -----------------------------------------------------
const missing = readProgress('run_does_not_exist', { baseDir: tmp });
assert(missing.ok === true && missing.exists === false, '8: missing run -> ok + exists:false', JSON.stringify(missing).slice(0, 160));
assert(missing.points.length === 0 && missing.summary.last_loss === null, '8: empty summary for missing run', JSON.stringify(missing.summary));
const waitHtml = renderDashboardHtml(missing);
assert(waitHtml.includes('waiting for first progress line'), '8: missing run renders waiting state', 'no waiting banner');
assert(waitHtml.includes('<svg'), '8: waiting state still renders an <svg frame', 'no <svg');

// --- 7. live server round-trip (ephemeral port) -----------------------------
function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(new Error('timeout')); });
  });
}

const srv = startWatchServer({ runId, port: 0, baseDir: tmp });
assert(srv.ok === true, '7: startWatchServer ok', JSON.stringify(srv).slice(0, 160));
if (srv.ok) {
  await srv.ready; // ephemeral port is known once 'listening' fires
  assert(typeof srv.port === 'number' && srv.port > 0, '7: bound to a real ephemeral port', `got ${srv.port}`);
  assert(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(srv.url), '7: url shape', srv.url);
  try {
    const root = await get(srv.url);
    assert(root.status === 200, '7: GET / -> 200', `status ${root.status}`);
    assert(root.body.includes('<polyline'), '7: GET / body has <polyline', 'no polyline in body');

    const data = await get(srv.url + 'data.json');
    assert(data.status === 200, '7: GET /data.json -> 200', `status ${data.status}`);
    let parsed = null;
    try { parsed = JSON.parse(data.body); } catch (e) { bad('7: /data.json valid JSON', e.message); }
    if (parsed) {
      assert(parsed.ok === true, '7: /data.json ok:true', JSON.stringify(parsed).slice(0, 120));
      assert(parsed.points && parsed.points.length === 5, '7: /data.json points.length===5', `got ${parsed.points && parsed.points.length}`);
    }
  } catch (e) {
    bad('7: live server round-trip', e.message);
  } finally {
    await srv.close();
  }
}

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
