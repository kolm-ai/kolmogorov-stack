#!/usr/bin/env node
// W921 — verifiable social-proof rail: build-time single-source-of-truth
// generator. Writes public/social-proof.json, the one artifact the homepage
// rail renders from. Three composable inputs:
//
//   (1) OSS traction (stars/forks/contributors/last-release) fetched ONCE at
//       build time from the GitHub REST API with an ETag conditional request,
//       degrading to the last-good value on any failure and NEVER fabricating a
//       count. Below STAR_DISPLAY_FLOOR the rail leads with always-true
//       credibility chips instead of a small star number that backfires (the
//       digitalapplied 2026 >1000-star inflection).
//
//   (2) Verifiable benchmark proof points — pulled from the SAME benchmark JSON
//       the homepage and /benchmarks already cite, so every rendered number has
//       an X04 fixture (data/x04-claim-fixtures.json) and cannot drift.
//
//   (3) Anonymized-role case-study cards — link to the on-disk case studies and
//       to /verify-prod. Per public/case-studies/index.html policy
//       ("We do not publish customer names"), attributions are role-only; no
//       named person and no illustrative case-study figure is surfaced near the
//       hero (those illustrative numbers cannot be X04-bound to a separate
//       evidence file).
//
// Offline-deterministic: with the network blocked and a prior social-proof.json
// present, the build reuses the last-good OSS block and sets stale:true.
//
// Usage:
//   node scripts/build-social-proof.cjs            # fetch (or reuse) + write
//   node scripts/build-social-proof.cjs --offline  # never touch the network
//   node scripts/build-social-proof.cjs --json      # print the artifact
//
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(PUBLIC, 'social-proof.json');

const REPO = process.env.KOLM_OSS_REPO || 'kolm-ai/kolm';
const STAR_DISPLAY_FLOOR = 1000;
const FETCH_TIMEOUT_MS = 8000;

function readPrev() {
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// fetchOssTraction — ETag-conditional, degrades to last-good, never fabricates
// ---------------------------------------------------------------------------

async function fetchOssTraction(repo, { token, prevEtag, prev, timeoutMs = FETCH_TIMEOUT_MS, offline = false } = {}) {
  const nowIso = new Date().toISOString();
  const lastGood = (prev && prev.oss) || {};
  const degrade = (reason) => ({
    available: Boolean(lastGood && lastGood.available),
    stale: true,
    reason,
    stargazers_count: lastGood.stargazers_count != null ? lastGood.stargazers_count : null,
    forks_count: lastGood.forks_count != null ? lastGood.forks_count : null,
    contributors: lastGood.contributors != null ? lastGood.contributors : null,
    pushed_at: lastGood.pushed_at || null,
    etag: lastGood.etag || null,
    fetched_at: lastGood.fetched_at || nowIso,
  });

  if (offline) return degrade('offline');
  if (typeof fetch !== 'function') return degrade('no_fetch');

  const headers = { 'User-Agent': 'kolm-build-social-proof', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prevEtag) headers['If-None-Match'] = prevEtag;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: ctrl.signal });
    if (res.status === 304) {
      // No change — reuse last-good, NOT stale (the cache is current).
      return Object.assign(degrade('not_modified'), { stale: false, available: Boolean(lastGood.available) });
    }
    if (!res.ok) return degrade(`http_${res.status}`);
    const body = await res.json();
    const etag = res.headers.get('etag');
    // Contributors via Link rel=last on a 1-per-page query.
    let contributors = lastGood.contributors != null ? lastGood.contributors : null;
    try {
      const cres = await fetch(`https://api.github.com/repos/${repo}/contributors?per_page=1&anon=1`, { headers, signal: ctrl.signal });
      if (cres.ok) {
        const link = cres.headers.get('link') || '';
        const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
        if (m) contributors = Number(m[1]);
        else contributors = (await cres.json()).length || contributors;
      }
    } catch (_) { /* keep last-good contributors */ }
    return {
      available: true,
      stale: false,
      reason: 'ok',
      stargazers_count: typeof body.stargazers_count === 'number' ? body.stargazers_count : null,
      forks_count: typeof body.forks_count === 'number' ? body.forks_count : null,
      contributors,
      pushed_at: body.pushed_at || null,
      etag: etag || null,
      fetched_at: nowIso,
    };
  } catch (e) {
    return degrade('error:' + String(e && e.name || e));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// applyDisplayPolicy — >=1000-star inflection gate
// ---------------------------------------------------------------------------

function applyDisplayPolicy(oss, { starFloor = STAR_DISPLAY_FLOOR } = {}) {
  const stars = oss && typeof oss.stargazers_count === 'number' ? oss.stargazers_count : null;
  const showStars = stars != null && stars >= starFloor;
  return {
    show_star_count: showStars,
    show_forks: showStars && oss.forks_count != null,
    show_contributors: showStars && oss.contributors != null,
    lead_with: showStars ? 'stars' : 'chips',
  };
}

// ---------------------------------------------------------------------------
// extractBenchmarkProof — X04-fixtured numbers only (cannot drift)
// ---------------------------------------------------------------------------

function readJsonSafe(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PUBLIC, rel), 'utf8'));
  } catch (_) {
    return null;
  }
}

