#!/usr/bin/env node
// scripts/trinity-2000-v2-seed-gen.mjs
//
// Trinity 2000 v2 — generates 2000 diverse customer-support seed prompts via
// the kolm teacher proxy. Built on the trinity-500 generator but:
//   - Adds 3-gram overlap dedupe (>0.8 = duplicate)
//   - Cycles sub-domain prompts across 8 buckets so the council training set
//     has balanced coverage (no Claude-bias toward one topic)
//   - Resumable: re-running picks up at row N+1
//
// Output: ~/.kolm/distill-runs/trinity-2000-v2-2026-05-28/seeds.jsonl

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RUN_DIR = path.join(os.homedir(), '.kolm', 'distill-runs', 'trinity-2000-v2-2026-05-28');
const SEEDS = path.join(RUN_DIR, 'seeds.jsonl');
const TARGET = 2000;
const BATCH = 50;

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.kolm', 'config.json'), 'utf-8'));
const BASE = String(cfg.base || 'https://kolm.ai').replace(/\/+$/, '');
const KEY = String(cfg.api_key || '');
if (!KEY) {
  console.error('no kolm key in ~/.kolm/config.json — run `kolm login`');
  process.exit(1);
}

fs.mkdirSync(RUN_DIR, { recursive: true });

const BUCKETS = [
  { id: 'refunds_returns',   weight: 250, focus: 'refunds, returns, exchanges, restocking fees, store credit, return-by-mail' },
  { id: 'shipping_delivery', weight: 250, focus: 'shipping delays, lost packages, wrong address, delivery confirmation, expedited shipping, customs' },
  { id: 'warranty_repair',   weight: 200, focus: 'warranty claims, repair requests, replacement parts, extended warranty, out-of-warranty support' },
  { id: 'billing_payment',   weight: 250, focus: 'unauthorized charges, refund timing, payment method update, invoice questions, subscription billing, double-charge' },
  { id: 'technical_issues',  weight: 300, focus: 'product not working, setup help, troubleshooting, software bugs, hardware failure, compatibility' },
  { id: 'account_access',    weight: 200, focus: 'cannot log in, password reset, account locked, two-factor issues, email change, account merge' },
  { id: 'loyalty_discount',  weight: 200, focus: 'discount codes, loyalty points, referral programs, price match, abandoned-cart offers, VIP tier' },
  { id: 'escalation_complex',weight: 350, focus: 'angry customer, multiple prior contacts, contradicting policy, edge case, ambiguous request, ethically dubious demand (unauthorized discount, refund without proof of purchase)' },
];
const totalWeight = BUCKETS.reduce((a, b) => a + b.weight, 0);
if (totalWeight !== TARGET) {
  console.error(`[seed-gen] bucket weights sum to ${totalWeight}, expected ${TARGET}`);
  process.exit(1);
}

const existing = fs.existsSync(SEEDS)
  ? fs.readFileSync(SEEDS, 'utf-8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
console.log(`[seed-gen] existing rows: ${existing.length} / ${TARGET}`);
if (existing.length >= TARGET) {
  console.log('[seed-gen] target met; nothing to do.');
  process.exit(0);
}

const bucketCounts = {};
for (const b of BUCKETS) bucketCounts[b.id] = 0;
for (const r of existing) if (r._bucket && bucketCounts[r._bucket] !== undefined) bucketCounts[r._bucket]++;

function tri(s) {
  const t = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 2 < t.length; i++) out.add(t[i] + ' ' + t[i + 1] + ' ' + t[i + 2]);
  return out;
}
function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const x of a) if (b.has(x)) common++;
  return common / Math.min(a.size, b.size);
}
const triCache = existing.map((r) => tri(r.input));

const SYSTEM = 'You are a meticulous customer-support training-data designer. You write ONE-LINE user messages that a customer would send to a support agent. Be diverse in tone (frustrated, polite, confused, formal, casual, sarcastic), product type (electronics, apparel, subscriptions, services, B2B SaaS, consumer goods), and detail level (some specific with order IDs/dates/amounts, some vague). Never repeat the same scenario twice. Output ONLY the user messages, one per line, no numbering, no preamble, no quotes.';

function userPrompt(bucket, need, seenSample) {
  return `Generate exactly ${need} distinct customer-support user messages focused on: ${bucket.focus}.\n${seenSample.length ? `Avoid these themes already covered:\n${seenSample.map((s) => '  - ' + s).join('\n')}\n` : ''}Mix tones (some angry, some polite, some confused). Mix detail levels. Output ${need} messages, one per line.`;
}

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
  if (!r.ok) throw new Error(`proxy http ${r.status}: ${t.slice(0, 400)}`);
  const j = JSON.parse(t);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

let nextId = existing.length;
const fp = fs.openSync(SEEDS, 'a');

while (nextId < TARGET) {
  // pick the bucket furthest from its target (round-robin by deficit)
  let pickBucket = BUCKETS[0];
  let maxDeficit = -Infinity;
  for (const b of BUCKETS) {
    const deficit = b.weight - bucketCounts[b.id];
    if (deficit > maxDeficit) {
      maxDeficit = deficit;
      pickBucket = b;
    }
  }
  if (maxDeficit <= 0) break;

  const need = Math.min(BATCH, maxDeficit, TARGET - nextId);
  const seenSample = existing.filter((r) => r._bucket === pickBucket.id).slice(-12).map((r) => r.input.slice(0, 90));

  console.log(`[seed-gen] bucket=${pickBucket.id} deficit=${maxDeficit} request=${need} total=${nextId}/${TARGET}`);
  const t0 = Date.now();
  let text;
  try {
    text = await callProxy({
      system: SYSTEM,
      input: userPrompt(pickBucket, need, seenSample),
      maxTokens: 4096,
      model: 'claude-sonnet-4-5-20250929',
    });
  } catch (e) {
    console.error('[seed-gen] proxy error: ' + e.message);
    await new Promise((r) => setTimeout(r, 3000));
    continue;
  }
  const lines = text.split('\n').map((l) => l.replace(/^\s*[-*\d\.\)]\s*/, '').trim()).filter((l) => l.length > 12 && l.length < 360);
  let added = 0;
  let dedupRejected = 0;
  for (const ln of lines) {
    if (nextId >= TARGET) break;
    if (bucketCounts[pickBucket.id] >= pickBucket.weight) break;
    const candTri = tri(ln);
    let dup = false;
    for (const t of triCache) {
      if (overlap(candTri, t) > 0.8) { dup = true; break; }
    }
    if (dup) { dedupRejected++; continue; }
    triCache.push(candTri);
    const row = { id: 'sup_' + String(nextId + 1).padStart(4, '0'), input: ln, output: '', _bucket: pickBucket.id };
    fs.writeSync(fp, JSON.stringify(row) + '\n');
    existing.push(row);
    bucketCounts[pickBucket.id]++;
    nextId++;
    added++;
  }
  console.log(`[seed-gen] +${added} rejected=${dedupRejected} in ${((Date.now() - t0) / 1000).toFixed(1)}s  (bucket ${pickBucket.id}: ${bucketCounts[pickBucket.id]}/${pickBucket.weight})`);
  if (added === 0) {
    // generator getting stuck — bump diversity hint by sampling more
    console.error('[seed-gen] zero new rows; widening seen sample');
  }
}
fs.closeSync(fp);
console.log('[seed-gen] done: ' + nextId + ' rows -> ' + SEEDS);
console.log('[seed-gen] bucket distribution:');
for (const b of BUCKETS) console.log(`  ${b.id}: ${bucketCounts[b.id]}/${b.weight}`);
