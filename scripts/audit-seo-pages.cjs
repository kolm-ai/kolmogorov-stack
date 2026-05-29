#!/usr/bin/env node
// W921 — thin-content / uniqueness / structured-data / proof gate for the
// programmatically generated SEO families (compare / integrations / use-cases /
// for) produced by scripts/build-comparison-seo.cjs.
//
// Enforces the Google March-2024 scaled-content-abuse guardrail at BUILD time:
//   - unique_ratio >= MIN_UNIQUE (5-gram shingle diff vs same-family siblings)
//   - word_count   >= MIN_WORDS
//   - distinct_proof_refs >= 1 (a resolvable /benchmarks, /case-studies, or
//     /verify-prod link)
//   - every <script type="application/ld+json"> JSON.parses
//   - every proof href on the page resolves on disk
//
// A page below threshold is reported (and the gate fails with exit 1). Pages
// are sourced ONLY from the catalog (data/seo-catalog/*.json) so the auditor
// never touches the hand-authored, test-pinned pages.
//
// Usage:
//   node scripts/audit-seo-pages.cjs            # human summary, exit 1 on fail
//   node scripts/audit-seo-pages.cjs --json      # machine-readable single line
//
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const gen = require('./build-comparison-seo.cjs');

const MIN_UNIQUE = 0.30;
const MIN_WORDS = 300;

function bodyOf(html) {
  const m = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  return m ? m[1] : html;
}

function wordCount(text) {
  const stripped = String(text).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ');
  return stripped.trim().split(/\s+/).filter(Boolean).length;
}

function proofRefsIn(html) {
  const refs = new Set();
  const re = /href="(\/(?:benchmarks|case-studies|verify-prod)[^"#?]*)/g;
  let m;
  while ((m = re.exec(html))) refs.add(m[1]);
  return [...refs];
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function auditSeoPages(opts = {}) {
  const minUnique = opts.minUnique != null ? opts.minUnique : MIN_UNIQUE;
  const minWords = opts.minWords != null ? opts.minWords : MIN_WORDS;
  const publicDir = opts.publicDir || PUBLIC;

  const catalog = gen.loadSeoCatalog();
  const pages = gen.renderAll(catalog);

  // Group bodies by family for sibling shingle comparison.
  const familyBodies = {};
  for (const p of pages) {
    (familyBodies[p.family] = familyBodies[p.family] || []).push({ slug: p.slug, body: bodyOf(p.html) });
  }

  const thin = [];
  const brokenProof = [];
  const badJsonLd = [];
  const geoScores = {};
  const details = [];

  for (const p of pages) {
    const body = bodyOf(p.html);
    const siblings = familyBodies[p.family].filter((s) => s.slug !== p.slug).map((s) => s.body);
    const uniqueRatio = gen.computeUniqueRatio(body, siblings);
    const words = wordCount(body);
    const refs = proofRefsIn(p.html);
    const geo = gen.computeGeoScore(p.html);
    geoScores[p.canonicalPath] = geo.score;

    // JSON-LD validity
    for (const block of jsonLdBlocks(p.html)) {
      try {
        JSON.parse(block);
      } catch (e) {
        badJsonLd.push(`${p.canonicalPath}: ${String(e.message || e)}`);
      }
    }

    // Proof href resolution
    try {
      gen.assertProofRefsResolve(refs, publicDir);
    } catch (e) {
      brokenProof.push(`${p.canonicalPath}: ${String(e.message || e)}`);
    }
    if (refs.length < 1) brokenProof.push(`${p.canonicalPath}: no proof ref (need >=1 /benchmarks|/case-studies|/verify-prod link)`);

    if (uniqueRatio < minUnique || words < minWords) {
      thin.push(`${p.canonicalPath}: unique_ratio=${uniqueRatio.toFixed(3)} words=${words}`);
    }

    details.push({ path: p.canonicalPath, family: p.family, unique_ratio: Number(uniqueRatio.toFixed(3)), words, proof_refs: refs.length, geo: geo.score });
  }

  const pass = thin.length === 0 && brokenProof.length === 0 && badJsonLd.length === 0;
  return { pass, thin, brokenProof, badJsonLd, geoScores, details, total: pages.length, minUnique, minWords };
}

if (require.main === module) {
  const jsonMode = process.argv.includes('--json');
  const r = auditSeoPages();
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ spec: 'kolm-seo-pages-audit-1', ok: r.pass, counts: { total: r.total, thin: r.thin.length, brokenProof: r.brokenProof.length, badJsonLd: r.badJsonLd.length }, thin: r.thin, brokenProof: r.brokenProof, badJsonLd: r.badJsonLd, geoScores: r.geoScores }) + '\n');
  } else {
    const tag = r.pass ? 'PASS' : 'FAIL';
    process.stdout.write(`[audit-seo-pages] ${tag} - ${r.total} pages, ${r.thin.length} thin, ${r.brokenProof.length} broken-proof, ${r.badJsonLd.length} bad-jsonld (min_unique=${r.minUnique}, min_words=${r.minWords})\n`);
    const minGeo = Math.min(...Object.values(r.geoScores));
    process.stdout.write(`  geo_score range: ${minGeo.toFixed(2)}..${Math.max(...Object.values(r.geoScores)).toFixed(2)}\n`);
    for (const t of r.thin) process.stdout.write('  THIN: ' + t + '\n');
    for (const b of r.brokenProof) process.stdout.write('  PROOF: ' + b + '\n');
    for (const j of r.badJsonLd) process.stdout.write('  JSONLD: ' + j + '\n');
  }
  process.exit(r.pass ? 0 : 1);
}

module.exports = { auditSeoPages };
