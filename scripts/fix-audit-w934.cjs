#!/usr/bin/env node
/* W934 — apply the audit MUST-FIX / SHOULD-POLISH items (product + site).
 * Idempotent string replacements. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let total = 0;
function patch(rel, pairs, label) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) { console.log('  MISS', rel); return; }
  let s = fs.readFileSync(f, 'utf8'); const before = s; let n = 0;
  for (const [a, b, opts] of pairs) {
    if (opts && opts.regex) { const m = s.match(a); if (m) { n += m.length; s = s.replace(a, b); } }
    else if (s.includes(a)) { const c = s.split(a).length - 1; n += c; s = s.split(a).join(b); }
    else console.log('     nofind:', String(a).slice(0, 55));
  }
  if (s !== before) { fs.writeFileSync(f, s); total += n; console.log(`  [${label}] ${rel} (${n})`); }
}

// ---- CLI (cli/kolm.js) ----
patch('cli/kolm.js', [
  // 1) root tagline -> AI Compiler positioning
  ['kolm v${VERSION} - the AI control plane for owned models, signed runtimes, and enterprise evidence.',
   'kolm v${VERSION} - the AI compiler. Distill frontier quality into a small, private model you run anywhere, with a signed receipt on every call.'],
  // 2) wrapper verb (homepage-advertised alias for gateway boot)
  ["      case 'gateway':    await withErrorContext('gateway',    () => cmdW742Gateway(rest)); break;",
   "      case 'gateway':    await withErrorContext('gateway',    () => cmdW742Gateway(rest)); break;\n" +
   "      // `kolm wrapper up` — homepage-advertised alias that boots the gateway (the\n" +
   "      // \"wrapper\" is the gateway in product terms). `up` maps to gateway `start`.\n" +
   "      case 'wrapper':    await withErrorContext('wrapper',    () => cmdW742Gateway(rest[0] === 'up' ? ['start', ...rest.slice(1)] : rest)); break;"],
  // 3) strip internal [W###] wave tags from user-facing --help
  [/ +\[W\d+[a-z]?\]/g, '', { regex: true }],
  // 4) TUI :run — execute the LOCAL artifact via the local runner (server can't see local paths)
  ["        const out = await api(c, 'POST', '/v1/run/inline', { artifact: sel.path, input: arg });",
   "        const { runArtifact } = await import('../src/artifact-runner.js');\n        const out = await runArtifact(sel.path, arg, {});"],
  // 5) phantom /v1/run/inline references -> reflect reality (local run / real route)
  ['inference against the loaded artifact (uses /v1/run/inline)',
   'inference against the loaded artifact (runs locally)'],
  ["printRestEquivalent('POST', '/v1/run/inline', { artifact: path.basename(ap), input });",
   "printRestEquivalent('POST', '/v1/run', { version_id: '<your-version-id>', input });"],
], 'cli');

// ---- SDK READMEs: banned word + key-prefix correctness ----
patch('sdk/python/README.md', [
  ['## Honest envelope', '## Status envelope'],
  ['k_live_...', 'ks_...'],
], 'sdk-python');
patch('sdk/rust/README.md', [
  ['## Honesty contract', '## Failure-mode contract'],
  ['KOLM_API_KEY=sk-...', 'KOLM_API_KEY=ks_...'],
], 'sdk-rust');
patch('sdk/c/README.md', [
  ['## Honesty contract', '## Failure-mode contract'],
  ['KOLM_API_KEY=sk-...', 'KOLM_API_KEY=ks_...'],
], 'sdk-c');

// ---- docs.html landing: cobalt accent cohesion (accent-roles + labels; NOT body text) ----
patch('public/docs.html', [
  [/#1f2937/g, 'var(--ks-accent)', { regex: true }],          // accent-roles + uppercase mono labels
  [/#9aa6b8/g, 'var(--ks-accent)', { regex: true }],          // dark-mode accent-roles
  ['background: #111111; color: #f3f5f7', 'background: var(--ks-accent); color: #fff'], // primary CTA only
], 'docs-landing');

console.log(`\nW934 fix: ${total} edits.`);
