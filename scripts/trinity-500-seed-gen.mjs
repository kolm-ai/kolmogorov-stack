#!/usr/bin/env node
// scripts/trinity-500-seed-gen.mjs
//
// W870 follow-on — generate 500 diverse customer-support seed prompts via
// the kolm teacher proxy (api/teacher-chat.js on Vercel). Uses Claude as
// the seed-generator because (a) Claude's diversity is good, (b) the
// proxy already proves Anthropic relay works end-to-end.
//
// Output: $RUN_DIR/seeds.jsonl   (500 rows of {id, input, output:""})
//
// Idempotent — re-running appends only the missing batches; existing rows
// are preserved.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RUN_DIR = path.join(os.homedir(), '.kolm', 'distill-runs', 'trinity-500-2026-05-26');
const SEEDS = path.join(RUN_DIR, 'seeds.jsonl');
const TARGET = 500;
const BATCH = 50;

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.kolm', 'config.json'), 'utf-8'));
const BASE = String(cfg.base || 'https://kolm.ai').replace(/\/+$/, '');
const KEY  = String(cfg.api_key || '');
if (!KEY) {
  console.error('no kolm key in ~/.kolm/config.json — run `kolm login`');
  process.exit(1);
}

fs.mkdirSync(RUN_DIR, { recursive: true });

const existing = fs.existsSync(SEEDS)
  ? fs.readFileSync(SEEDS, 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
console.log(`[seed-gen] existing rows: ${existing.length} / ${TARGET}`);

if (existing.length >= TARGET) {
  console.log('[seed-gen] target met; nothing to do.');
  process.exit(0);
}

const SYSTEM = 'You are a meticulous customer-support training-data designer. You write ONE-LINE user messages that a customer would send to a support agent. Cover the full distribution: refunds, returns, shipping, warranty, billing, technical issues, account problems, loyalty/discount, escalations, edge cases, ambiguous requests, and adversarial probes (asking for unauthorized discounts, demanding refunds without info, etc.). Be diverse in tone (frustrated, polite, confused, formal, casual), product type (electronics, apparel, subscriptions, services), and detail level (some specific with order IDs, some vague). Never repeat the same scenario twice. Output ONLY the user messages, one per line, no numbering, no preamble, no quotes.';

const USER_TEMPLATE = (n, seenSample) => `Generate exactly ${n} distinct customer-support user messages. ${seenSample.length ? `Avoid duplicating these themes:\n${seenSample.map((s) => '  - ' + s).join('\n')}\n` : ''}Output ${n} messages, one per line.`;

async function callProxy({ system, input, maxTokens, model }) {
  const r = await fetch(BASE + '/v1/teacher/chat', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      vendor: 'anthropic',
      model: model || 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: input }],
    }),
  });
  const t = await r.text();
  if (!r.ok) {
    throw new Error(`proxy http ${r.status}: ${t.slice(0, 400)}`);
  }
  const j = JSON.parse(t);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

let seenSample = existing.slice(-15).map((r) => r.input.slice(0, 80));
const allInputs = new Set(existing.map((r) => r.input.trim().toLowerCase()));
let nextId = existing.length;
const fp = fs.openSync(SEEDS, 'a');

while (nextId < TARGET) {
  const need = Math.min(BATCH, TARGET - nextId);
  console.log(`[seed-gen] batch -> request ${need} (have ${nextId}/${TARGET})`);
  const t0 = Date.now();
  let text;
  try {
    text = await callProxy({
      system: SYSTEM,
      input: USER_TEMPLATE(need, seenSample),
      maxTokens: 4096,
      model: 'claude-sonnet-4-5-20250929',
    });
  } catch (e) {
    console.error('[seed-gen] proxy error: ' + e.message);
    await new Promise((r) => setTimeout(r, 3000));
    continue;
  }
  const lines = text.split('\n').map((l) => l.replace(/^\s*[-*\d\.\)]\s*/, '').trim()).filter((l) => l.length > 8 && l.length < 320);
  let added = 0;
  for (const ln of lines) {
    const k = ln.trim().toLowerCase();
    if (allInputs.has(k)) continue;
    allInputs.add(k);
    const row = { id: 'sup_' + String(nextId + 1).padStart(3, '0'), input: ln, output: '' };
    fs.writeSync(fp, JSON.stringify(row) + '\n');
    nextId++;
    added++;
    if (nextId >= TARGET) break;
  }
  console.log(`[seed-gen] +${added} new in ${((Date.now() - t0) / 1000).toFixed(1)}s  (total ${nextId}/${TARGET})`);
  if (added === 0) {
    console.error('[seed-gen] zero new rows from batch — sampling smaller seenSample and retrying');
    seenSample = existing.slice(-5).map((r) => r.input.slice(0, 60));
  } else {
    seenSample = Array.from(allInputs).slice(-15);
  }
}
fs.closeSync(fp);
console.log('[seed-gen] done: ' + nextId + ' rows -> ' + SEEDS);
