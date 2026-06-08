#!/usr/bin/env node
// scripts/grok-research.mjs — Grok Agent-Tools research harness (web + X search).
// Usage:
//   node scripts/grok-research.mjs [--model grok-4.3] [--sources x,web]
//        [--json] [--raw] [--out FILE] "PROMPT"
//   echo "PROMPT" | node scripts/grok-research.mjs --json --out result.json
// Reads XAI_API_KEY from env or the gitignored .env.research.local. Never bake the key into a script.
import fs from 'node:fs';
import path from 'node:path';

function loadKey() {
  if (process.env.XAI_API_KEY && process.env.XAI_API_KEY.trim()) return process.env.XAI_API_KEY.trim();
  const candidates = [
    path.resolve(process.cwd(), '.env.research.local'),
    'C:/Users/user/Desktop/kolmogorov-stack/.env.research.local',
    path.resolve(process.cwd(), '.env.local'),
  ];
  for (const f of candidates) {
    try {
      const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).find((l) => l.startsWith('XAI_API_KEY='));
      if (line) {
        const v = line.slice('XAI_API_KEY='.length).trim().replace(/^"|"$/g, '');
        if (v) return v;
      }
    } catch {}
  }
  throw new Error('XAI_API_KEY not found (env or .env.research.local)');
}

const argv = process.argv.slice(2);
let model = 'grok-4.3';
let sources = ['x', 'web'];
let json = false;
let raw = false;
let out = null;
const prompt = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model') model = argv[++i];
  else if (a === '--sources') sources = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--json') json = true;
  else if (a === '--raw') raw = true;
  else if (a === '--out') out = argv[++i];
  else prompt.push(a);
}
let content = prompt.join(' ');
if (!content) { try { content = fs.readFileSync(0, 'utf8'); } catch {} }
if (!content || !content.trim()) { console.error('No prompt provided.'); process.exit(2); }

const toolTypes = [...new Set(sources.map((s) => (s === 'x' ? 'x_search' : 'web_search')))];
const body = {
  model,
  input: [{ role: 'user', content }],
  tools: toolTypes.map((t) => ({ type: t })),
  stream: false,
};

function extract(data) {
  let text = '';
  const cites = [];
  const searched = [];
  const out2 = Array.isArray(data.output) ? data.output : [];
  for (const item of out2) {
    if (!item) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && (c.type === 'output_text' || c.type === 'text')) {
          text += c.text || '';
          for (const a of c.annotations || []) if (a && a.url) cites.push(a.url);
        }
      }
    } else if (typeof item.type === 'string' && item.type.endsWith('_search_call')) {
      const ss = (item.action && item.action.sources) || [];
      for (const s of ss) if (s && s.url) searched.push(s.url);
    }
  }
  if (!text && data.output_text) text = Array.isArray(data.output_text) ? data.output_text.join('\n') : data.output_text;
  if (Array.isArray(data.citations)) for (const c of data.citations) cites.push(typeof c === 'string' ? c : c.url || JSON.stringify(c));
  return { text, cites: [...new Set(cites)], searched: [...new Set(searched)] };
}

const key = loadKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffs = [0, 4000, 10000, 25000];
let txt = '';
let okGot = false;
let lastErr = '';
for (let attempt = 0; attempt < backoffs.length; attempt++) {
  if (backoffs[attempt]) await sleep(backoffs[attempt]);
  try {
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    txt = await res.text();
    if (res.ok) { okGot = true; break; }
    lastErr = `HTTP ${res.status} ${txt.slice(0, 300)}`;
  } catch (e) {
    lastErr = e.message;
  }
}
if (!okGot) { console.error('REQUEST FAILED after retries:', lastErr); process.exit(1); }
let data;
try { data = JSON.parse(txt); } catch { if (out) fs.writeFileSync(out, txt); else console.log(txt); process.exit(0); }

let rendered;
if (raw) {
  rendered = JSON.stringify(data, null, 2);
} else {
  const { text, cites, searched } = extract(data);
  if (json) {
    rendered = JSON.stringify({ model, content: text, citations: cites, searched, usage: data.usage }, null, 2);
  } else {
    rendered = text + (cites.length ? '\n\n--- CITATIONS ---\n' + cites.map((c, i) => `[${i + 1}] ${c}`).join('\n') : '')
      + (searched.length ? '\n\n--- SEARCHED ---\n' + searched.map((c, i) => `[${i + 1}] ${c}`).join('\n') : '');
  }
}
if (out) {
  fs.writeFileSync(out, rendered);
  console.log(`wrote ${rendered.length} chars to ${out}`);
} else {
  process.stdout.write(rendered + '\n');
}
