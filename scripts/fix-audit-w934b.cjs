#!/usr/bin/env node
/* W934b — API-ref wave-tag scrub + CLI verb discoverability. Idempotent. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TAG = /W\d+[a-z]?(?:-[A-Z0-9]+)?/; // a wave tag token
let total = 0;

// 1) build-api-ref generator: strip a leading wave tag from each harvested comment line
{
  const f = path.join(ROOT, 'scripts', 'build-api-ref.cjs');
  let s = fs.readFileSync(f, 'utf8');
  const anchor = "const content = trimmed.replace(/^\\/\\/+\\s?/, '');";
  if (s.includes(anchor) && !s.includes('// W934b: strip leading wave tag')) {
    s = s.replace(anchor,
      anchor + "\n      // W934b: strip leading internal wave tag (e.g. \"W888-D \") from public API descriptions\n" +
      "      const cleaned = content.replace(/^W\\d+[a-z]?(?:-[A-Z0-9]+)?[\\s:.\\-]+/, '') || content;");
    // use the cleaned value when pushing
    s = s.replace('collected.unshift(content);', 'collected.unshift(cleaned);');
    fs.writeFileSync(f, s); total++; console.log('  [gen] build-api-ref.cjs harvestComments patched');
  } else console.log('  [gen] build-api-ref already patched or anchor missing');
}

// 2) scrub built API-reference artifacts (deploy surface)
function scrubHtml(rel) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return;
  let s = fs.readFileSync(f, 'utf8'); const b = s;
  // description text after a tag-opening '>' , and title="..." attributes
  s = s.replace(/>(\s*)W\d+[a-z]?(?:-[A-Z0-9]+)?[ :.\-]+/g, '>$1');
  s = s.replace(/title="W\d+[a-z]?(?:-[A-Z0-9]+)?[ :.\-]+/g, 'title="');
  if (s !== b) { fs.writeFileSync(f, s); total++; console.log('  [scrub]', rel); }
}
function scrubJson(rel) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return;
  let s = fs.readFileSync(f, 'utf8'); const b = s;
  s = s.replace(/("(?:description|summary)":\s*")W\d+[a-z]?(?:-[A-Z0-9]+)?[ :.\-]+/g, '$1');
  if (s !== b) {
    try { JSON.parse(s); } catch (e) { console.log('  [scrub] ABORT', rel, '— would break JSON:', e.message); return; }
    fs.writeFileSync(f, s); total++; console.log('  [scrub]', rel);
  }
}
scrubHtml('public/docs/api.html');
scrubHtml('public/api.html');
scrubJson('public/openapi.json');
scrubJson('public/docs/api-routes.json');

// 3) CLI verb discoverability: add product-line front-door verbs to COMPLETION_VERBS + help
{
  const f = path.join(ROOT, 'cli', 'kolm.js');
  let s = fs.readFileSync(f, 'utf8'); const b = s;
  if (!s.includes("'gateway', 'studio', 'forge', 'deploy', 'wrapper'")) {
    s = s.replace("  'surfaces',",
      "  'surfaces', 'gateway', 'studio', 'forge', 'deploy', 'wrapper', 'teacher', 'bundle', 'receipts', 'receipt',");
  }
  // help COMMANDS — insert product-line front doors after the `surfaces` help row
  const helpAnchor = "  surfaces                         product journey map across account, CLI, TUI, API, cloud, privacy, and proof (--json)";
  if (s.includes(helpAnchor) && !s.includes("  gateway <sub>                    OpenAI-compatible gateway")) {
    s = s.replace(helpAnchor, helpAnchor +
      "\n  gateway <sub>                    OpenAI-compatible gateway (start|health|providers|routes|status|call)" +
      "\n  wrapper up                       alias for `gateway start` (boot the capture gateway)" +
      "\n  studio <sub>                     browser compiler UI (open|status|list|sessions|recipes)" +
      "\n  forge <sub>                      compile + distill engine (status|run)" +
      "\n  deploy <sub>                     HTTP control plane for hosted artifacts (list|create|status)");
  }
  if (s !== b) { fs.writeFileSync(f, s); total++; console.log('  [cli] COMPLETION_VERBS + help verbs added'); }
}

console.log(`\nW934b: ${total} files changed.`);