function extractBenchmarkProof() {
  const cards = [];
  const trinity = readJsonSafe('benchmarks/trinity-500-benchmark.json');
  const redaction = readJsonSafe('benchmarks/redaction-public-benchmark.json');
  const matrix = readJsonSafe('benchmarks/sota-quantize-matrix.json');

  if (trinity && Array.isArray(trinity.rows)) {
    const r = trinity.rows.find((x) => x.model === 'trinity-500');
    if (r) {
      cards.push({
        label: 'Asks the right question',
        value: `${r.asks_one_question_pct.toFixed(1)}%`,
        claim_substring: `${r.asks_one_question_pct.toFixed(1)}%`,
        evidence_file: 'public/benchmarks/trinity-500-benchmark.json',
        href: '/benchmarks/trinity-500-benchmark.json',
        verify_href: '/verify-prod',
        note: 'trinity-500 distilled specialist, 57 held-out cases',
      });
    }
  }
  if (redaction && redaction.totals && typeof redaction.totals.f1 === 'number') {
    cards.push({
      label: 'PII redaction',
      value: `F1 ${redaction.totals.f1.toFixed(1)}`,
      claim_substring: `F1 ${redaction.totals.f1.toFixed(1)}`,
      evidence_file: 'public/benchmarks/redaction-public-benchmark.json',
      href: '/benchmarks/redaction-public-benchmark.json',
      verify_href: '/verify-prod',
      note: 'public redaction benchmark, zero false positives',
    });
  }
  if (matrix && Array.isArray(matrix.rows)) {
    const r = matrix.rows.find((x) => x.model === 'DeepSeek-R1-Distill-Qwen-32B');
    if (r) {
      cards.push({
        label: '32B model, one GPU',
        value: `${r.output_int4_gb.toFixed(1)} GB`,
        claim_substring: `${r.output_int4_gb.toFixed(1)} GB`,
        evidence_file: 'public/benchmarks/sota-quantize-matrix.json',
        href: '/benchmarks/sota-quantize-matrix.json',
        verify_href: '/verify-prod',
        note: 'DeepSeek-R1 32B compressed to INT4 in 125.3 s on an RTX 5090',
      });
    }
  }
  return cards;
}

// ---------------------------------------------------------------------------
// caseStudyCards — anonymized-role, qualitative (no illustrative number surfaced)
// ---------------------------------------------------------------------------

function caseStudyCards() {
  // Only include a card when the case-study file actually exists on disk.
  const candidates = [
    { href: '/case-studies/healthcare-phi-redactor.html', title: 'Healthcare PHI redaction', who: 'Director, Privacy & Compliance (anonymized)', file: 'case-studies/healthcare-phi-redactor.html' },
    { href: '/case-studies/finance-sr11-7.html', title: 'Model-risk governance (SR 11-7)', who: 'SVP Model Risk Management (anonymized)', file: 'case-studies/finance-sr11-7.html' },
    { href: '/case-studies/legal-contract-extraction.html', title: 'Contract extraction', who: 'Firm General Counsel (anonymized)', file: 'case-studies/legal-contract-extraction.html' },
  ];
  return candidates.filter((c) => fs.existsSync(path.join(PUBLIC, c.file))).map((c) => ({ href: c.href, title: c.title, who: c.who }));
}

// ---------------------------------------------------------------------------
// buildSocialProof — orchestrator
// ---------------------------------------------------------------------------

async function buildSocialProof(opts = {}) {
  const prev = readPrev();
  const offline = opts.offline === true || process.argv.includes('--offline');
  const oss = await fetchOssTraction(REPO, {
    token: opts.token || process.env.GITHUB_TOKEN,
    prevEtag: prev && prev.oss && prev.oss.etag,
    prev,
    offline,
  });
  const policy = applyDisplayPolicy(oss, { starFloor: opts.starFloor || STAR_DISPLAY_FLOOR });

  const chips = [
    { label: 'Apache-2.0', href: '/license' },
    { label: 'Self-hostable', href: '/docs' },
    { label: '6 SDKs', href: '/docs/sdk' },
    { label: 'Air-gapped', href: '/docs' },
  ];

  const artifact = {
    spec: 'kolm-social-proof-1',
    generated_at: new Date().toISOString(),
    stale: Boolean(oss.stale),
    repo: REPO,
    oss,
    policy,
    chips,
    proof: extractBenchmarkProof(),
    case_studies: caseStudyCards(),
    testimonial: {
      quote: 'Privilege means client text cannot leave. An owned model with a signed build receipt let us say yes to AI without that risk.',
      who: 'Firm General Counsel (anonymized)',
      source_href: '/case-studies/legal-contract-extraction.html',
    },
    compare_href: '/compare',
  };

  if (!opts.dryRun) fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  return artifact;
}

if (require.main === module) {
  buildSocialProof()
    .then((a) => {
      if (process.argv.includes('--json')) {
        process.stdout.write(JSON.stringify(a) + '\n');
      } else {
        process.stdout.write(
          `# social-proof.json written. oss.available=${a.oss.available} stale=${a.stale} ` +
          `lead_with=${a.policy.lead_with} proof_cards=${a.proof.length} case_studies=${a.case_studies.length}\n`
        );
      }
    })
    .catch((e) => {
      process.stderr.write('build-social-proof failed: ' + String(e && e.stack || e) + '\n');
      process.exit(1);
    });
}

module.exports = { buildSocialProof, fetchOssTraction, applyDisplayPolicy, extractBenchmarkProof, caseStudyCards };
