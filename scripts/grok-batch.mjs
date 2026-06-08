#!/usr/bin/env node
// scripts/grok-batch.mjs — run a batch of Grok Agent-Tools research queries concurrently with retries.
// Usage: node scripts/grok-batch.mjs [queriesFile] [outDir] [--concurrency 6] [--model grok-4.3]
// Reads queries.json (array of {id, track, sources, prompt}); writes <outDir>/<id>.json each; writes index.json.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/user/Desktop/kolmogorov-stack';
function loadKey() {
  if (process.env.XAI_API_KEY && process.env.XAI_API_KEY.trim()) return process.env.XAI_API_KEY.trim();
  for (const f of [path.join(ROOT, '.env.research.local'), path.resolve(process.cwd(), '.env.research.local')]) {
    try {
      const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).find((l) => l.startsWith('XAI_API_KEY='));
      if (line) { const v = line.slice(12).trim().replace(/^"|"$/g, ''); if (v) return v; }
    } catch {}
  }
  throw new Error('XAI_API_KEY not found');
}
const KEY = loadKey();

const argv = process.argv.slice(2);
const positional = [];
let concurrency = 6;
let model = 'grok-4.3';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--concurrency') concurrency = parseInt(argv[++i], 10);
  else if (argv[i] === '--model') model = argv[++i];
  else positional.push(argv[i]);
}
const queriesFile = positional[0] || path.join(ROOT, 'research/strategy-2026/queries.json');
const outDir = positional[1] || path.join(ROOT, 'research/strategy-2026/raw');
fs.mkdirSync(outDir, { recursive: true });
const queries = JSON.parse(fs.readFileSync(queriesFile, 'utf8'));

function extract(data) {
  let text = '';
  const cites = [];
  const searched = [];
  for (const item of Array.isArray(data.output) ? data.output : []) {
    if (!item) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && (c.type === 'output_text' || c.type === 'text')) {
          text += c.text || '';
          for (const a of c.annotations || []) if (a && a.url) cites.push(a.url);
        }
      }
    } else if (typeof item.type === 'string' && item.type.endsWith('_search_call')) {
      for (const s of (item.action && item.action.sources) || []) if (s && s.url) searched.push(s.url);
    }
  }
  if (!text && data.output_text) text = Array.isArray(data.output_text) ? data.output_text.join('\n') : data.output_text;
  return { text, cites: [...new Set(cites)], searched: [...new Set(searched)] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOne(q) {
  const sources = (q.sources || 'x,web').split(',').map((s) => s.trim());
  const toolTypes = [...new Set(sources.map((s) => (s === 'x' ? 'x_search' : 'web_search')))];
  const body = { model, input: [{ role: 'user', content: q.prompt }], tools: toolTypes.map((t) => ({ type: t })), stream: false };
  const backoffs = [0, 4000, 10000, 25000];
  let lastErr = '';
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await sleep(backoffs[attempt]);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 180000);
    try {
      const res = await fetch('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const txt = await res.text();
      clearTimeout(to);
      if (!res.ok) { lastErr = `HTTP ${res.status} ${txt.slice(0, 300)}`; continue; }
      const data = JSON.parse(txt);
      const { text, cites, searched } = extract(data);
      if (!text || text.length < 40) { lastErr = `empty/short (${text.length})`; continue; }
      return { id: q.id, track: q.track, prompt: q.prompt, content: text, citations: cites, searched, usage: data.usage, attempts: attempt + 1 };
    } catch (e) {
      clearTimeout(to);
      lastErr = e.name === 'AbortError' ? 'timeout' : e.message;
    }
  }
  return { id: q.id, track: q.track, prompt: q.prompt, error: lastErr };
}

async function pool(items, n, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    const i = idx++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, next));
  return results;
}

console.log(`[grok-batch] ${queries.length} queries, concurrency=${concurrency}, model=${model}`);
const t0 = Date.now();
let done = 0;
const results = await pool(queries, concurrency, async (q) => {
  const r = await runOne(q);
  fs.writeFileSync(path.join(outDir, `${q.id}.json`), JSON.stringify(r, null, 2));
  done++;
  const tag = r.error ? `ERROR(${r.error.slice(0, 60)})` : `${r.content.length}c/${r.citations.length}cite/${r.searched.length}src/a${r.attempts}`;
  console.log(`[${done}/${queries.length}] ${q.id} -> ${tag}`);
  return r;
});
const ok = results.filter((r) => !r.error);
const failed = results.filter((r) => r.error);
const index = {
  generated_seconds: Math.round((Date.now() - t0) / 1000),
  total: results.length,
  ok: ok.length,
  failed: failed.map((r) => ({ id: r.id, error: r.error })),
  by_track: [...new Set(queries.map((q) => q.track))].map((t) => ({ track: t, n: results.filter((r) => r.track === t && !r.error).length })),
  files: ok.map((r) => ({ id: r.id, track: r.track, chars: r.content.length, citations: r.citations.length })),
};
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
console.log(`[grok-batch] DONE in ${index.generated_seconds}s — ${ok.length} ok, ${failed.length} failed. Index: ${path.join(outDir, 'index.json')}`);
