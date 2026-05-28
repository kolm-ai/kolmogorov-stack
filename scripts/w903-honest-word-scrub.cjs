#!/usr/bin/env node
// W903 — scrub the words "honest", "honesty", "honestly" from public/**/*.html
// prose per the standing memory directive ("i hope you dont use the word
// honesty anywhere"). User mandate 2026-05-27: "review all copy, get us
// polished to go live".
//
// Approach: phrase-level substitutions instead of a blanket word replace,
// because:
//   . engineering vocabulary needs context-appropriate substitutes
//     (e.g. "honest envelope" → "loud-fail envelope" — the engineering
//      pattern is "never silent passthrough"; "loud" captures that)
//   . the K-Score axis named "honesty" appears in JSON examples and table
//     rows; that is a schema name with downstream API consumers, so we
//     scope-limit replacements to prose form (Capital-H Honesty etc.) and
//     skip the bare lowercase JSON keys.
//
// Safety:
//   . skip <code>...</code> and <pre>...</pre> blocks entirely so JSON /
//     CLI snippets and example output stay intact
//   . skip class=, id=, data-* attribute payloads so CSS hooks don't break
//   . skip the JSON property "honesty": <number> shape
//
// After this pass, run the grep again; any stragglers get a manual edit.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'public');

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith('.html')) out.push(p);
  }
  return out;
}

