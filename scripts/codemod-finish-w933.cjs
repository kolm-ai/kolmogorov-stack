#!/usr/bin/env node
/* W933 finish codemod — applies the per-family copy-review fix specs (task wesqgr81u).
 * Idempotent, token-level. Patches BOTH built public/ files AND generator sources so a
 * future regeneration matches the deployed artifact (no revert hazard, no regeneration needed).
 *
 * Scope discipline:
 *  - ACCENT cobalt standardization: ONLY the public MARKETING families (cookbook/blog/compile/
 *    docs/marketplace/research) + their generators. NOT account/* or articles/* (monochrome
 *    by design, heavy test-coupling).
 *  - FOOTER tagline + banned-word "honest" (api spec) + jargon + verbose rewrites + CTA bake-ins.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let totalEdits = 0;
const log = [];
function read(f){ return fs.readFileSync(f, 'utf8'); }
function write(f, s){ fs.writeFileSync(f, s); }

// recursive walk
function walk(dir, filter) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

// apply an array of [find, replace] (string) to a file; returns #pairs applied
function applyPairs(file, pairs, label) {
  if (!fs.existsSync(file)) return 0;
  let s = read(file);
  const before = s;
  let n = 0;
  for (const [find, repl] of pairs) {
    if (s.includes(find)) {
      const parts = s.split(find);
      n += parts.length - 1;
      s = parts.join(repl);
    }
  }
  if (s !== before) { write(file, s); totalEdits += n; log.push(`  [${label}] ${path.relative(ROOT, file)} (${n})`); }
  return n;
}

// ---------------------------------------------------------------------------
// 1) ACCENT cobalt standardization (marketing families only)
// ---------------------------------------------------------------------------
const ACCENT_PAIRS = [
  ['--accent:#1f2937', '--accent:#2563eb'],
  ['--accent: #1f2937', '--accent: #2563eb'],
  ['--accent:#a8b3c2', '--accent:#6f9bff'],
  ['--accent: #a8b3c2', '--accent: #6f9bff'],
  ['--accent:#cbd5e1', '--accent:#6f9bff'],
  ['--accent: #cbd5e1', '--accent: #6f9bff'],
  ['--accent:#e6e9ee', '--accent:#6f9bff'],
  ['--accent: #e6e9ee', '--accent: #6f9bff'],
  ['--accent:#111111', '--accent:#6f9bff'],
  ['--accent: #111111', '--accent: #6f9bff'],
  // teal/green accent-soft -> cobalt soft
  ['rgba(5,150,105,0.10)', 'rgba(37,99,235,0.10)'],
  ['rgba(17,17,17,0.10)', 'rgba(37,99,235,0.10)'],
  ['rgba(31,41,55,0.06)', 'rgba(37,99,235,0.08)'],
  // marketplace badge/cta green borders -> cobalt
  ['rgba(16,185,129,.4)', 'rgba(37,99,235,.4)'],
  ['rgba(16,185,129,.55)', 'rgba(37,99,235,.5)'],
  ['rgba(16,185,129,.06)', 'rgba(37,99,235,.06)'],
  ['rgba(16,185,129,.08)', 'rgba(37,99,235,.08)'],
];

// marketing built files
const accentTargets = [
  path.join(PUB, 'cookbook', '_recipe.css'),
  path.join(PUB, 'research.html'),
  ...walk(path.join(PUB, 'blog'), p => p.endsWith('.html')),
  ...walk(path.join(PUB, 'compile'), p => p.endsWith('.html')),
  ...walk(path.join(PUB, 'docs'), p => p.endsWith('.html')),
  ...walk(path.join(PUB, 'marketplace'), p => p.endsWith('.html')),
];
// generator sources (so future builds match)
const accentGenerators = [
  'build-seo-pages.cjs', 'build-docs-w374.cjs', 'wave887-docs-generator.cjs',
  'build-marketplace-pages.cjs', 'build-comparison-seo.cjs',
].map(f => path.join(ROOT, 'scripts', f));

log.push('== 1) ACCENT cobalt (marketing families + generators) ==');
for (const f of [...accentTargets, ...accentGenerators]) applyPairs(f, ACCENT_PAIRS, 'accent');

// cookbook header CTA: black -> cobalt
applyPairs(path.join(PUB, 'cookbook', '_recipe.css'),
  [['header.site .right .cta { color: var(--bg); background: var(--ink);',
    'header.site .right .cta { color: #fff; background: var(--accent);']], 'cookbook-cta');

// ---------------------------------------------------------------------------
// 2) FOOTER tagline consistency
// ---------------------------------------------------------------------------
log.push('== 2) FOOTER tagline ==');
const FOOTER_PAIRS = [
  ['Own your AI.', 'Own your AI.'],
];
const allHtml = walk(PUB, p => p.endsWith('.html'));
const genScripts = walk(path.join(ROOT, 'scripts'), p => p.endsWith('.cjs') || p.endsWith('.mjs') || p.endsWith('.js'));
for (const f of [...allHtml, ...genScripts]) applyPairs(f, FOOTER_PAIRS, 'footer');

// ---------------------------------------------------------------------------
// 3) BANNED WORD "honest" in API-reference spec/prose (NOT code identifiers)
// ---------------------------------------------------------------------------
log.push('== 3) banned-word honest (api spec prose) ==');
const HONEST_PAIRS = [
  ['honest envelopes', 'structured envelopes'],
  ['honest envelope', 'structured envelope'],
  ['honest invalid_transition', 'structured invalid_transition'],
  ['honest 501', 'structured 501'],
  ['an honest error', 'a structured error'],
  ['honest error envelope', 'structured error envelope'],
];
for (const f of ['api.html', 'openapi.json', 'docs/api.html', 'docs/api-routes.json'].map(x => path.join(PUB, x)))
  applyPairs(f, HONEST_PAIRS, 'honest');

// ---------------------------------------------------------------------------
// 4) JARGON residuals (visible "surface"/"wrapper"/"studio") — audit per-family
// ---------------------------------------------------------------------------
log.push('== 4) jargon residuals ==');
// integrations
for (const f of walk(path.join(PUB, 'integrations'), p => p.endsWith('.html'))) {
  applyPairs(f, [
    ['surface a kolm artifact', 'run a kolm artifact'],
    ['MCP tool surface', 'MCP tools'],
    ['the MCP surface itself', 'MCP tools'],
    ['Same surface.', 'Same API.'],
    ['Same SDK. Same surface. New compiler underneath.', 'Your SDK, same API, new compiler underneath.'],
  ], 'jargon-integrations');
}
// research
applyPairs(path.join(PUB, 'research.html'), [
  ['wire through the same speculative_config surface', 'both accessible via the same speculative_config option'],
  ['the CLI surface, and which tier', 'the CLI, and which tier'],
], 'jargon-research');
// cookbook
for (const f of walk(path.join(PUB, 'cookbook'), p => p.endsWith('.html'))) {
  applyPairs(f, [
    ['Recompile with the offending pairs surfaced as hard negatives', 'Recompile with the offending pairs marked to drop from training'],
    ['ops surface for redis is harder than sqs', 'redis operations are harder than sqs'],
  ], 'jargon-cookbook');
}
// studio
for (const f of walk(path.join(PUB, 'studio'), p => p.endsWith('.html'))) {
  applyPairs(f, [
    ['this is the browser studio', 'this is the browser compiler'],
    ['Same data the CLI surfaces with', 'Same data the CLI exposes via'],
    ['the TUI surfaces under key W', 'the TUI shows under key W'],
  ], 'jargon-studio');
}
// compile generator + built
const compilePairs = [
  ['the <a href="/wrapper">gateway</a>', 'the <a href="/gateway">gateway</a>'],
  ['the gateway</a> that produces', 'gateway</a> that produces'],
];
applyPairs(path.join(ROOT, 'scripts', 'build-seo-pages.cjs'), compilePairs, 'jargon-compile-gen');
for (const f of walk(path.join(PUB, 'compile'), p => p.endsWith('.html'))) applyPairs(f, compilePairs, 'jargon-compile');
// marketplace
const mktPairs = [['inference wrappers', 'runtime libraries']];
applyPairs(path.join(ROOT, 'scripts', 'build-marketplace-pages.cjs'), mktPairs, 'jargon-mkt-gen');
for (const f of walk(path.join(PUB, 'marketplace'), p => p.endsWith('.html'))) applyPairs(f, mktPairs, 'jargon-mkt');

// ---------------------------------------------------------------------------
// 5) VERBOSE -> CONCISE rewrites (specific, where present)
// ---------------------------------------------------------------------------
log.push('== 5) verbose->concise ==');
const VERBOSE = [
  // studio
  [path.join(PUB, 'studio', 'compile-status.html'),
   'Same data the CLI surfaces with kolm compile list and the TUI surfaces under key W; this is the browser studio.',
   'Same data the CLI and TUI expose.'],
  // compare spine
  [path.join(PUB, 'compare.html'),
   'Run the same eval pack on your incumbent and on kolm. Compare K-scores.',
   'Run the same eval pack on both. Compare K-scores.'],
  [path.join(PUB, 'compare.html'),
   'The direct test. We help you write the eval pack, score your existing artifact, score a kolm-compiled artifact on the same cases. Pick the better K. We have been wrong before.',
   'The direct test: score your incumbent and a kolm-compiled artifact on the same cases. Pick the better K.'],
  [path.join(PUB, 'compare.html'), 'Neither tool is strictly better; they solve different problems.', 'Each solves a different problem.'],
];
for (const [f, from, to] of VERBOSE) applyPairs(f, [[from, to]], 'verbose');

console.log(log.join('\n'));
console.log(`\nW933 codemod: ${totalEdits} edits across ${log.filter(l=>l.startsWith('  ')).length} files.`);
