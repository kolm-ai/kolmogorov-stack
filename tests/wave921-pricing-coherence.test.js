// W921 — pricing single-source-of-truth coherence lock-in.
//
// src/plan-catalog.js is the canonical tier catalog. This test fails the build
// on any drift between the catalog and the marketing surfaces that must mirror
// it: the homepage ROI plan selector, the /pricing JSON-LD offers, and the
// inline PLAN_CATALOG still living in src/router.js. It is the "CI coherence
// gate" from spec #52 — implemented as a fast, server-free unit test so it runs
// in every `npm test` without booting anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN_CATALOG, PLAN_ORDER } from '../src/plan-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PRICED_SELF_SERVE = PLAN_ORDER.filter((id) => {
  const p = PLAN_CATALOG[id];
  return p.self_serve !== false && typeof p.price_usd_month === 'number';
});

test('#1 homepage ROI selector lists every priced self-serve tier at its catalog price', () => {
  const html = read('public/index.html');
  const m = html.match(/<select[^>]*id="roi-plan"[\s\S]*?<\/select>/i);
  assert.ok(m, 'index.html must contain the #roi-plan selector');
  const sel = m[0];
  for (const id of PRICED_SELF_SERVE) {
    const p = PLAN_CATALOG[id];
    const needle = `${p.label}: $${p.price_usd_month}`;
    assert.ok(sel.includes(needle), `ROI selector is missing "${needle}" (catalog tier ${id})`);
  }
});

test('#2 /pricing JSON-LD lists one Offer per catalog tier and offerCount matches', () => {
  const html = read('public/pricing.html');
  // Every catalog tier label must appear as a JSON-LD Offer name.
  for (const id of PLAN_ORDER) {
    const label = PLAN_CATALOG[id].label;
    assert.match(html, new RegExp(`"@type":\\s*"Offer",\\s*"name":\\s*"${label}"`),
      `pricing.html JSON-LD is missing an Offer for "${label}"`);
  }
  // AggregateOffer.offerCount must equal the number of visible tiers.
  const oc = html.match(/"offerCount":\s*"(\d+)"/);
  assert.ok(oc, 'pricing.html must declare an AggregateOffer.offerCount');
  assert.equal(Number(oc[1]), PLAN_ORDER.length,
    `offerCount ${oc[1]} must equal the ${PLAN_ORDER.length} catalog tiers`);
});

test('#3 router PLAN_CATALOG price labels match the canonical catalog (no backend drift)', () => {
  const router = read('src/router.js');
  for (const id of PLAN_ORDER) {
    const p = PLAN_CATALOG[id];
    // Each tier id + its price_label must co-occur in router's inline catalog.
    assert.ok(router.includes(`id: '${id}'`), `router PLAN_CATALOG missing tier id '${id}'`);
    assert.ok(router.includes(`price_label: '${p.price_label}'`),
      `router PLAN_CATALOG price_label drift for '${id}': expected '${p.price_label}'`);
  }
});