// Ordered phrase substitutions. Each entry: [regex, replacement].
// IMPORTANT: regex order matters — longer / more-specific phrases first
// so they win over shorter overlapping ones.
const SUBS = [
  // Compound phrases (longest first)
  [/\bhonest[- ]envelopes by default\b/gi, 'loud-fail envelopes by default'],
  [/\bhonest-by-default\b/gi, 'loud-fail-by-default'],
  [/\bhonest by default\b/gi, 'loud-fail by default'],
  [/\bhonest-scope\b/g, 'plain-scope'],

  // "Honesty contract" / lowercase — engineering pattern name
  [/\bHonesty contract\b/g, 'No-silent-pass contract'],
  [/\bhonesty contract\b/g, 'no-silent-pass contract'],
  [/\bHonesty pact\b/g, 'No-silent-pass pact'],
  [/\bhonesty pact\b/g, 'no-silent-pass pact'],

  // "Honest envelope(s)"
  [/\bHonest envelopes\b/g, 'Loud-fail envelopes'],
  [/\bhonest envelopes\b/g, 'loud-fail envelopes'],
  [/\bHonest envelope\b/g, 'Loud-fail envelope'],
  [/\bhonest envelope\b/g, 'loud-fail envelope'],
  [/\bHONEST EVIDENCE\b/g, 'REAL EVIDENCE'],

  // "Honest fail(s)" — engineering for loud failure
  [/\bHonest fails\b/g, 'Loud fails'],
  [/\bhonest fails\b/g, 'loud fails'],
  [/\bHonest fail\b/g, 'Loud fail'],
  [/\bhonest fail\b/g, 'loud fail'],
  [/\bhonest-empty\b/g, 'loud-empty'],
  [/\bHonest-empty\b/g, 'Loud-empty'],
  [/\bhonest-labeled\b/g, 'plain-labeled'],

  // Methodology / scope / record
  [/\bMethodology, honestly\b/g, 'Methodology, plainly'],
  [/\bHonest scope\b/g, 'Plain scope'],
  [/\bhonest scope\b/g, 'plain scope'],
  [/\bHonest record\b/g, 'Public record'],
  [/\bhonest record\b/g, 'public record'],
  [/\bhonest-record\b/g, 'public-record'],
  [/\bHonest-record\b/g, 'Public-record'],
  [/\bHonest defaults\b/g, 'Loud-fail defaults'],
  [/\bhonest defaults\b/g, 'loud-fail defaults'],

  // Q & A
  [/\bHonest questions\b/g, 'Real questions'],
  [/\bhonest questions\b/g, 'real questions'],
  [/\bHonest question\b/g, 'Real question'],
  [/\bhonest question\b/g, 'real question'],
  [/\bHonest answers\b/g, 'Direct answers'],
  [/\bhonest answers\b/g, 'direct answers'],
  [/\bHonest answer\b/g, 'Direct answer'],
  [/\bhonest answer\b/g, 'direct answer'],

  // "Honest action / version / single-task / pre-ship / record / about"
  [/\bHonest action\b/g, 'Plain action'],
  [/\bhonest action\b/g, 'plain action'],
  [/\bHonest version\b/g, 'Plain version'],
  [/\bhonest version\b/g, 'plain version'],
  [/\bHonest single-task\b/g, 'Plain single-task'],
  [/\bhonest single-task\b/g, 'plain single-task'],
  [/\bHonest pre-ship\b/g, 'Plain pre-ship'],
  [/\bhonest pre-ship\b/g, 'plain pre-ship'],
  [/\bHonest about today\b/g, 'Plain about today'],
  [/\bhonest about today\b/g, 'plain about today'],
  [/\bopen and honest\b/g, 'open and plain'],

  // "Honesty note" — section title
  [/\bHonesty note\b/g, 'Caveats note'],
  [/\bhonesty note\b/g, 'caveats note'],
  [/\bHonesty\s*&middot;\s*queued\b/g, 'Caveats &middot; queued'],
  [/\bHonesty&nbsp;&middot;\s*queued\b/g, 'Caveats&nbsp;&middot; queued'],

  // Adverbs / standalone
  [/\bHonestly,\s*/g, 'Frankly, '],
  [/\bhonestly,\s*/g, 'frankly, '],
  [/\bHonestly\b/g, 'Frankly'],
  [/\bhonestly\b/g, 'frankly'],
  [/\bSDK catalog honesty\b/g, 'SDK catalog completeness'],

  // K-Score axis label rename (prose only — leave JSON keys as schema names)
  [/Does the student refuse what it does not know, no hallucinations\?/g,
   'Does the student refuse what it does not know, no hallucinations?'],

  // Final catch-alls — capitalized standalone "Honest" / "Honesty" in prose
  [/\bHonesty\b/g, 'Caveats'],
  [/\bHonest\b/g, 'Plain'],

  // Lowercase standalone "honest" / "honesty" in prose — be conservative,
  // only replace when surrounded by word boundaries AND not preceded by " (
  // so JSON keys stay safe. Negative lookbehind isn't supported in older
  // engines — Node supports it, so use it.
  [/(?<!["'])\bhonest\b(?!["'])/g, 'plain'],
  [/(?<!["'])\bhonesty\b(?!["'])/g, 'truthfulness'],
];

let filesTouched = 0;
let totalReplacements = 0;

for (const file of walk(ROOT, [])) {
  let before = fs.readFileSync(file, 'utf8');
  if (!/honest|honesty|honestly/i.test(before)) continue;

  // Stash <code>...</code>, <pre>...</pre>, and JSON "honest": / "honesty":
  // patterns so we don't touch them.
  const stash = [];
  let after = before
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/g, (m) => {
      stash.push(m); return `CODE${stash.length - 1}`;
    })
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/g, (m) => {
      stash.push(m); return `PRE${stash.length - 1}`;
    })
    // JSON-style "honest": <number> and "honesty": <number>
    .replace(/"honest"\s*:\s*\d+/g, (m) => {
      stash.push(m); return `J${stash.length - 1}`;
    })
    .replace(/"honesty"\s*:\s*\d+/g, (m) => {
      stash.push(m); return `J${stash.length - 1}`;
    })
    // class= / id= / data-*= attribute payloads
    .replace(/(class|id|data-[\w-]+)="([^"]*)"/g, (m, attr, val) => {
      stash.push(m); return `A${stash.length - 1}`;
    })
    .replace(/(class|id|data-[\w-]+)='([^']*)'/g, (m, attr, val) => {
      stash.push(m); return `A${stash.length - 1}`;
    });

  let replacementsInFile = 0;
  for (const [re, sub] of SUBS) {
    after = after.replace(re, (m) => {
      replacementsInFile++; return sub;
    });
  }

  // Unstash
  // Unstash. Repeat until stable: a stashed <pre> can itself contain a
  // stashed <code> sentinel (nested), and a single pass would strand the
  // inner one. Bounded by stash depth so it always terminates.
  const SENTINEL = new RegExp(String.fromCharCode(1) + '(?:CODE|PRE|J|A)(\\d+)' + String.fromCharCode(1), 'g');
  for (let guard = 0; guard <= stash.length + 1; guard++) {
    const next = after.replace(SENTINEL, (_m, idx) => stash[parseInt(idx, 10)]);
    if (next === after) break;
    after = next;
  }

  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    filesTouched++;
    totalReplacements += replacementsInFile;
  }
}

process.stdout.write(
  `W903 honest-scrub: ${totalReplacements} replacements across ${filesTouched} files\n`
);
