#!/usr/bin/env node
// Surface orphan pages by adding them to the canonical footer across the site.
// Touches only files that contain the canonical '<div class="col-h">build</div>'
// footer fragment. Idempotent: re-running adds nothing.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || ".");
const PUB = path.join(ROOT, "public");

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith(".html")) out.push(p);
  }
  return out;
}

// Updates to make. Each is { match: literal substring, append: html to splice }
const PATCHES = [
  // build column: add /sdks /openai /agents
  {
    match: `<div class="col-h">build</div>
        <a href="/capture">capture</a>
        <a href="/compile">compile</a>
        <a href="/run">run</a>
        <a href="/recall">recall</a>
        <a href="/evolve">evolve</a>`,
    sentinel: `<a href="/sdks">sdks</a>`,
    append: `
        <a href="/sdks">sdks</a>
        <a href="/openai">openai compat</a>
        <a href="/agents">agents</a>`,
  },
  // proof column: add /showcase
  {
    match: `<div class="col-h">proof</div>
        <a href="/benchmarks">benchmarks</a>
        <a href="/research">research</a>
        <a href="/k-score">k-score</a>
        <a href="/leaderboard">registry</a>
        <a href="/spec">rs-1 spec</a>`,
    sentinel: `<a href="/showcase">showcase</a>`,
    append: `
        <a href="/showcase">showcase</a>`,
  },
  // industries column: add /compliance-packs
  {
    match: `<div class="col-h">industries</div>
        <a href="/healthcare">healthcare</a>
        <a href="/finance">finance</a>
        <a href="/legal">legal</a>
        <a href="/edge">edge</a>
        <a href="/cookbook">cookbook</a>`,
    sentinel: `<a href="/compliance-packs">compliance packs</a>`,
    append: `
        <a href="/compliance-packs">compliance packs</a>`,
  },
  // footer-tag bottom strip: add /press /glossary /troubleshooting /why-now
  {
    match: `<a href="/trust">trust</a> &middot; <a href="/security">security</a> &middot; <a href="/privacy">privacy</a> &middot; <a href="/terms">terms</a> &middot; <a href="/faq">faq</a>`,
    sentinel: `<a href="/press">press</a>`,
    replace: `<a href="/trust">trust</a> &middot; <a href="/security">security</a> &middot; <a href="/privacy">privacy</a> &middot; <a href="/terms">terms</a> &middot; <a href="/faq">faq</a> &middot; <a href="/glossary">glossary</a> &middot; <a href="/troubleshooting">troubleshooting</a> &middot; <a href="/why-now">why now</a> &middot; <a href="/press">press</a>`,
  },
];

const files = walk(PUB);
let touched = 0;
let untouched = 0;
const skipped = [];

for (const f of files) {
  let src = fs.readFileSync(f, "utf8");
  let changed = false;

  for (const p of PATCHES) {
    if (!src.includes(p.match)) continue;
    if (p.sentinel && src.includes(p.sentinel)) continue; // idempotent
    if (p.replace) {
      src = src.replace(p.match, p.replace);
    } else if (p.append) {
      src = src.replace(p.match, p.match + p.append);
    }
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(f, src);
    touched++;
  } else {
    untouched++;
  }
}

console.log(`Touched: ${touched}`);
console.log(`Untouched: ${untouched}`);
