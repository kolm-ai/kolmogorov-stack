#!/usr/bin/env node
/**
 * Sweep every HTML page in /public and replace the existing site footer with
 * the canonical SOTA 5-column footer. Idempotent (compares before/after).
 *
 * Matches either:
 *   <footer class="site-footer"> ... </footer>
 *   <footer class="site"> ... </footer>
 *
 * Skips files that have no <footer> block or have a non-marketing footer
 * (signup/dashboard/etc may not have one).
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const CANONICAL = `<footer class="site-footer">
  <div class="wrap">
    <div class="meta">
      kolm v0.1.0 / MIT SDK / <a href="https://github.com/kolm-ai/kolmogorov-stack">github</a> / <a href="/status">status</a>
    </div>
    <div class="links">
      <div>
        <div class="col-h">build</div>
        <a href="/capture">capture</a>
        <a href="/compile">compile</a>
        <a href="/run">run</a>
        <a href="/recall">recall</a>
        <a href="/evolve">evolve</a>
      </div>
      <div>
        <div class="col-h">deploy</div>
        <a href="/teams">teams</a>
        <a href="/tunnels">remote access</a>
        <a href="/byoc">byoc cloud</a>
        <a href="/airgap">airgap</a>
        <a href="/enterprise">enterprise</a>
      </div>
      <div>
        <div class="col-h">proof</div>
        <a href="/benchmarks">benchmarks</a>
        <a href="/research">research</a>
        <a href="/k-score">k-score</a>
        <a href="/leaderboard">registry</a>
        <a href="/spec">rs-1 spec</a>
      </div>
      <div>
        <div class="col-h">industries</div>
        <a href="/healthcare">healthcare</a>
        <a href="/finance">finance</a>
        <a href="/legal">legal</a>
        <a href="/edge">edge</a>
        <a href="/cookbook">cookbook</a>
      </div>
      <div>
        <div class="col-h">company</div>
        <a href="/pricing">pricing</a>
        <a href="/docs">docs</a>
        <a href="/roadmap">roadmap</a>
        <a href="/manifesto">manifesto</a>
        <a href="/roi">roi</a>
      </div>
    </div>
    <small class="footer-tag">
      <a href="/trust">trust</a> &middot; <a href="/security">security</a> &middot; <a href="/privacy">privacy</a> &middot; <a href="/terms">terms</a> &middot; <a href="/faq">faq</a> &middot; <a href="https://github.com/kolm-ai/kolmogorov-stack">github</a> &middot; kolm.ai &middot; MIT licensed runtime
    </small>
  </div>
</footer>`;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (extname(entry) === '.html') out.push(p);
  }
  return out;
}

const FOOTER_RE = /<footer class="site(?:-footer)?"[\s\S]*?<\/footer>/;

let touched = 0, skipped = 0, noFooter = 0;
const files = walk(ROOT);
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  if (!FOOTER_RE.test(before)) { noFooter++; continue; }
  const after = before.replace(FOOTER_RE, CANONICAL);
  if (after === before) { skipped++; continue; }
  writeFileSync(file, after);
  touched++;
}
console.log(`fix-footer: touched=${touched} skipped=${skipped} no-footer=${noFooter} total=${files.length}`);
