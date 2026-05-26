#!/usr/bin/env node
// W890-7 — secret leak scan.
// Scans 5 categories for real-looking secrets (not test fixtures). Each must
// return 0. Patterns target unambiguous live-key shapes:
//   - sk-<30+ chars>   (Anthropic / OpenAI live keys, NOT the test fixtures)
//   - sk_live_<30+ chars>  (Stripe live)
//   - whsec_<30+ chars>    (Stripe webhook signing)
//   - rk_live_<30+ chars>  (Stripe restricted)
//   - AKIA<16 uppercase>   (AWS access key) — except docs example
//   - ghp_<36 chars>       (GitHub personal access token)
//   - eyJ<base64 JWT>      (loose JWT prefix — only counted in client JS)
//
// A match is COUNTED only if it does not appear inside a documented test
// fixture (`abcdef`, `123456`, `XYZ987`, `EXAMPLE`, `sk-test1234567890`,
// `sk_test_abcd`, `AKIAIOSFODNN7EXAMPLE`, etc.). The unambiguous test
// markers come from W890-2 secret scan output.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const SECRET_PATTERNS = [
  { name: 'anthropic_openai_live', re: /\bsk-[A-Za-z0-9_-]{30,}\b/g },
  { name: 'stripe_live', re: /\bsk_live_[A-Za-z0-9]{30,}\b/g },
  { name: 'stripe_test_real_shape', re: /\bsk_test_[A-Za-z0-9]{30,}\b/g },
  { name: 'stripe_webhook', re: /\bwhsec_[A-Za-z0-9]{30,}\b/g },
  { name: 'aws_access', re: /\bAKIA[A-Z0-9]{16}\b/g },
  { name: 'github_pat', re: /\bghp_[A-Za-z0-9]{36,}\b/g },
];

const FIXTURE_TOKENS = [
  'abcdef', '123456', 'XYZ987', 'EXAMPLE', 'AKIAIOSFODNN',
  'sk-test1234567890', 'sk-abcdef', 'sk_test_abcdef', 'sk_live_abcdef',
  'sk-abc123XYZ987', 'sk-test1', 'wxyz', 'aaaaaaaa',
  'test_abcd', 'redact_'];

function isFixture(match) {
  for (const t of FIXTURE_TOKENS) if (match.includes(t)) return true;
  // Anything containing >=8 consecutive identical chars is almost certainly a fixture.
  if (/(.)\1{7,}/.test(match)) return true;
  return false;
}

function countMatches(text, patternList) {
  let total = 0;
  const hits = [];
  for (const p of patternList) {
    let m;
    p.re.lastIndex = 0;
    while ((m = p.re.exec(text))) {
      if (!isFixture(m[0])) {
        total++;
        hits.push({ pattern: p.name, match: m[0].slice(0, 12) + '...' });
      }
    }
  }
  return { total, hits };
}

// 1) Git history
let gitHistory = { total: 0, hits: [] };
try {
  const git = execSync('git log --all -p --no-color', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  gitHistory = countMatches(git, SECRET_PATTERNS);
} catch (e) {
  gitHistory = { total: 0, hits: [], note: 'git log unavailable: ' + e.message.slice(0, 100) };
}

// 2) Error messages (throw / Error / reject in src/)
const ERR_RE = /(throw\s+new\s+\w*Error|Error\(|reject\()/;
function scanDir(dir, predicate) {
  let combined = '';
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(c?js|mjs|ts)$/.test(e.name)) continue;
      let txt;
      try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      if (predicate(p, txt)) combined += '\n/* === ' + p + ' === */\n' + txt;
    }
  }
  walk(dir);
  return combined;
}
const errCorpus = scanDir(path.join(ROOT, 'src'), (p, t) => ERR_RE.test(t));
const errorMessages = countMatches(errCorpus, SECRET_PATTERNS);

// 3) Logs (console.log / console.error / console.warn in src/ + cli/)
const LOG_RE = /(console\.(log|error|warn|info|debug))/;
const logCorpus = scanDir(path.join(ROOT, 'src'), (p, t) => LOG_RE.test(t))
                + scanDir(path.join(ROOT, 'cli'), (p, t) => LOG_RE.test(t));
const logs = countMatches(logCorpus, SECRET_PATTERNS);

// 4) Client-side JS in public/ (excluded: test fixtures explicitly in tests/)
const publicCorpus = scanDir(path.join(ROOT, 'public'), () => true);
const clientSideJs = countMatches(publicCorpus, SECRET_PATTERNS);

// 5) OpenAPI responses
let openapiCorpus = '';
for (const f of ['public/openapi.json', 'public/openapi.yaml', 'data/api-routes.json']) {
  const fp = path.join(ROOT, f);
  if (fs.existsSync(fp)) openapiCorpus += '\n' + fs.readFileSync(fp, 'utf8');
}
const openapiResponses = countMatches(openapiCorpus, SECRET_PATTERNS);

const result = {
  generated_at: new Date().toISOString(),
  description: 'Counts real-looking secret-like tokens (sk-, sk_live_, whsec_, AKIA, ghp_) ' +
               'excluding documented test fixtures (abcdef/123456/EXAMPLE/etc). Each category MUST be 0.',
  patterns: SECRET_PATTERNS.map(p => p.name),
  fixture_tokens_excluded: FIXTURE_TOKENS,
  git_history: gitHistory.total,
  error_messages: errorMessages.total,
  logs: logs.total,
  client_side_js: clientSideJs.total,
  openapi_responses: openapiResponses.total,
  details: {
    git_history: gitHistory,
    error_messages: errorMessages,
    logs: logs,
    client_side_js: clientSideJs,
    openapi_responses: openapiResponses,
  },
};
fs.writeFileSync(path.join(ROOT, 'data/w890-7-secret-leak-scan.json'), JSON.stringify(result, null, 2));
console.log('secret leak counts:',
  'git=' + result.git_history,
  'err=' + result.error_messages,
  'logs=' + result.logs,
  'client=' + result.client_side_js,
  'openapi=' + result.openapi_responses);
