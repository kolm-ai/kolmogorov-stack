#!/usr/bin/env node
/* warm-paper-injection.cjs — 2026-05-24
 *
 * One-shot transform of public/**\/*.html so the new Warm Paper aesthetic
 * (sienna on paper, light default, opt-in warm-dark) cascades through every
 * page consistently.
 *
 * For each HTML file under public/:
 *   1. Strip the hardcoded `data-theme="dark"` attribute on <html>
 *      (pages now default to light; the toggle is the only path to dark).
 *   2. Strip any inline `style="background:#07090c;color-scheme:dark"`
 *      (and similar dark-bg inline styles) off the <html> tag.
 *   3. Rewrite `<meta name="theme-color" content="#0a0a0c">` (or any other
 *      dark hex) to a paper-aware media-query pair.
 *   4. Inject `<link rel="stylesheet" href="/warm-paper.css">` immediately
 *      after the last existing <link rel="stylesheet"> so it wins the
 *      cascade.  Idempotent — skips files that already have it.
 *
 * The transform is structural and additive; no DOM elements are removed
 * other than the dark-default attributes above.  Tests that pin layout,
 * nav, hidden anchors, etc., remain unaffected.
 *
 * Usage:
 *   node scripts/warm-paper-injection.cjs
 *   node scripts/warm-paper-injection.cjs --dry-run
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'public');
const DRY = process.argv.includes('--dry-run');

const STYLESHEET_HREF = '/warm-paper.css';
const STYLESHEET_TAG  = `<link rel="stylesheet" href="${STYLESHEET_HREF}">`;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function transform(html) {
  let changed = false;
  let out = html;

  /* 1. Strip data-theme="dark" / data-theme='dark' on <html ...> */
  out = out.replace(/(<html\b[^>]*?)\s+data-theme=(?:"dark"|'dark')/i, (m, pre) => {
    changed = true;
    return pre;
  });

  /* 2. Strip inline style on <html ...> when it pins a dark background or color-scheme. */
  out = out.replace(/(<html\b[^>]*?)\s+style="([^"]*?)"/i, (m, pre, styleVal) => {
    const cleaned = styleVal
      .split(';')
      .map(s => s.trim())
      .filter(s => {
        if (!s) return false;
        const low = s.toLowerCase().replace(/\s+/g, '');
        if (low.startsWith('background:')) {
          if (/^background:(#0[0-9a-f]{5,6}|#000|black|rgba?\(0,0,0)/i.test(low)) return false;
        }
        if (low.startsWith('color-scheme:dark')) return false;
        if (low.startsWith('color:#7ef0d2') || low.startsWith('color:#faf2e1')) return false;
        return true;
      })
      .join(';');
    if (cleaned === styleVal.trim()) return m;
    changed = true;
    if (!cleaned) return pre;
    return `${pre} style="${cleaned}"`;
  });

  /* 3. Rewrite meta theme-color so all variants land on the Warm Paper pair.
   *    Three cases handled:
   *      - Single tag, any color: replace with paired Warm Paper pair.
   *      - Already paired (light): normalize hex to #faf9f7.
   *      - Already paired (dark):  normalize hex to #121211.
   *    Idempotent — re-running on a Warm Paper page is a no-op.
   */
  out = out.replace(/<meta\s+name=["']theme-color["'][^>]*>/gi, (tag) => {
    if (/media=/i.test(tag)) {
      /* Paired tag — just normalize the hex. */
      if (/prefers-color-scheme:\s*light/i.test(tag)) {
        const normalized = tag.replace(/content=(["'])#[0-9a-f]{3,8}\1/i, 'content="#faf9f7"');
        if (normalized !== tag) changed = true;
        return normalized;
      }
      if (/prefers-color-scheme:\s*dark/i.test(tag)) {
        const normalized = tag.replace(/content=(["'])#[0-9a-f]{3,8}\1/i, 'content="#121211"');
        if (normalized !== tag) changed = true;
        return normalized;
      }
      return tag;
    }
    /* Replace single tag with light+dark pair. */
    changed = true;
    return (
      '<meta name="theme-color" content="#faf9f7" media="(prefers-color-scheme: light)">\n'
      + '    <meta name="theme-color" content="#121211" media="(prefers-color-scheme: dark)">'
    );
  });

  /* 4. Inject warm-paper.css link (idempotent). */
  if (!out.includes(STYLESHEET_HREF)) {
    /* Place after the last existing <link rel="stylesheet"> in <head>, or right before </head> as fallback. */
    const stylesheetRe = /<link\s+rel=["']stylesheet["'][^>]*>/gi;
    const matches = [...out.matchAll(stylesheetRe)];
    if (matches.length) {
      const last = matches[matches.length - 1];
      const insertAt = last.index + last[0].length;
      out = out.slice(0, insertAt) + '\n    ' + STYLESHEET_TAG + out.slice(insertAt);
      changed = true;
    } else if (/<\/head>/i.test(out)) {
      out = out.replace(/<\/head>/i, '    ' + STYLESHEET_TAG + '\n  </head>');
      changed = true;
    }
  }

  return { out, changed };
}

function main() {
  const files = walk(ROOT);
  let touched = 0;
  let skipped = 0;
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8');
    const { out, changed } = transform(html);
    if (changed) {
      if (!DRY) fs.writeFileSync(f, out, 'utf8');
      touched++;
    } else {
      skipped++;
    }
  }
  const verb = DRY ? '[dry-run] would update' : 'updated';
  console.log(`warm-paper-injection: ${verb} ${touched} files (skipped ${skipped} already-clean).`);
}

main();
